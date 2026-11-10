import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { BleError } from "./ble-error.ts";

// Wire format from firmware-nrf52832/src/ota.rs and tools/ota/package.py.
export const OTA_CONTROL = "0f4a000a-9b5b-4f04-9c22-a38b0a6e6db7";
export const OTA_DATA = "0f4a000b-9b5b-4f04-9c22-a38b0a6e6db7";
export const OTA_STATUS = "0f4a000c-9b5b-4f04-9c22-a38b0a6e6db7";
export const OTA_PROFILE = "0f4a000d-9b5b-4f04-9c22-a38b0a6e6db7";
export const OTA_TARGET = "nRF52832-S112-7.3.0";
export const OTA_LAYOUT = 1;
const ACTIVE_START = 0x19000;
const ACTIVE_SIZE = 0x28000;
const CONTROL_LENGTH = 72;
export const OTA_MAX_FILE_BYTES = ACTIVE_SIZE * 2 + 4096;
export const OTA_MIN_BATTERY_MV = 3000;
// Web Bluetooth does not expose the negotiated MTU. Stay within the 72-byte
// envelope needed by the control write, including the four-byte chunk offset.
export const OTA_WEB_CHUNK_BYTES = CONTROL_LENGTH - 4;
// Public trust root; the test suite checks parity with the compiled firmware key.
export const OTA_PUBLIC_KEY_HEX = "98fe4bd9d199eafa43b8c86f3217ec8999a26fe9caa4429644f23e759bd38355";

export interface OtaPackage {
  readonly version: string;
  readonly image: Uint8Array;
  readonly digest: Uint8Array;
  readonly signature: Uint8Array;
}

function packageError(message: string): never {
  throw new BleError("invalid_package", message);
}

function hex(value: unknown, size: number, field: string): Uint8Array {
  if (typeof value !== "string" || value.length !== size * 2 || !/^[a-f0-9]+$/i.test(value)) {
    packageError(`固件包的${field}格式或长度无效。`);
  }
  return hexToBytes(value);
}

/** Verify the signed application before it can be selected for an upload. */
export function parseOtaPackage(text: string, trustedKeyHex = OTA_PUBLIC_KEY_HEX): OtaPackage {
  if (text.length > OTA_MAX_FILE_BYTES) packageError("固件包超过大小上限。");
  let decoded: unknown;
  try { decoded = JSON.parse(text); }
  catch { packageError("无法读取固件包，请选择 .atag-ota 文件。"); }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) packageError("固件包格式无效。");
  const { format, target, layout, version, length, image: encoded, sha256: checksum, signature, public_key: key } =
    decoded as Record<string, unknown>;
  if (format !== 1 || target !== OTA_TARGET || layout !== OTA_LAYOUT) packageError("固件包的设备型号或分区版本不兼容。");
  if (typeof version !== "string" || !/^\d\.\d\.\d$/.test(version)) packageError("固件包版本号无效。");
  if (typeof length !== "number" || !Number.isInteger(length) || length < 512 || length > ACTIVE_SIZE || length % 4) {
    packageError("应用镜像大小无效，必须对齐到 4 字节且不超过 160 KiB。");
  }
  const image = hex(encoded, length, "镜像");
  const vector = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const sp = vector.getUint32(0, true), pc = vector.getUint32(4, true);
  if (sp < 0x20004000 || sp > 0x20010000 || sp % 8 || !(pc & 1) || pc < ACTIVE_START || pc >= ACTIVE_START + length) {
    packageError("应用镜像的启动地址与 ATAG 不兼容。");
  }
  if (bytesToHex(hex(checksum, 32, "SHA-256")) !== bytesToHex(sha256(image))) packageError("固件包的 SHA-256 校验未通过。");
  const publicKey = hex(key, 32, "签名公钥");
  if (bytesToHex(publicKey) !== trustedKeyHex) packageError("此固件包不是用本网页信任的 ATAG 密钥签名的。");
  const signatureBytes = hex(signature, 64, "签名");
  const digest = sha512(image);
  if (!ed25519.verify(signatureBytes, digest, publicKey, { zip215: false })) packageError("固件包的 Ed25519 签名校验未通过。");
  return { version, image, digest, signature: signatureBytes };
}

const OTA_STATES = ["idle", "receiving", "ready"] as const;
export interface OtaStatus {
  state: (typeof OTA_STATES)[number];
  error: number;
  installed: boolean;
  digestReceived: boolean;
  received: number;
  total: number;
  capacity: number;
  chunkSize: number;
  layout: number;
}

export function parseOtaStatus(wire: DataView): OtaStatus {
  if (wire.byteLength !== 20 || wire.getUint8(0) !== 1 || wire.getUint8(1) >= OTA_STATES.length) {
    throw new BleError("incompatible", "Tag 的升级状态格式不兼容。");
  }
  const flags = wire.getUint8(3);
  return {
    state: OTA_STATES[wire.getUint8(1)], error: wire.getUint8(2), installed: (flags & 1) !== 0, digestReceived: (flags & 2) !== 0,
    received: wire.getUint32(4, true), total: wire.getUint32(8, true), capacity: wire.getUint32(12, true),
    chunkSize: wire.getUint16(16, true), layout: wire.getUint16(18, true),
  };
}

export interface OtaProfile { mode: number; rotation: number; fingerprint: string }

export function parseOtaProfile(wire: DataView): OtaProfile {
  if (wire.byteLength !== 40 || wire.getUint8(0) !== 1 || wire.getUint8(1) > 2) {
    throw new BleError("incompatible", "Tag 的配置快照格式不兼容。");
  }
  return {
    mode: wire.getUint8(1), rotation: wire.getUint32(4, true),
    fingerprint: bytesToHex(new Uint8Array(wire.buffer, wire.byteOffset + 8, 32)),
  };
}

export function otaControl(command: "digest" | "begin" | "finish", update: OtaPackage): Uint8Array {
  const wire = new Uint8Array(CONTROL_LENGTH);
  wire[0] = 1;
  wire[1] = { digest: 4, begin: 1, finish: 2 }[command];
  if (command === "digest") wire.set(update.digest, 4);
  if (command === "begin") {
    new DataView(wire.buffer).setUint32(4, update.image.length, true);
    wire.set(update.signature, 8);
  }
  return wire;
}

export function otaChunk(offset: number, bytes: Uint8Array): Uint8Array {
  const wire = new Uint8Array(4 + bytes.length);
  new DataView(wire.buffer).setUint32(0, offset, true);
  wire.set(bytes, 4);
  return wire;
}
