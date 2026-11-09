import type { TagSettings } from "../contracts";
import { crc32 } from "./protocol.ts";

export const SETTINGS_LENGTH = 64;
export const TX_POWER_VALUES: readonly number[] = [-40, -20, -16, -12, -8, -4, 0, 3, 4];
export const DEFAULT_SETTINGS: TagSettings = {
  led_enabled: false,
  advertising_interval_ms: 2000, gatt_interval_ms: 100, tx_power_dbm: 0,
  rotation_minutes: 15, gatt_advertising_seconds: 60, connection_seconds: 120,
  battery_idle_seconds: 900, battery_gatt_seconds: 5, reset_hold_seconds: 5,
  battery_low_mv: 2400, battery_recovery_mv: 2900, battery_calibration_ppm: 0,
};
export const SETTING_LIMITS: Record<Exclude<keyof TagSettings, "tx_power_dbm" | "led_enabled">, readonly [number, number]> = {
  advertising_interval_ms: [100, 10240], gatt_interval_ms: [20, 2000],
  rotation_minutes: [1, 0xffffffff], gatt_advertising_seconds: [10, 3600],
  connection_seconds: [10, 3600], battery_idle_seconds: [10, 86400],
  battery_gatt_seconds: [1, 600], reset_hold_seconds: [2, 30],
  battery_low_mv: [1800, 4200], battery_recovery_mv: [1800, 4200],
  battery_calibration_ppm: [-100000, 100000],
};

export function validateSettings(settings: TagSettings): string[] {
  const errors: string[] = [];
  if (!settings || typeof settings !== "object") return ["参数必须是完整的设置对象。"];
  const expected = Object.keys(DEFAULT_SETTINGS);
  if (Object.keys(settings).length !== expected.length || expected.some(key => !Object.hasOwn(settings, key))) {
    errors.push("参数字段不完整或含有未知字段，请先读取设备当前设置。");
  }
  if (!Number.isInteger(settings.tx_power_dbm) || !TX_POWER_VALUES.includes(settings.tx_power_dbm)) {
    errors.push("发射功率必须是设备支持的 dBm 档位。");
  }
  if (typeof settings.led_enabled !== "boolean") errors.push("LED 开关必须是布尔值。");
  for (const [key, [minimum, maximum]] of Object.entries(SETTING_LIMITS)) {
    const value = settings[key as keyof typeof SETTING_LIMITS];
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      errors.push(key + " 必须是 " + minimum + "～" + maximum + " 之间的整数。");
    }
  }
  if (settings.battery_low_mv >= settings.battery_recovery_mv) errors.push("低电压阈值必须小于恢复阈值。");
  return errors;
}

export function encodeSettings(settings: TagSettings): Uint8Array {
  const errors = validateSettings(settings);
  if (errors.length) throw new Error(errors.join(" "));
  const bytes = new Uint8Array(SETTINGS_LENGTH);
  const v = new DataView(bytes.buffer);
  v.setUint8(0, 1);
  v.setUint8(1, settings.led_enabled ? 1 : 0);
  v.setInt8(2, settings.tx_power_dbm);
  for (const [offset, key] of [[4, "advertising_interval_ms"], [8, "gatt_interval_ms"], [12, "rotation_minutes"], [20, "battery_idle_seconds"]] as const) {
    v.setUint32(offset, settings[key], true);
  }
  for (const [offset, key] of [[16, "gatt_advertising_seconds"], [18, "connection_seconds"], [24, "battery_gatt_seconds"], [26, "reset_hold_seconds"], [28, "battery_low_mv"], [30, "battery_recovery_mv"]] as const) {
    v.setUint16(offset, settings[key], true);
  }
  v.setInt32(32, settings.battery_calibration_ppm, true);
  v.setUint32(60, crc32(bytes.subarray(0, 60)), true);
  return bytes;
}

export function decodeSettings(input: Uint8Array | DataView): TagSettings {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length !== SETTINGS_LENGTH || bytes[0] !== 1 || (bytes[1] & ~1) || bytes[3] || bytes.subarray(36, 60).some(byte => byte !== 0)) {
    throw new Error("不兼容的设备设置，需要 64 字节 v1 设置包。");
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(60, true) !== crc32(bytes.subarray(0, 60))) throw new Error("设备设置 CRC32 校验失败。");
  const result: TagSettings = {
    led_enabled: !!(bytes[1] & 1),
    tx_power_dbm: v.getInt8(2),
    advertising_interval_ms: v.getUint32(4, true), gatt_interval_ms: v.getUint32(8, true),
    rotation_minutes: v.getUint32(12, true), gatt_advertising_seconds: v.getUint16(16, true),
    connection_seconds: v.getUint16(18, true), battery_idle_seconds: v.getUint32(20, true),
    battery_gatt_seconds: v.getUint16(24, true), reset_hold_seconds: v.getUint16(26, true),
    battery_low_mv: v.getUint16(28, true), battery_recovery_mv: v.getUint16(30, true),
    battery_calibration_ppm: v.getInt32(32, true),
  };
  const errors = validateSettings(result);
  if (errors.length) throw new Error(errors.join(" "));
  return result;
}

export function validateDeviceName(name: string): { valid: boolean; byteLength: number; error?: string } {
  const byteLength = new TextEncoder().encode(name).length;
  if (!byteLength || /^ +$/.test(name)) return { valid: false, byteLength, error: "名称不能为空或全部为空格。" };
  if (byteLength > 29) return { valid: false, byteLength, error: "名称最多 29 个 UTF-8 字节，中文通常占 3 字节。" };
  // Reject unpaired UTF-16 surrogates rather than silently encode replacement characters.
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = name.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return { valid: false, byteLength, error: "名称包含无效的 Unicode 字符。" };
    } else if (code >= 0xdc00 && code <= 0xdfff) return { valid: false, byteLength, error: "名称包含无效的 Unicode 字符。" };
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(name)) return { valid: false, byteLength, error: "名称不能包含控制字符。" };
  return { valid: true, byteLength };
}

export function encodeDeviceName(name: string): Uint8Array {
  const checked = validateDeviceName(name);
  if (!checked.valid) throw new Error(checked.error);
  return new TextEncoder().encode(name);
}
