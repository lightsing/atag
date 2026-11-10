import { sha256 } from '@noble/hashes/sha2.js';
import { BrowserAppleLogin } from '../auth/apple-login.ts';
import type { AppleTransport } from '../auth/types.ts';
import { fetchFindMyCiphertexts } from '../agent/bridge-client.ts';
import { ClientError } from '../client-support.ts';
import type { LocationReport } from '../contracts.ts';
import { openEncryptedBackup } from '../workspace/backup.ts';
import { base64, decryptReport, publicKey, reportKeys, unbase64, validatePrivate } from '../workspace/crypto.ts';
import type { KeyMaterial, QueryAccount, QuerySettings } from '../workspace/types.ts';

type StoredAccount = { account: QueryAccount; source: string };
type Keys = KeyMaterial | { kind: 'precomputed'; privateKeys: string[] };
type Tag = { id: string; name: string; keys: Keys; query?: QuerySettings };
type Reply<T> = { value: T; error?: never } | { error: { code: 'TIMEOUT' | 'UPSTREAM_UNAVAILABLE'; message: string }; value?: never };
const native = (globalThis as unknown as {webkit: { messageHandlers: { atag: { postMessage(value:string):Promise<string> } } }}).webkit.messageHandlers.atag;

async function host<T>(op: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new ClientError('CANCELLED');
  const reply: Reply<T> = JSON.parse(await native.postMessage(JSON.stringify({ op, payload })));
  if (signal?.aborted) throw new ClientError('CANCELLED');
  if (reply.error) throw new ClientError(reply.error.code, reply.error.message);
  return reply.value;
}

const transport: AppleTransport = {
  getAnisette: (source, _uid, _deviceId, _profile, signal) => host('anisette', { source }, signal),
  forwardApple: (request, signal) => host('apple', request, signal),
};
const login = new BrowserAppleLogin(() => transport, async (account, source, signal) => {
  await host('saveAccount', { account, source }, signal);
});

function cliTags(value: unknown): Tag[] {
  if (!Array.isArray(value) || !value.length || value.length > 1000) throw new Error('设备文件须包含 1–1000 个 ATAG 档案。');
  const ids = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || typeof raw.privateKey !== 'string') throw new Error('设备文件缺少标签私钥。');
    const additional = raw.additionalKeys ?? [];
    if (!Array.isArray(additional) || additional.length > 4095) throw new Error('设备文件包含无效的轮换窗口。');
    const keys = [raw.privateKey, ...additional];
    for (const key of keys) {
      if (typeof key !== 'string' || key.length !== 40) throw new Error('设备文件包含无效的私钥。');
      validatePrivate(key);
    }
    const suffix = raw.id === undefined ? base64(sha256(publicKey(validatePrivate(raw.privateKey)))).replace(/[+/=]/g, c => ({'+':'-','/':'_','=':''})[c]!) : String(raw.id);
    if (!/^[a-zA-Z0-9_.-]{1,120}$/.test(suffix)) throw new Error('设备文件包含无效的标签 ID。');
    const id = 'cli_' + suffix;
    if (ids.has(id)) throw new Error('设备文件包含重复的标签 ID。');
    ids.add(id);
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (name.length > 320 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('设备文件包含无效的标签名称。');
    return { id, name: name || `ATAG ${index + 1}`, keys: { kind: 'precomputed', privateKeys: [...new Set<string>(keys)] } };
  });
}

async function importTags(input: { text: string; password?: string }): Promise<Tag[]> {
  let parsed: unknown;
  try { parsed = JSON.parse(input.text); } catch { throw new Error('文件不是有效的 JSON。'); }
  if (parsed && typeof parsed === 'object' && 'format' in parsed && parsed.format === 'atag-encrypted-backup') {
    if (!input.password) throw new ClientError('AUTH_REQUIRED', '请输入备份密码。');
    const { data } = await openEncryptedBackup(input.text, input.password);
    if (!data.records.length) throw new Error('备份中没有 ATAG 档案。');
    return data.records.map(({ device, keys, query }) => ({ id: device.id, name: device.name, keys, query }));
  }
  return cliTags(parsed);
}

async function latest({ tag, saved }: { tag: Tag; saved: StoredAccount }): Promise<LocationReport | null> {
  const keys = tag.keys.kind === 'precomputed'
    ? new Map(tag.keys.privateKeys.map(value => { const key = validatePrivate(value); return [base64(sha256(publicKey(key).slice(1, 29))), { privateKey: key }] as const; }))
    : await reportKeys(tag.keys, tag.query ?? {rotationStart: 1, rotationCount: 512});
  const ids = [...keys.keys()], now = Date.now(), to = new Date(now).toISOString(), from = new Date(now - 7 * 86400000).toISOString();
  // Compare the machine's identity with the one that received this token.
  const boundTransport: AppleTransport = {
    ...transport,
    async getAnisette(source, uid, deviceId, profile, signal) {
      const result = await transport.getAnisette(source, uid, deviceId, profile, signal);
      if (result.headers['X-Mme-Device-Id']?.toLowerCase() !== deviceId.toLowerCase() || result.headers['X-Apple-I-MD-LU'] !== uid)
        throw new ClientError('AUTH_EXPIRED', '机器认证身份已变化，请重新登录 Apple 账号。');
      return result;
    },
  };
  let result: LocationReport | null = null;
  for (let offset = 0; offset < ids.length; offset += 256) {
    const batch = await fetchFindMyCiphertexts(boundTransport, saved.account, saved.source, ids.slice(offset, offset + 256), from, to);
    for (const item of batch) {
      let report: LocationReport;
      try { report = await decryptReport(tag.id, keys.get(item.id)!.privateKey, unbase64(item.payload)); }
      catch { throw new ClientError('UPSTREAM_UNAVAILABLE', '报告无法通过解密验证，请确认设备档案与标签一致。'); }
      if (report.observedAt >= from && report.observedAt <= to && (!result || result.observedAt < report.observedAt)) result = report;
    }
  }
  return result;
}

async function run(command: string, input: string): Promise<string> {
  try {
    const value = JSON.parse(input);
    let result: unknown;
    switch (command) {
      case 'ready': result = isSecureContext && !!crypto.subtle; break;
      case 'login': await login.start({ ...value, clientProfile: 'macos' }); result = login.snapshot(); break;
      case 'sendCode': await login.requestCode(value); result = login.snapshot(); break;
      case 'submitCode': await login.submitCode(value); result = login.snapshot(); break;
      case 'loginState': result = login.snapshot(); break;
      case 'cancelLogin': login.cancel(); result = true; break;
      case 'import': result = await importTags(value); break;
      case 'latest': result = await latest(value); break;
      default: throw new ClientError('INVALID_REQUEST');
    }
    return JSON.stringify({ value: result });
  } catch (error) {
    const message = error instanceof ClientError || command === 'import' && error instanceof Error
      ? error.message.slice(0, 500) : '无法处理此请求。';
    return JSON.stringify({ error: { code: error instanceof ClientError ? error.code : 'INTERNAL_ERROR', message } });
  }
}

Object.assign(globalThis, { atag: Object.freeze({ run }) });
