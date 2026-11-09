import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, decodeAdvertisementVoltage, parseProvisioningStatus, parseTelemetry } from "../lib/ble/protocol.ts";
import { DEFAULT_SETTINGS, decodeSettings, encodeDeviceName, encodeSettings, validateDeviceName, validateSettings } from "../lib/ble/settings-protocol.ts";

// Produced independently by tools/gatt/settings_codec.py, not the JS encoder.
const DEFAULT_VECTOR = "01000000d0070000640000000f0000003c00780084030000050005006009540b0000000000000000000000000000000000000000000000000000000082bc2d92";
const CUSTOM_VECTOR = "0100d800d007000064000000ffffffff3c000a0084030000050005006009540bc7cfffff000000000000000000000000000000000000000000000000fdafef02";
const TELEMETRY_VECTOR = "0102031ef00fe40c40e201007856341284030000040000000102030405060708000076006009540b";
const bytes = hex => Uint8Array.from(Buffer.from(hex, "hex"));
const seal = value => { new DataView(value.buffer).setUint32(60, crc32(value.subarray(0, 60)), true); return value; };

test("settings match independent Python codec vectors, signed power and ppm included", () => {
  assert.equal(Buffer.from(encodeSettings(DEFAULT_SETTINGS)).toString("hex"), DEFAULT_VECTOR);
  assert.deepEqual(decodeSettings(bytes(DEFAULT_VECTOR)), DEFAULT_SETTINGS);
  const custom = { ...DEFAULT_SETTINGS, tx_power_dbm: -40, rotation_minutes: 0xffffffff, battery_calibration_ppm: -12345, connection_seconds: 10 };
  assert.equal(Buffer.from(encodeSettings(custom)).toString("hex"), CUSTOM_VECTOR);
  assert.deepEqual(decodeSettings(bytes(CUSTOM_VECTOR)), custom);
});

test("settings validate integer ranges, exact fields and low/recovery hysteresis", () => {
  for (const patch of [
    { connection_seconds: 9 }, { tx_power_dbm: 2 }, { rotation_minutes: 0 },
    { battery_calibration_ppm: 100001 }, { battery_low_mv: 2900 },
    { advertising_interval_ms: 100.5 }, { battery_gatt_seconds: NaN },
  ]) assert.throws(() => encodeSettings({ ...DEFAULT_SETTINGS, ...patch }));
  assert.ok(validateSettings({ ...DEFAULT_SETTINGS, typo: 1 }).length);
  assert.throws(() => encodeSettings({ connection_seconds: 120 }));
});

test("settings reject bad CRC/version/reserved bits and preserve the LED setting", () => {
  const corrupted = bytes(DEFAULT_VECTOR); corrupted[8] ^= 1;
  assert.throws(() => decodeSettings(corrupted), /CRC/);
  for (const [offset, value] of [[0, 2], [1, 2], [3, 1], [36, 1]]) {
    const invalid = bytes(DEFAULT_VECTOR); invalid[offset] = value;
    assert.throws(() => decodeSettings(seal(invalid)));
  }
  const enabled = bytes(DEFAULT_VECTOR); enabled[1] = 1;
  assert.deepEqual(decodeSettings(seal(enabled)), { ...DEFAULT_SETTINGS, led_enabled: true });
  const enabledVector = "01010000d0070000640000000f0000003c00780084030000050005006009540b0000000000000000000000000000000000000000000000000000000073b961fb";
  assert.equal(Buffer.from(encodeSettings({ ...DEFAULT_SETTINGS, led_enabled: true })).toString("hex"), enabledVector);
  assert.throws(() => encodeSettings({ ...DEFAULT_SETTINGS, led_enabled: 1 }));
  assert.throws(() => decodeSettings(bytes(DEFAULT_VECTOR).subarray(0, 63)));
});

test("device names enforce UTF-8 byte limits, not character count", () => {
  assert.equal(validateDeviceName("我的标签").byteLength, 12);
  assert.equal(validateDeviceName("中".repeat(9) + "ab").valid, true);
  assert.equal(validateDeviceName("中".repeat(10)).valid, false);
  assert.equal(encodeDeviceName("😀".repeat(7) + "a").length, 29);
  for (const invalid of ["", "   ", "tag\n", "tag\u0085", "\ud800", "\udc00", "a".repeat(30)]) {
    assert.equal(validateDeviceName(invalid).valid, false);
    assert.throws(() => encodeDeviceName(invalid));
  }
});

test("all operation statuses distinguish matching durable commits and reject malformed frames", () => {
  for (let code = 0; code <= 6; code++) {
    const status = parseProvisioningStatus(Uint8Array.of(1, code, 0, 2, code <= 2 ? 104 : 0, 0, 0, 0));
    assert.equal(status.resultCode, code);
    assert.equal(status.operation, code === 0 ? "idle" : code <= 2 ? "keys" : code <= 4 ? "name" : "settings");
    assert.equal(status.commitConfirmed, code > 0 && code % 2 === 1);
  }
  assert.equal(parseProvisioningStatus(Uint8Array.of(1, 3, 0, 2, 104, 0, 0, 0)), null);
  for (const code of [7, 8, 9]) {
    const led = parseProvisioningStatus(Uint8Array.of(1, code, code === 9 ? 1 : 0, 2, 0, 0, 0, 0));
    assert.equal(led.operation, "led");
    assert.equal(led.state, code === 9 ? "rejected" : "accepted");
    assert.equal(led.commitConfirmed, false);
  }
});

test("telemetry v1 matches Python layout including serial byte order, flags and countdown", () => {
  const payload = bytes(TELEMETRY_VECTOR);
  const t = parseTelemetry(new DataView(payload.buffer, payload.byteOffset, payload.length));
  assert.equal(t.version, 1);
  assert.equal(t.keyMode, "rotating"); assert.equal(t.phase, "connected");
  assert.equal(t.batteryMillivolts, 4080); assert.equal(t.supplyMillivolts, 3300);
  assert.equal(t.uptimeSeconds, 123456); assert.equal(t.rotation, 0x12345678);
  assert.equal(t.rotationIntervalSeconds, 900); assert.equal(t.resetReason, 4);
  assert.equal(t.chipSerial, "0102030405060708"); assert.equal(t.connectionSecondsLeft, 118);
  assert.equal(t.batteryLowMillivolts, 2400); assert.equal(t.batteryRecoveryMillivolts, 2900);
  assert.deepEqual(t.flags, { buttonHeld: false, lowVoltage: true, encrypted: true, resetPin: true, externalClock: true, dcdc: false, hasLed: false, ledEnabled: false });
  payload[3] |= 0xc0;
  assert.equal(parseTelemetry(payload).flags.hasLed, true);
  assert.equal(parseTelemetry(payload).flags.ledEnabled, true);
  assert.throws(() => parseTelemetry(payload.subarray(0, 39)));
  payload[0] = 2; assert.throws(() => parseTelemetry(payload));
});

test("battery voltage preserves the split six-bit layout", () => {
  assert.equal(decodeAdvertisementVoltage(0), 4200);
  assert.equal(decodeAdvertisementVoltage(0xcf), 2400);
  assert.equal(decodeAdvertisementVoltage(1), 4171);
  assert.equal(decodeAdvertisementVoltage(0x30), 4200);
  for (const invalid of [-1, 256, 1.5, undefined, NaN]) {
    assert.throws(() => decodeAdvertisementVoltage(invalid));
  }
});
