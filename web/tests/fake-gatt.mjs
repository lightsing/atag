import {
  SETUP_SERVICE_UUID as SERVICE, CONFIG_CHARACTERISTIC_UUID as CONFIG, STATUS_CHARACTERISTIC_UUID as STATUS,
  TELEMETRY_CHARACTERISTIC_UUID as INFO, BATTERY_CHARACTERISTIC_UUID as BATTERY,
  CONTROL_CHARACTERISTIC_UUID as CONTROL, NAME_CHARACTERISTIC_UUID as NAME,
  SETTINGS_CHARACTERISTIC_UUID as SETTINGS, BUTTON_CHARACTERISTIC_UUID as BUTTON,
  PAIRING_CHARACTERISTIC_UUID as PAIRING, DEVICE_INFORMATION_SERVICE_UUID as DIS, DEVICE_INFORMATION_UUIDS,
} from "../lib/ble/protocol.ts";
import { DEFAULT_SETTINGS, encodeSettings } from "../lib/ble/settings-protocol.ts";

export const UUID = { SERVICE, CONFIG, STATUS, INFO, BATTERY, CONTROL, NAME, SETTINGS, BUTTON, PAIRING, DIS };
const u16 = n => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; };
const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
export const frame = (code, mode = 0, error = [2, 4, 6, 9].includes(code) ? 1 : 0) => Uint8Array.of(1, code, error, mode, code <= 2 ? 104 : 0, 0, 0, 0);
export const waitUntil = async condition => {
  const end = Date.now() + 500;
  while (!condition()) {
    if (Date.now() > end) throw new Error("Fake-GATT condition did not become true");
    await new Promise(resolve => setTimeout(resolve, 1));
  }
};

/** No BLE hardware or browser APIs. Tests invoke a deterministic in-memory ATT peer. */
export function fakeGatt(options = {}) {
  const reads = [], writes = [], requests = [];
  const chars = new Map();
  let encrypted = false;
  let onWrite = options.onWrite ?? (() => {});
  const protectedUuids = new Set([CONFIG, INFO, CONTROL, NAME, SETTINGS]);
  class Characteristic extends EventTarget {
    constructor(uuid, bytes) { super(); this.uuid = uuid; this.set(bytes); }
    set(bytes) { this.value = new DataView(new Uint8Array(bytes).buffer); }
    notify(bytes) { this.set(bytes); this.dispatchEvent(new Event("characteristicvaluechanged")); }
    async readValue() {
      reads.push(this.uuid);
      if (!gatt.connected) throw new DOMException("Disconnected", "NetworkError");
      if (protectedUuids.has(this.uuid) && !encrypted) throw new Error("Protected read before encryption");
      return this.value;
    }
    async startNotifications() {
      if (protectedUuids.has(this.uuid) && !encrypted) throw new Error("Protected subscription before encryption");
      this.notifying = true;
      // Explicit baseline replay, including a cached status from an earlier write.
      this.dispatchEvent(new Event("characteristicvaluechanged"));
      return this;
    }
    async stopNotifications() { this.notifying = false; return this; }
    async writeValueWithResponse(source) {
      const bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
      if (!gatt.connected) throw new DOMException("Disconnected", "NetworkError");
      if (protectedUuids.has(this.uuid) && !encrypted) throw new Error("Protected write before encryption");
      writes.push({ uuid: this.uuid, bytes });
      if (this.uuid === PAIRING) {
        this.notify(Uint8Array.of(1));
        if (options.autoPair !== false) queueMicrotask(() => pairReady());
      }
      await onWrite(this.uuid, bytes, api);
    }
  }
  const add = (uuid, bytes) => chars.set(uuid, new Characteristic(uuid, bytes));
  add(CONFIG, new Uint8Array(104));
  add(STATUS, options.initialStatus ?? frame(0));
  add(INFO, Uint8Array.from(Buffer.from("0102031ef00fe40c40e201007856341284030000040000000102030405060708000076006009540b", "hex")));
  add(BATTERY, u16(4080)); add(CONTROL, Uint8Array.of(0));
  add(NAME, new TextEncoder().encode("我的标签"));
  add(SETTINGS, encodeSettings(DEFAULT_SETTINGS));
  add(BUTTON, u32(7)); add(PAIRING, Uint8Array.of(0));
  for (const [key, uuid] of Object.entries(DEVICE_INFORMATION_UUIDS)) {
    add(uuid, new TextEncoder().encode({ manufacturer: "ATAG", model: "nRF52832", firmwareVersion: "0.1.0", serial: "0102030405060708" }[key]));
  }
  const device = new EventTarget();
  device.id = "opaque-browser-device-id"; device.name = "ATAG-8BC12EF0";
  const gatt = {
    connected: false,
    async connect() {
      if (options.connectDelay) await options.connectDelay;
      this.connected = true; return this;
    },
    disconnect() { this.connected = false; encrypted = false; device.dispatchEvent(new Event("gattserverdisconnected")); },
    async getPrimaryService(uuid) {
      if (uuid !== SERVICE && uuid !== DIS) throw new Error("Unknown service");
      return { getCharacteristic: async key => {
        if (key === DEVICE_INFORMATION_UUIDS.serial) throw new DOMException("Browser GATT blocklist", "SecurityError");
        if (!chars.has(key)) throw new Error("Missing characteristic");
        return chars.get(key);
      } };
    },
  };
  device.gatt = gatt;
  const pairReady = () => { encrypted = true; chars.get(PAIRING).notify(Uint8Array.of(2)); };
  const api = {
    reads, writes, requests, chars, device, gatt, pairReady,
    notify: (uuid, bytes) => chars.get(uuid).notify(bytes),
    setWriteHandler: fn => { onWrite = fn; },
    bluetooth: { requestDevice: async request => { requests.push(request); return device; } },
  };
  return api;
}
