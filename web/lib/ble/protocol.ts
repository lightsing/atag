/**
 * ATAG setup GATT protocol, mirrored from `atag/src/provisioning.rs` and the
 * nRF52832 firmware. Pure functions only: safe to run in tests and never logs
 * payload bytes (they contain the rolling seed for rotating configs).
 *
 * Keep this module free of runtime imports so `node --test` can load it
 * directly with type stripping.
 */
import type { AdvertisingMode, BleTelemetry, ProvisioningStatus } from "../contracts";

export const SETUP_SERVICE_UUID = "0f4a0000-9b5b-4f04-9c22-a38b0a6e6db7";
export const CONFIG_CHARACTERISTIC_UUID = "0f4a0001-9b5b-4f04-9c22-a38b0a6e6db7";
export const STATUS_CHARACTERISTIC_UUID = "0f4a0002-9b5b-4f04-9c22-a38b0a6e6db7";
export const TELEMETRY_CHARACTERISTIC_UUID = "0f4a0003-9b5b-4f04-9c22-a38b0a6e6db7";
export const BATTERY_CHARACTERISTIC_UUID = "0f4a0004-9b5b-4f04-9c22-a38b0a6e6db7";
export const CONTROL_CHARACTERISTIC_UUID = "0f4a0005-9b5b-4f04-9c22-a38b0a6e6db7";
export const NAME_CHARACTERISTIC_UUID = "0f4a0006-9b5b-4f04-9c22-a38b0a6e6db7";
export const SETTINGS_CHARACTERISTIC_UUID = "0f4a0007-9b5b-4f04-9c22-a38b0a6e6db7";
export const BUTTON_CHARACTERISTIC_UUID = "0f4a0008-9b5b-4f04-9c22-a38b0a6e6db7";
export const PAIRING_CHARACTERISTIC_UUID = "0f4a0009-9b5b-4f04-9c22-a38b0a6e6db7";
export const DEVICE_INFORMATION_SERVICE_UUID = "0000180a-0000-1000-8000-00805f9b34fb";
export const DEVICE_INFORMATION_UUIDS = {
  manufacturer: "00002a29-0000-1000-8000-00805f9b34fb",
  model: "00002a24-0000-1000-8000-00805f9b34fb",
  firmwareVersion: "00002a26-0000-1000-8000-00805f9b34fb",
  serial: "00002a25-0000-1000-8000-00805f9b34fb",
} as const;

export const CONFIG_LENGTH = 104;
export const STATUS_LENGTH = 8;
const MAGIC = [0x41, 0x54, 0x41, 0x47]; // "ATAG"
const CONFIG_VERSION = 1;
const MODE_OFFSET = 5;
const INTERVAL_OFFSET = 6;
const PAYLOAD_OFFSET = 10;
const CRC_OFFSET = 100;
const FIXED_KEY_LENGTH = 28;
const MASTER_PUBLIC_KEY_LENGTH = 57;

let crcTable: Uint32Array | null = null;

/** IEEE 802.3 CRC32 (reflected, poly 0xEDB88320), same as firmware `crc32`. */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export type ConfigPackageErrorCode =
  | "length"
  | "magic"
  | "version"
  | "mode"
  | "checksum"
  | "reserved"
  | "interval"
  | "public_key";

export interface ConfigPackageSummary {
  mode: AdvertisingMode;
  rotationIntervalMinutes: number | null;
  /** CRC32 of bytes[0..100]; firmware uses the same value as a non-secret provisioning id. */
  provisioningId: string;
  byteLength: number;
}

export type ConfigPackageResult =
  | { ok: true; summary: ConfigPackageSummary }
  | { ok: false; code: ConfigPackageErrorCode; message: string };

function fail(code: ConfigPackageErrorCode, message: string): ConfigPackageResult {
  return { ok: false, code, message };
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function allZero(bytes: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (bytes[i] !== 0) return false;
  return true;
}

/**
 * Structural validation before any BLE write. The firmware additionally
 * checks that keys are valid P-224 points; that cannot be proven here.
 */
export function parseConfigPackage(bytes: Uint8Array): ConfigPackageResult {
  if (bytes.length !== CONFIG_LENGTH) {
    return fail("length", `配置包必须恰好 ${CONFIG_LENGTH} 字节，当前为 ${bytes.length} 字节。`);
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) return fail("magic", "文件头不是 ATAG，不是有效的 ATAG 配置包。");
  }
  if (bytes[4] !== CONFIG_VERSION) {
    return fail("version", `不支持的配置包版本 ${bytes[4]}，当前固件只接受版本 1。`);
  }
  const expectedCrc = readU32LE(bytes, CRC_OFFSET);
  const actualCrc = crc32(bytes.subarray(0, CRC_OFFSET));
  if (expectedCrc !== actualCrc) {
    return fail("checksum", "CRC32 校验失败，文件可能已损坏或被截断。");
  }

  const modeByte = bytes[MODE_OFFSET];
  const provisioningId = actualCrc.toString(16).padStart(8, "0");
  if (modeByte === 1) {
    if (!allZero(bytes, INTERVAL_OFFSET, PAYLOAD_OFFSET) || !allZero(bytes, PAYLOAD_OFFSET + FIXED_KEY_LENGTH, CRC_OFFSET)) {
      return fail("reserved", "固定模式配置包的保留字节必须为 0。");
    }
    return {
      ok: true,
      summary: { mode: "fixed", rotationIntervalMinutes: null, provisioningId, byteLength: bytes.length },
    };
  }
  if (modeByte === 2) {
    if (bytes[CRC_OFFSET - 1] !== 0) {
      return fail("reserved", "轮换模式配置包末尾保留字节必须为 0。");
    }
    const interval = readU32LE(bytes, INTERVAL_OFFSET);
    if (interval === 0) return fail("interval", "轮换周期不能为 0。");
    if (bytes[PAYLOAD_OFFSET] !== 0x04) {
      return fail("public_key", "主公钥不是未压缩的 SEC1 P-224 点（应以 0x04 开头）。");
    }
    return {
      ok: true,
      summary: { mode: "rotating", rotationIntervalMinutes: interval, provisioningId, byteLength: bytes.length },
    };
  }
  return fail("mode", `未知广播模式 ${modeByte}，仅支持 1（固定）和 2（轮换）。`);
}

/** Parse the 8-byte status characteristic. Returns null when malformed. */
export function parseProvisioningStatus(view: DataView | Uint8Array): ProvisioningStatus | null {
  const bytes =
    view instanceof Uint8Array ? view : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  if (bytes.length !== STATUS_LENGTH || bytes[0] !== CONFIG_VERSION) return null;
  const stateByte = bytes[1];
  if (stateByte > 9 || bytes[3] > 2 || bytes.subarray(5).some(byte => byte !== 0)) return null;
  if ((stateByte <= 2 && bytes[4] !== CONFIG_LENGTH) || (stateByte >= 3 && bytes[4] !== 0)) return null;
  // LED stop (8) succeeds too. Result codes are an enum, never parity flags.
  const state = stateByte === 0 ? "setup" : [1, 3, 5, 7, 8].includes(stateByte) ? "accepted" : "rejected";
  const mode = bytes[3] === 1 ? "fixed" : bytes[3] === 2 ? "rotating" : null;
  return {
    protocolVersion: bytes[0],
    state,
    errorCode: bytes[2],
    mode,
    expectedLength: bytes[4],
    resultCode: stateByte,
    operation: stateByte >= 7 ? "led" : stateByte === 0 ? "idle" : stateByte <= 2 ? "keys" : stateByte <= 4 ? "name" : "settings",
    commitConfirmed: [1, 3, 5].includes(stateByte),
  };
}

/** Version-one, 40-byte telemetry. Uses byte order identical to the firmware. */
export function parseTelemetry(input: DataView | Uint8Array): BleTelemetry {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length !== 40 || bytes[0] !== 1 || bytes[1] > 2 || bytes[2] > 3) {
    throw new Error("设备遥测格式不兼容，需要 40 字节 v1 数据。");
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = bytes[3];
  return {
    version: 1,
    keyMode: bytes[1] === 0 ? "unset" : bytes[1] === 1 ? "fixed" : "rotating",
    phase: (["idle", "broadcasting", "advertising", "connected"] as const)[bytes[2]],
    batteryMillivolts: v.getUint16(4, true), supplyMillivolts: v.getUint16(6, true),
    uptimeSeconds: v.getUint32(8, true), rotation: v.getUint32(12, true),
    rotationIntervalSeconds: v.getUint32(16, true), resetReason: v.getUint32(20, true),
    chipSerial: Array.from(bytes.subarray(24, 32), b => b.toString(16).padStart(2, "0")).join(""),
    advertisingSecondsLeft: v.getUint16(32, true), connectionSecondsLeft: v.getUint16(34, true),
    batteryLowMillivolts: v.getUint16(36, true), batteryRecoveryMillivolts: v.getUint16(38, true),
    flags: { buttonHeld: !!(flags & 1), lowVoltage: !!(flags & 2), encrypted: !!(flags & 4), resetPin: !!(flags & 8), externalClock: !!(flags & 16), dcdc: !!(flags & 32), hasLed: !!(flags & 64), ledEnabled: !!(flags & 128) },
  };
}

/** Decode the current 2.4–4.2 V battery status, ignoring device-type bits. */
export function decodeAdvertisementVoltage(status: number): number {
  if (!Number.isInteger(status) || status < 0 || status > 255) throw new Error("无效的广播状态字节。");
  const code = ((status >>> 2) & 0x30) | (status & 0x0f);
  return 4200 - Math.round(code * 1800 / 63);
}

/** Firmware `provisioning_error_code` mapping (firmware-nrf52832/src/main.rs). */
export function describeRejection(errorCode: number): string {
  switch (errorCode) {
    case 1: return "文件头不是 ATAG";
    case 2: return "配置包版本不受支持";
    case 3: return "广播模式不受支持";
    case 4: return "CRC32 校验失败";
    case 5: return "固定密钥不是有效的 P-224 点";
    case 6: return "轮换主公钥无效";
    case 7: return "轮换周期为 0";
    case 8: return "保留字节不为 0";
    default: return `未知错误码 ${errorCode}`;
  }
}

/** Decode local `configurationBase64` into bytes without echoing it anywhere. */
export function decodeBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
