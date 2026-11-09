// Run: node --test tests/  (Node >= 22.18 strips TypeScript types natively)
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONFIG_LENGTH,
  crc32,
  parseConfigPackage,
  parseProvisioningStatus,
} from "../lib/ble/protocol.ts";

// P-224 generator, same vector as atag/src/provisioning.rs tests.
const GENERATOR = Uint8Array.from([
  0x04, 0xb7, 0x0e, 0x0c, 0xbd, 0x6b, 0xb4, 0xbf, 0x7f, 0x32, 0x13, 0x90, 0xb9, 0x4a, 0x03,
  0xc1, 0xd3, 0x56, 0xc2, 0x11, 0x22, 0x34, 0x32, 0x80, 0xd6, 0x11, 0x5c, 0x1d, 0x21, 0xbd,
  0x37, 0x63, 0x88, 0xb5, 0xf7, 0x23, 0xfb, 0x4c, 0x22, 0xdf, 0xe6, 0xcd, 0x43, 0x75, 0xa0,
  0x5a, 0x07, 0x47, 0x64, 0x44, 0xd5, 0x81, 0x99, 0x85, 0x00, 0x7e, 0x34,
]);

/** Independent re-implementation of ProvisioningConfig::encode. */
function encode({ mode, interval = 0, payload }) {
  const wire = new Uint8Array(CONFIG_LENGTH);
  wire.set([0x41, 0x54, 0x41, 0x47], 0);
  wire[4] = 1;
  wire[5] = mode;
  new DataView(wire.buffer).setUint32(6, interval, true);
  wire.set(payload, 10);
  return seal(wire);
}

function seal(wire) {
  new DataView(wire.buffer).setUint32(100, crc32(wire.subarray(0, 100)), true);
  return wire;
}

const fixed = () => encode({ mode: 1, payload: GENERATOR.subarray(1, 29) });
const rotating = () =>
  encode({ mode: 2, interval: 15, payload: Uint8Array.from([...GENERATOR, ...new Array(32).fill(0x42)]) });

test("crc32 matches the IEEE check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("accepts firmware-shaped fixed and rotating packages", () => {
  const f = parseConfigPackage(fixed());
  assert.equal(f.ok, true);
  assert.equal(f.summary.mode, "fixed");
  assert.equal(f.summary.rotationIntervalMinutes, null);

  const r = parseConfigPackage(rotating());
  assert.equal(r.ok, true);
  assert.equal(r.summary.mode, "rotating");
  assert.equal(r.summary.rotationIntervalMinutes, 15);
  assert.match(r.summary.provisioningId, /^[0-9a-f]{8}$/);
});

test("rejects wrong length, magic, version, mode and checksum", () => {
  assert.equal(parseConfigPackage(new Uint8Array(103)).code, "length");
  assert.equal(parseConfigPackage(new Uint8Array(105)).code, "length");

  const badMagic = fixed();
  badMagic[0] = 0x42;
  assert.equal(parseConfigPackage(seal(badMagic)).code, "magic");

  const badVersion = fixed();
  badVersion[4] = 2;
  assert.equal(parseConfigPackage(seal(badVersion)).code, "version");

  const badMode = fixed();
  badMode[5] = 3;
  assert.equal(parseConfigPackage(seal(badMode)).code, "mode");

  const corrupted = rotating();
  corrupted[25] ^= 1; // same corruption as the firmware test
  assert.equal(parseConfigPackage(corrupted).code, "checksum");
});

test("enforces reserved bytes and rotation interval", () => {
  const fixedWithInterval = fixed();
  fixedWithInterval[6] = 1;
  assert.equal(parseConfigPackage(seal(fixedWithInterval)).code, "reserved");

  const fixedTrailing = fixed();
  fixedTrailing[99] = 1;
  assert.equal(parseConfigPackage(seal(fixedTrailing)).code, "reserved");

  const rotatingTrailing = rotating();
  rotatingTrailing[99] = 1;
  assert.equal(parseConfigPackage(seal(rotatingTrailing)).code, "reserved");

  const zeroInterval = rotating();
  zeroInterval.fill(0, 6, 10);
  assert.equal(parseConfigPackage(seal(zeroInterval)).code, "interval");
});

test("rejects truncated or incompatible provisioning status frames", () => {
  assert.equal(parseProvisioningStatus(Uint8Array.from([1, 1, 0, 2, 104])), null);
  assert.equal(parseProvisioningStatus(Uint8Array.from([2, 1, 0, 2, 104, 0, 0, 0])), null);
  assert.equal(parseProvisioningStatus(Uint8Array.from([1, 1, 0, 2, 20, 0, 0, 0])), null);
});

test("parses firmware status bytes", () => {
  assert.deepEqual(parseProvisioningStatus(Uint8Array.from([1, 0, 0, 0, 104, 0, 0, 0])), {
    protocolVersion: 1, state: "setup", errorCode: 0, mode: null, expectedLength: 104,
    resultCode: 0, operation: "idle", commitConfirmed: false,
  });
  assert.equal(parseProvisioningStatus(Uint8Array.from([1, 1, 0, 2, 104, 0, 0, 0])).mode, "rotating");
  const rejected = parseProvisioningStatus(new DataView(Uint8Array.from([1, 2, 4, 0, 104, 0, 0, 0]).buffer));
  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.errorCode, 4);
  assert.equal(parseProvisioningStatus(Uint8Array.from([1, 9, 0, 0, 104])), null);
  assert.equal(parseProvisioningStatus(Uint8Array.from([1, 1])), null);
});
