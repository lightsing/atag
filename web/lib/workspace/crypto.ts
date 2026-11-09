import { weierstrass } from '@noble/curves/abstract/weierstrass.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { crc32, decodeAdvertisementVoltage } from '../ble/protocol.ts';
import type { AdvertisingMode, LocationReport } from '../contracts';
import type { KeyMaterial, QuerySettings } from './types.ts';

// SEC2 / NIST P-224 domain parameters. Group operations use noble's validated engine.
export const P224_ORDER = 0xffffffffffffffffffffffffffff16a2e0b8f03e13dd29455c5c2a3dn;
const p = 0xffffffffffffffffffffffffffffffff000000000000000000000001n;
export const P224 = weierstrass({ p, a: p - 3n,
  b: 0xb4050a850c04b3abf54132565044b0b7d7bfd8ba270b39432355ffb4n,
  n: P224_ORDER, h: 1n,
  Gx: 0xb70e0cbd6bb4bf7f321390b94a03c1d356c21122343280d6115c1d21n,
  Gy: 0xbd376388b5f723fb4c22dfe6cd4375a05a07476444d5819985007e34n,
});
export const bytesToBig = (bytes: Uint8Array) => BigInt('0x' + Array.from(bytes, n => n.toString(16).padStart(2, '0')).join(''));
export function bigToBytes(value: bigint, length = 28): Uint8Array {
  const hex = value.toString(16).padStart(length * 2, '0');
  return Uint8Array.from(hex.match(/../g)!, n => parseInt(n, 16));
}
export function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result;
}
export function base64(bytes: Uint8Array): string {
  let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text);
}
export function unbase64(value: string, length?: number): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Base64 格式无效。');
  const result = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  if (length !== undefined && result.length !== length) throw new Error('密钥或数据长度无效。');
  return result;
}
export function validatePrivate(value: string): Uint8Array {
  const bytes = unbase64(value, 28); const scalar = bytesToBig(bytes);
  if (scalar < 1n || scalar >= P224_ORDER) throw new Error('P-224 私钥无效。'); return bytes;
}
export const publicKey = (secret: Uint8Array) => P224.BASE.multiply(bytesToBig(secret)).toBytes(false);
export function generateMaterial(mode: AdvertisingMode): KeyMaterial {
  let privateKey: Uint8Array;
  do { privateKey = crypto.getRandomValues(new Uint8Array(28)); } while (bytesToBig(privateKey) === 0n || bytesToBig(privateKey) >= P224_ORDER);
  return mode === 'fixed'
    ? { kind: 'fixed', privateKey: base64(privateKey) }
    : { kind: 'rotating', masterPrivateKey: base64(privateKey), symmetricSeed: base64(crypto.getRandomValues(new Uint8Array(32))) };
}
export function makeConfiguration(keys: KeyMaterial, interval: number | null): Uint8Array {
  const bytes = new Uint8Array(104); bytes.set([65, 84, 65, 71, 1, keys.kind === 'fixed' ? 1 : 2]);
  const view = new DataView(bytes.buffer);
  if (keys.kind === 'fixed') bytes.set(publicKey(validatePrivate(keys.privateKey)).slice(1, 29), 10);
  else {
    if (!Number.isInteger(interval) || interval! < 1 || interval! > 0xffffffff) throw new Error('轮换周期无效。');
    view.setUint32(6, interval!, true); bytes.set(publicKey(validatePrivate(keys.masterPrivateKey)), 10);
    bytes.set(unbase64(keys.symmetricSeed, 32), 67);
  }
  view.setUint32(100, crc32(bytes.slice(0, 100)), true); return bytes;
}
const info = (value: string) => new TextEncoder().encode(value);
function kdf(input: Uint8Array, counter: number, shared: string) {
  const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, counter); return sha256(concat(input, bytes, info(shared)));
}
export function nextRollingKey(master: Uint8Array, seed: Uint8Array): { seed: Uint8Array; privateKey: Uint8Array } {
  const next = kdf(seed, 1, 'update');
  const divers = concat(kdf(next, 1, 'diversify'), kdf(next, 2, 'diversify'), kdf(next, 3, 'diversify')).slice(0, 72);
  const scalar = (part: Uint8Array) => bytesToBig(part) % (P224_ORDER - 1n) + 1n;
  const value = (bytesToBig(master) * scalar(divers.slice(0, 36)) + scalar(divers.slice(36))) % P224_ORDER;
  if (value === 0n) throw new Error('轮换密钥无效。');
  return { seed: next, privateKey: bigToBytes(value) };
}
function checkAbort(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('已取消', 'AbortError'); }
export async function reportKeys(keys: KeyMaterial, query: QuerySettings, signal?: AbortSignal): Promise<Map<string, Uint8Array>> {
  checkAbort(signal); const result = new Map<string, Uint8Array>();
  const add = (key: Uint8Array) => result.set(base64(sha256(publicKey(key).slice(1, 29))), key);
  if (keys.kind === 'fixed') add(validatePrivate(keys.privateKey));
  else {
    const master = validatePrivate(keys.masterPrivateKey); let seed = unbase64(keys.symmetricSeed, 32);
    const end = query.rotationStart + query.rotationCount;
    for (let round = 1; round < end; round++) {
      if (round < query.rotationStart) seed = kdf(seed, 1, 'update');
      else { const next = nextRollingKey(master, seed); seed = next.seed; add(next.privateKey); }
      if (round % (round < query.rotationStart ? 2048 : 16) === 0) { await new Promise(resolve => setTimeout(resolve, 0)); checkAbort(signal); }
    }
  }
  checkAbort(signal); return result;
}
export async function decryptReport(deviceId: string, privateKey: Uint8Array, payload: Uint8Array): Promise<LocationReport> {
  if (payload.length !== 88 && payload.length !== 89) throw new Error('报告长度无效。');
  const encrypted = payload.slice(payload.length === 89 ? 5 : 4);
  const ephemeral = encrypted.slice(1, 58);
  const point = P224.fromBytes(ephemeral); point.assertValidity();
  const shared = point.multiply(bytesToBig(privateKey)).toBytes(false).slice(1, 29);
  const symmetric = sha256(concat(shared, Uint8Array.of(0, 0, 0, 1), ephemeral));
  const key = await crypto.subtle.importKey('raw', symmetric.slice(0, 16), 'AES-GCM', false, ['decrypt']);
  const clear = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: symmetric.slice(16), tagLength: 128 }, key, encrypted.slice(58)));
  if (clear.length !== 10) throw new Error('报告内容无效。');
  const view = new DataView(clear.buffer); const latitude = view.getInt32(0) / 1e7; const longitude = view.getInt32(4) / 1e7;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new Error('报告坐标无效。');
  const batteryMillivolts = decodeAdvertisementVoltage(clear[9]);
  const hash = sha256(concat(info(deviceId), payload));
  return { id: 'report_' + Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join(''), deviceId,
    observedAt: new Date((new DataView(payload.buffer, payload.byteOffset).getUint32(0) + 978307200) * 1000).toISOString(),
    latitude, longitude, horizontalAccuracyMeters: clear[8], batteryMillivolts, source: 'findmy' };
}
