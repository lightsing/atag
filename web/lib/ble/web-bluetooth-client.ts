import type {
  BleAvailability, BleClient, BleIdentity, BleTelemetry, DeviceCapabilities,
  ProvisioningStatus, TagSettings, BleSessionSnapshot,
} from "../contracts";
import { BleError } from "./ble-error.ts";
import {
  SETUP_SERVICE_UUID, CONFIG_CHARACTERISTIC_UUID as CONFIG, STATUS_CHARACTERISTIC_UUID as STATUS,
  TELEMETRY_CHARACTERISTIC_UUID as INFO, BATTERY_CHARACTERISTIC_UUID as BATTERY,
  CONTROL_CHARACTERISTIC_UUID as CONTROL, NAME_CHARACTERISTIC_UUID as NAME,
  SETTINGS_CHARACTERISTIC_UUID as SETTINGS, BUTTON_CHARACTERISTIC_UUID as BUTTON,
  PAIRING_CHARACTERISTIC_UUID as PAIRING, DEVICE_INFORMATION_SERVICE_UUID as DIS,
  DEVICE_INFORMATION_UUIDS, parseConfigPackage, parseProvisioningStatus, parseTelemetry,
} from "./protocol.ts";
import { decodeSettings, encodeDeviceName, encodeSettings } from "./settings-protocol.ts";
import {
  OTA_CONTROL, OTA_DATA, OTA_LAYOUT, OTA_MIN_BATTERY_MV, OTA_PROFILE, OTA_STATUS, parseOtaProfile, parseOtaStatus,
  type OtaPackage, type OtaStatus,
} from "./ota-protocol.ts";
import { compareOtaBoot, transferOta, type OtaProgress, type OtaReceipt, type OtaVerification } from "./ota-transfer.ts";
import { BleSessionState, emptyBleSession, TAG_CAPABILITIES } from "./session-state.ts";
import { getNavigatorBluetooth, type BtBluetooth, type BtCharacteristic, type BtDevice, type BtGattServer } from "./web-bluetooth-types.ts";

export interface WebBluetoothClientOptions {
  /** Injectable transport/timeouts for fake-GATT tests; no hardware is used by tests. */
  bluetooth?: BtBluetooth;
  secureContext?: boolean;
  connectTimeoutMs?: number;
  operationTimeoutMs?: number;
  pairingTimeoutMs?: number;
  pollMs?: number;
}
type PendingReceipt = {
  operation: ProvisioningStatus["operation"];
  onStatus(status: ProvisioningStatus): void;
};

export class WebBluetoothClient extends BleSessionState implements BleClient {
  private device: BtDevice | null = null;
  private server: BtGattServer | null = null;
  private chars = new Map<string, BtCharacteristic>();
  private notificationCleanup = new Map<string, () => void>();
  private cancelWaiters = new Set<() => void>();
  private pendingReceipt: PendingReceipt | null = null;
  private otaStatusListener: ((status: OtaStatus) => void) | null = null;
  private epoch = 0;
  private ioBusy = false;
  private readonly options: WebBluetoothClientOptions;
  constructor(options: WebBluetoothClientOptions = {}) { super(); this.options = options; }

  getAvailability(): BleAvailability {
    const secureContext = this.options.secureContext ?? (typeof window !== "undefined" && window.isSecureContext);
    const bluetooth = this.options.bluetooth ?? getNavigatorBluetooth();
    if (!secureContext) return { supported: false, secureContext, reason: "需要 HTTPS 或 localhost 安全上下文。" };
    if (!bluetooth) return { supported: false, secureContext, reason: "当前浏览器不支持 Web Bluetooth。请使用支持它的桌面 Chrome / Edge 或 Android Chrome。" };
    return { supported: true, secureContext };
  }

  requestDevice(): Promise<{ id: string; name: string }> {
    const bluetooth = this.options.bluetooth ?? getNavigatorBluetooth();
    if (!bluetooth) return Promise.reject(new BleError("unsupported", "当前浏览器不支持 Web Bluetooth。"));
    if (this.state !== "disconnected" || this.ioBusy) return Promise.reject(new BleError("busy", "请先断开当前设备。"));
    const epoch = ++this.epoch;
    // Do not await anything before the native picker: preserve user activation.
    let request: Promise<BtDevice>;
    try {
      request = bluetooth.requestDevice({
        filters: [{ services: [SETUP_SERVICE_UUID] }],
        optionalServices: [SETUP_SERVICE_UUID, DIS],
      });
    } catch (error) { return Promise.reject(this.mapError(error)); }
    this.update({ state: "selecting" });
    return request.then(device => {
      if (epoch !== this.epoch) throw new BleError("cancelled", "已取消选择设备。");
      this.releaseDevice();
      this.device = device;
      device.addEventListener("gattserverdisconnected", this.onDisconnected);
      const info = { id: device.id, name: device.name || "ATAG" };
      this.session = emptyBleSession();
      this.update({ state: "disconnected", device: info });
      return info;
    }, error => {
      if (epoch === this.epoch) this.update({ state: "disconnected" });
      throw this.mapError(error);
    });
  }

  async connect(): Promise<ProvisioningStatus> {
    const gatt = this.device?.gatt;
    if (!gatt) throw new BleError("no_device", "请先选择附近的 Tag。短按 P0.13 可开启连接窗口。");
    if (this.state !== "disconnected" || this.ioBusy) throw new BleError("busy", "连接操作正在进行。");
    const epoch = ++this.epoch;
    this.ioBusy = true;
    this.update({ state: "connecting", encryption: "unknown", deviceName: null, telemetry: null, settings: null, telemetryReceivedAt: null, otaStatus: null });
    try {
      const connecting = gatt.connect().then(server => {
        if (epoch !== this.epoch) {
          server.disconnect();
          throw new BleError("cancelled", "连接操作已取消。");
        }
        return server;
      });
      this.server = await this.bounded(connecting, this.options.connectTimeoutMs ?? 15000);
      this.assertEpoch(epoch);
      const connectedAt = new Date().toISOString();
      this.update({ connectedAt, estimatedConnectionDeadline: new Date(Date.parse(connectedAt) + 120000).toISOString() });
      const vendor = await this.bounded(this.server.getPrimaryService(SETUP_SERVICE_UUID));
      for (const uuid of [CONFIG, STATUS, INFO, BATTERY, CONTROL, NAME, SETTINGS, BUTTON, PAIRING]) {
        this.chars.set(uuid, await this.bounded(vendor.getCharacteristic(uuid)));
      }
      const identityService = await this.bounded(this.server.getPrimaryService(DIS));
      for (const [field, uuid] of Object.entries(DEVICE_INFORMATION_UUIDS)) {
        // Web Bluetooth's GATT blocklist forbids 2a25, including discovery.
        if (field === "serial") continue;
        this.chars.set(uuid, await this.bounded(identityService.getCharacteristic(uuid)));
      }
      this.assertEpoch(epoch);
      const status = parseProvisioningStatus(await this.read(STATUS));
      if (!status) throw new BleError("incompatible", "设备状态格式不兼容，需要 v0.1.0 GATT 协议。");
      const identity = await this.readIdentityInternal();
      const batteryMillivolts = await this.readUnsigned(BATTERY, 2);
      // Baseline is captured BEFORE subscribing; the initial replay is not a press.
      const buttonCounter = await this.readUnsigned(BUTTON, 4);
      const encryptionValue = await this.readUnsigned(PAIRING, 1);
      this.update({ identity, batteryMillivolts, buttonCounter, lastButtonPressAt: null, encryption: encryptionValue === 2 ? "encrypted" : "unencrypted" });
      await this.watch(STATUS, value => {
        const parsed = parseProvisioningStatus(value);
        if (parsed) this.pendingReceipt?.onStatus(parsed);
      });
      await this.watch(BATTERY, value => {
        if (value.byteLength === 2) this.update({ batteryMillivolts: value.getUint16(0, true) });
      });
      await this.watch(BUTTON, value => {
        if (value.byteLength !== 4) return;
        const count = value.getUint32(0, true);
        const changed = this.session.buttonCounter !== null && this.session.buttonCounter !== count;
        this.update({ buttonCounter: count, ...(changed ? { lastButtonPressAt: new Date().toISOString() } : {}) });
      });
      await this.watch(PAIRING, value => {
        if (value.byteLength !== 1) return;
        const encryption = value.getUint8(0) === 2 ? "encrypted" : this.session.encryption === "pairing" ? "pairing" : "unencrypted";
        this.update({ encryption });
      });
      // OTA is optional for older Tags; missing characteristics never block management.
      const otaUuids = [OTA_STATUS, OTA_CONTROL, OTA_DATA, OTA_PROFILE];
      try {
        for (const uuid of otaUuids) this.chars.set(uuid, await this.bounded(vendor.getCharacteristic(uuid)));
        this.update({ otaStatus: parseOtaStatus(await this.read(OTA_STATUS)) });
      } catch {
        otaUuids.forEach(uuid => this.chars.delete(uuid));
      }
      this.assertEpoch(epoch);
      this.update({ state: "connected" });
      return status;
    } catch (error) {
      if (epoch === this.epoch) this.disconnect();
      throw this.mapError(error);
    } finally { this.ioBusy = false; }
  }

  disconnect(): void {
    ++this.epoch;
    try { this.device?.gatt?.disconnect(); } catch { /* already gone */ }
    this.clearConnection();
  }
  dispose(): void { this.disconnect(); this.releaseDevice(); this.clearListeners(); }
  getCapabilities(): DeviceCapabilities {
    const available = this.chars.has(PAIRING) && this.chars.has(SETTINGS);
    const ota = this.session.otaStatus;
    return { ...TAG_CAPABILITIES, provisioning: available, management: available, telemetry: available, ota: !!ota?.installed && ota.layout === OTA_LAYOUT };
  }
  readIdentity(): Promise<BleIdentity> { return this.exclusive(null, () => this.readIdentityInternal()); }
  readBattery(): Promise<number> {
    return this.exclusive(null, async () => {
      const batteryMillivolts = await this.readUnsigned(BATTERY, 2);
      this.update({ batteryMillivolts });
      return batteryMillivolts;
    });
  }
  ensureEncrypted(): Promise<void> { return this.exclusive("pairing", () => this.ensureEncryptionInternal()); }
  readTelemetry(): Promise<BleTelemetry> {
    return this.exclusive(null, async () => {
      await this.ensureEncryptionInternal();
      const telemetry = parseTelemetry(await this.read(INFO));
      this.applyTelemetry(telemetry);
      return telemetry;
    });
  }
  readName(): Promise<string> {
    return this.exclusive(null, async () => {
      await this.ensureEncryptionInternal();
      const value = await this.read(NAME);
      const name = new TextDecoder("utf-8", { fatal: true }).decode(value);
      this.update({ deviceName: name, device: this.session.device ? { ...this.session.device, name } : null });
      return name;
    });
  }
  readSettings(): Promise<TagSettings> {
    return this.exclusive(null, async () => {
      await this.ensureEncryptionInternal();
      const settings = decodeSettings(await this.read(SETTINGS));
      this.update({ settings });
      this.updateDeadline(settings.connection_seconds);
      return settings;
    });
  }
  writeName(name: string): Promise<ProvisioningStatus> {
    let bytes: Uint8Array;
    try { bytes = encodeDeviceName(name); } catch (error) { return Promise.reject(new BleError("invalid_name", (error as Error).message)); }
    return this.exclusive("rename", async () => {
      await this.ensureEncryptionInternal();
      const status = await this.writeCommitted(NAME, bytes, "name");
      if (status.state === "accepted") this.update({ deviceName: name, device: this.session.device ? { ...this.session.device, name } : null });
      return status;
    });
  }
  writeSettings(settings: TagSettings): Promise<ProvisioningStatus> {
    let bytes: Uint8Array;
    try { bytes = encodeSettings(settings); } catch (error) { return Promise.reject(new BleError("invalid_settings", (error as Error).message)); }
    const saved = structuredClone(settings);
    return this.exclusive("settings", async () => {
      await this.ensureEncryptionInternal();
      const status = await this.writeCommitted(SETTINGS, bytes, "settings");
      if (status.state === "accepted") {
        this.update({ settings: saved });
        this.updateDeadline(saved.connection_seconds);
      }
      return status;
    });
  }
  applyConfiguration(bytes: Uint8Array): Promise<ProvisioningStatus> {
    const checked = parseConfigPackage(bytes);
    if (!checked.ok) return Promise.reject(new BleError("invalid_package", checked.message));
    // Own a transient copy; callers cannot mutate a queued write.
    const payload = new Uint8Array(bytes);
    return this.exclusive("configure", async () => {
      await this.ensureEncryptionInternal();
      return this.writeCommitted(CONFIG, payload, "keys");
    });
  }
  uploadFirmware(update: OtaPackage, onProgress: (progress: OtaProgress) => void, signal?: AbortSignal): Promise<OtaReceipt> {
    return this.exclusive("ota", async () => {
      const deviceId = this.device?.id;
      const previousVersion = this.session.identity?.firmwareVersion;
      if (!deviceId || !previousVersion || !this.getCapabilities().ota) {
        throw new BleError("incompatible", "此 Tag 不支持当前的网页固件升级协议。");
      }
      const connectionId = this.epoch;
      const batteryMillivolts = await this.readUnsigned(BATTERY, 2);
      this.update({ batteryMillivolts });
      if (batteryMillivolts < OTA_MIN_BATTERY_MV) throw new BleError("write_failed", "Tag 电池电压低于 3.0 V，无法升级。");
      const before = parseOtaProfile(await this.read(OTA_PROFILE));
      const scheduled = await transferOta({
        connected: () => this.epoch === connectionId && !!this.server?.connected,
        disconnect: () => this.disconnect(),
        readStatus: async () => parseOtaStatus(await this.read(OTA_STATUS)),
        subscribeStatus: async (listener) => {
          await this.watch(OTA_STATUS, value => {
            try { this.otaStatusListener?.(parseOtaStatus(value)); } catch { /* ignore malformed notifications */ }
          });
          this.otaStatusListener = listener;
          return () => { this.otaStatusListener = null; };
        },
        write: async (kind, bytes) => {
          try { await this.write(kind === "control" ? OTA_CONTROL : OTA_DATA, bytes); }
          catch (error) {
            if (error instanceof DOMException && error.name === "InvalidModificationError") {
              throw new BleError("write_failed", "蓝牙连接无法写入升级指令。请重新连接，或换用支持较大蓝牙包的浏览器或设备。");
            }
            throw error;
          }
        },
      }, update, onProgress, signal);
      return { deviceId, connectionId, previousVersion, expectedVersion: update.version, before, scheduled };
    });
  }
  verifyFirmware(receipt: OtaReceipt): Promise<OtaVerification> {
    return this.exclusive(null, async () => {
      if (this.device?.id !== receipt.deviceId || this.epoch === receipt.connectionId) {
        throw new BleError("not_connected", "请等待设备重启，并重新连接刚才升级的同一只 Tag。");
      }
      const after = parseOtaProfile(await this.read(OTA_PROFILE));
      const version = this.session.identity?.firmwareVersion;
      if (!version) throw new BleError("incompatible", "无法读取重启后的固件版本。");
      return compareOtaBoot(receipt, version, after);
    });
  }
  reboot(): Promise<void> { return this.control(1); }
  factoryReset(): Promise<void> { return this.control(2); }
  identifyLed(active: boolean): Promise<ProvisioningStatus> {
    return this.exclusive("led", async () => {
      if (this.session.encryption !== "encrypted") throw new BleError("pairing_failed", "请先完成配对加密，再操作 LED。");
      if (!this.session.telemetry) throw new BleError("incompatible", "LED 硬件能力未知，请先读取遥测。");
      if (!this.session.telemetry.flags.hasLed) throw new BleError("unsupported", "此设备未配备 LED，可通过按键通知辨别设备。");
      if (active && !this.session.settings?.led_enabled) throw new BleError("invalid_settings", "请先保存启用 LED 的设置。");
      // Never initiate pairing as a side effect of a find/stop command.
      if (await this.readUnsigned(PAIRING, 1) !== 2) {
        this.update({ encryption: "unencrypted" });
        throw new BleError("pairing_failed", "连接尚未加密，请先完成配对。");
      }
      return this.writeAcknowledged(CONTROL, Uint8Array.of(active ? 3 : 4), "led", active ? 7 : 8);
    });
  }

  private control(command: 1 | 2): Promise<void> {
    return this.exclusive(command === 1 ? "reboot" : "factory_reset", async () => {
      await this.ensureEncryptionInternal();
      await this.write(CONTROL, Uint8Array.of(command));
      // No durable control ack exists. The UI must wait for disconnect/reconnect.
    });
  }
  private async ensureEncryptionInternal(): Promise<void> {
    if (await this.readUnsigned(PAIRING, 1) !== 2) {
      this.update({ state: "pairing", encryption: "pairing" });
      try {
        await this.write(PAIRING, Uint8Array.of(1));
        const end = Math.min(Date.now() + (this.options.pairingTimeoutMs ?? 90000), Date.parse(this.session.estimatedConnectionDeadline ?? "") || Infinity);
        while (true) {
          if (this.session.encryption === "encrypted" || await this.readUnsigned(PAIRING, 1) === 2) break;
          if (Date.now() >= end) throw new BleError("pairing_failed", "配对未在连接期限内完成。请确认系统配对提示，短按 Tag 后重新连接。");
          await this.bounded(new Promise<void>(resolve => setTimeout(resolve, this.options.pollMs ?? 250)), 1000);
        }
      } catch (error) {
        if (this.server?.connected) this.update({ encryption: "unencrypted" });
        throw error;
      }
    }
    this.update({ encryption: "encrypted", state: this.session.busyOperation && this.session.busyOperation !== "pairing" ? "writing" : "connected" });
    await this.watch(INFO, value => { try { this.applyTelemetry(parseTelemetry(value)); } catch { /* invalid notifications never replace good telemetry */ } });
  }
  private applyTelemetry(telemetry: BleTelemetry): void {
    const now = new Date().toISOString();
    const connected = !!this.server?.connected;
    this.update({ telemetry, telemetryReceivedAt: now, batteryMillivolts: telemetry.batteryMillivolts,
      identity: this.session.identity ? { ...this.session.identity, serial: telemetry.chipSerial } : null,
      encryption: connected && telemetry.flags.encrypted ? "encrypted" : "unencrypted",
      estimatedConnectionDeadline: connected ? new Date(Date.parse(now) + telemetry.connectionSecondsLeft * 1000).toISOString() : null });
  }
  private updateDeadline(seconds: number): void {
    if (this.server?.connected && this.session.connectedAt) this.update({ estimatedConnectionDeadline: new Date(Date.parse(this.session.connectedAt) + seconds * 1000).toISOString() });
  }
  private async readIdentityInternal(): Promise<BleIdentity> {
    const result = { serial: this.session.telemetry?.chipSerial ?? this.session.identity?.serial ?? null } as BleIdentity;
    for (const [field, uuid] of Object.entries(DEVICE_INFORMATION_UUIDS)) {
      if (field === "serial") continue;
      result[field as keyof BleIdentity] = new TextDecoder("utf-8", { fatal: true }).decode(await this.read(uuid)).replace(/\0+$/u, "");
    }
    this.update({ identity: result });
    return result;
  }
  private async exclusive<T>(kind: BleSessionSnapshot["busyOperation"], task: () => Promise<T>): Promise<T> {
    if (this.ioBusy) throw new BleError("busy", "正在处理另一项蓝牙操作，请稍候。");
    this.assertConnected();
    this.ioBusy = true;
    this.update({ busyOperation: kind, state: kind === "pairing" ? "pairing" : kind ? "writing" : "connected" });
    try { return await task(); }
    catch (error) { throw this.mapError(error); }
    finally {
      this.ioBusy = false;
      this.update({ busyOperation: null, state: this.server?.connected ? "connected" : "disconnected" });
    }
  }
  private writeCommitted(uuid: string, bytes: Uint8Array, operation: "keys" | "name" | "settings"): Promise<ProvisioningStatus> {
    return this.writeAcknowledged(uuid, bytes, operation, { keys: 1, name: 3, settings: 5 }[operation]);
  }
  private writeAcknowledged(uuid: string, bytes: Uint8Array, operation: PendingReceipt["operation"], acceptedCode: number): Promise<ProvisioningStatus> {
    this.assertConnected();
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (status?: ProvisioningStatus, error?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.cancelWaiters.delete(onDisconnect);
        this.pendingReceipt = null;
        if (status) resolve(status); else reject(error);
      };
      const action = operation === "led" ? "LED 指令" : "保存";
      const onDisconnect = () => finish(undefined, new BleError("disconnected", `未收到本次${action}回执，结果未知。请重新连接核验。`));
      const timer = setTimeout(() => finish(undefined, new BleError("timeout", `等待${action}回执超时，结果未知。请重新连接核验。`)), this.options.operationTimeoutMs ?? 15000);
      this.cancelWaiters.add(onDisconnect);
      this.pendingReceipt = {
        operation,
        onStatus: status => {
          if (status.operation !== operation) return;
          if (status.state === "rejected" || (status.resultCode === acceptedCode && (operation === "led" || status.commitConfirmed))) finish(status);
        },
      };
      // Only a fresh matching notification can complete this write. Reading the
      // cached status is unsafe: repeated operations can have identical status bytes.
      void this.write(uuid, bytes).catch(error => {
        // Firmware may notify its result just before the host notices loss.
        setTimeout(() => finish(undefined, error), 350);
      });
    });
  }
  private async watch(uuid: string, listener: (value: DataView) => void): Promise<void> {
    if (this.notificationCleanup.has(uuid)) return;
    const characteristic = this.characteristic(uuid);
    const handler = () => { if (characteristic.value) listener(characteristic.value); };
    characteristic.addEventListener("characteristicvaluechanged", handler);
    this.notificationCleanup.set(uuid, () => characteristic.removeEventListener("characteristicvaluechanged", handler));
    try { await this.bounded(characteristic.startNotifications()); }
    catch (error) {
      this.notificationCleanup.get(uuid)?.();
      this.notificationCleanup.delete(uuid);
      throw error;
    }
  }
  private characteristic(uuid: string): BtCharacteristic {
    this.assertConnected();
    const value = this.chars.get(uuid);
    if (!value) throw new BleError("incompatible", "设备缺少 v0.1.0 所需的蓝牙特征。");
    return value;
  }
  private read(uuid: string): Promise<DataView> { return this.bounded(this.characteristic(uuid).readValue()); }
  private async readUnsigned(uuid: string, length: 1 | 2 | 4): Promise<number> {
    const view = await this.read(uuid);
    if (view.byteLength !== length) throw new BleError("gatt", "设备返回的字段长度无效。");
    return length === 1 ? view.getUint8(0) : length === 2 ? view.getUint16(0, true) : view.getUint32(0, true);
  }
  private async write(uuid: string, bytes: Uint8Array): Promise<void> {
    const characteristic = this.characteristic(uuid);
    if (!characteristic.writeValueWithResponse) throw new BleError("unsupported", "浏览器不支持带响应写入。");
    await this.bounded(characteristic.writeValueWithResponse(bytes as unknown as BufferSource));
  }
  private assertConnected(): void {
    if (!this.server?.connected) throw new BleError("not_connected", "Tag 已断开。短按 P0.13 开启连接窗口后重新连接。");
  }
  private assertEpoch(epoch: number): void {
    if (epoch !== this.epoch) throw new BleError("cancelled", "连接操作已取消。");
    this.assertConnected();
  }
  private bounded<T>(work: Promise<T>, timeout = this.options.operationTimeoutMs ?? 8000): Promise<T> {
    return new Promise((resolve, reject) => {
      const end = (error?: unknown, value?: T) => {
        clearTimeout(timer);
        this.cancelWaiters.delete(cancel);
        if (error) reject(error); else resolve(value as T);
      };
      const cancel = () => end(new BleError("disconnected", "蓝牙连接已断开。短按后可重新连接。"));
      const timer = setTimeout(() => end(new BleError("timeout", "蓝牙操作超时，请重新连接后重试。")), timeout);
      this.cancelWaiters.add(cancel);
      work.then(value => end(undefined, value), error => end(error));
    });
  }
  private readonly onDisconnected = () => { ++this.epoch; this.clearConnection(); };
  private clearConnection(): void {
    this.notificationCleanup.forEach(cleanup => cleanup());
    this.notificationCleanup.clear();
    this.server = null;
    this.chars.clear();
    this.otaStatusListener = null;
    [...this.cancelWaiters].forEach(cancel => cancel());
    this.cancelWaiters.clear();
    this.update({ state: "disconnected", encryption: "unencrypted", busyOperation: null, estimatedConnectionDeadline: null, otaStatus: null });
  }
  private releaseDevice(): void {
    this.device?.removeEventListener("gattserverdisconnected", this.onDisconnected);
    this.device = null;
  }
  private mapError(error: unknown): BleError {
    if (error instanceof BleError) return error;
    const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
    if (name === "AbortError") return new BleError("cancelled", "已取消蓝牙操作。");
    if (name === "NotFoundError") return new BleError("cancelled", "未选择设备或找不到服务。短按 Tag 打开 60 秒连接窗口后重试。");
    if (name === "SecurityError" || name === "NotAllowedError") return new BleError("unsupported", "蓝牙或配对权限被拒绝，请检查浏览器与系统权限。");
    if (name === "NetworkError") return new BleError("disconnected", "连接已断开或加密未完成。短按 Tag 后重新连接。");
    if (name === "InvalidModificationError") return new BleError("write_failed", "写入长度或 MTU 不足。配置需要至少 107 字节 ATT MTU，当前协议不支持手动分片。");
    return new BleError("gatt", "蓝牙操作失败，请重新连接后重试。");
  }
}
