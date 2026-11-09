import { z } from 'zod';
import { base64, unbase64, validatePrivate } from './crypto.ts';
import type { BackupSummary, WorkspaceData, WorkspaceRecord } from './types.ts';

export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const time = z.string().datetime({ offset: true }).transform(s => new Date(s).toISOString());
const finite = z.number().finite();
const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.-]+$/);
const name = z.string().min(1).max(320).refine(s => [...s].length <= 80 && !/[\x00-\x1f\x7f-\x9f]/.test(s));
const report = z.object({
  id: identifier, deviceId: identifier, observedAt: time,
  latitude: finite.min(-90).max(90), longitude: finite.min(-180).max(180),
  horizontalAccuracyMeters: finite.min(0).max(1e7),
  batteryMillivolts: finite.min(2400).max(4200), source: z.literal('findmy'),
});
const device = z.object({
  id: identifier, name, icon: z.enum(['keys','backpack','luggage','bike','tag']), color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  advertisingMode: z.enum(['fixed','rotating']), rotationIntervalMinutes: z.number().int().min(1).max(0xffffffff).nullable(),
  firmwareVersion: z.string().max(80).nullable(), chipSerial: z.string().regex(/^[a-fA-F0-9]{16}$/).nullable().optional(),
  provisioningState:z.enum(['draft','confirmed']).optional(),
  capabilities: z.object({provisioning:z.boolean(),management:z.boolean(),telemetry:z.boolean(),ring:z.boolean(),ota:z.boolean()}),
  latestReport: report.nullable(), createdAt: time,
});
const keys = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('fixed'),privateKey:z.string().length(40)}).strict(),
  z.object({kind:z.literal('rotating'),masterPrivateKey:z.string().length(40),symmetricSeed:z.string().length(44)}).strict(),
]);
const record = z.object({device, keys,
  query:z.object({rotationStart:z.number().int().min(1).max(10_000_000),rotationCount:z.number().int().min(1).max(4096)}).strict(),
  reports:z.array(report).max(20000),provisioning:z.enum(['draft','confirmed']),
}).strict();
export const accountSchema = z.object({dsid:z.string().min(1).max(256),searchPartyToken:z.string().min(1).max(8192),uid:z.string().min(1).max(256),deviceId:z.string().min(1).max(256),accountLabel:z.string().max(200).nullable()}).strict();
const dataSchema = z.object({version:z.literal(1),records:z.array(record).max(1000),account:accountSchema.nullable(),accountExpired:z.boolean().optional(),anisetteUrl:z.string().max(2048)}).strict();
export function validateWorkspace(input: unknown): WorkspaceData {
  let data: WorkspaceData;
  try { data = dataSchema.parse(input); } catch { throw new Error('文件数据结构或版本无效，未导入。'); }
  const ids = new Set<string>(); const serials = new Set<string>();
  for (const entry of data.records) {
    if (ids.has(entry.device.id)) throw new Error('文件包含重复设备。'); ids.add(entry.device.id);
    const serial = entry.device.chipSerial?.toLowerCase();
    if (serial && serials.has(serial)) throw new Error('文件包含冲突的芯片序列号。'); if (serial) serials.add(serial);
    entry.device.chipSerial = serial ?? null;
    entry.device.provisioningState = entry.provisioning;
    if (entry.keys.kind === 'fixed') validatePrivate(entry.keys.privateKey);
    else { validatePrivate(entry.keys.masterPrivateKey); unbase64(entry.keys.symmetricSeed, 32); }
    if (entry.keys.kind !== entry.device.advertisingMode) throw new Error('密钥模式不匹配。');
    const seen = new Set<string>();
    for (const item of entry.reports) {
      if (item.deviceId !== entry.device.id || seen.has(item.id)) throw new Error('报告归属或 ID 无效。'); seen.add(item.id);
    }
    entry.reports.sort((a,b) => b.observedAt.localeCompare(a.observedAt) || b.id.localeCompare(a.id));
    entry.device.latestReport = entry.reports[0] ?? null;
  }
  return data;
}
export function stats(data: WorkspaceData) { return {deviceCount:data.records.length,reportCount:data.records.reduce((sum,r)=>sum+r.reports.length,0),hasAccount:!!data.account}; }
function parseJson(text: string): unknown {
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) throw new Error('文件超过 64 MiB，未导入。');
  try { return JSON.parse(text); } catch { throw new Error('文件不是有效 JSON。'); }
}
const AAD = new TextEncoder().encode('ATAG browser backup v1');
const ITERATIONS = 310_000;
async function backupKey(password: string, salt: Uint8Array<ArrayBuffer>) {
  if (password.length < 8 || password.length > 1024) throw new Error('备份密码须为 8–1024 个字符。');
  const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:ITERATIONS},key,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function exportEncryptedBackup(data: WorkspaceData,password:string,includeAccount=false): Promise<string> {
  const snapshot=structuredClone(data); if(!includeAccount) {snapshot.account=null;snapshot.accountExpired=false;}
  const clear = new TextEncoder().encode(JSON.stringify({createdAt:new Date().toISOString(),data:validateWorkspace(snapshot)}));
  if(clear.length>48*1024*1024) throw new Error('备份超过 48 MiB，请减少报告后再备份。');
  const salt=crypto.getRandomValues(new Uint8Array(16)); const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:AAD},await backupKey(password,salt),clear);
  return JSON.stringify({format:'atag-encrypted-backup',version:1,kdf:'PBKDF2-SHA256',iterations:ITERATIONS,cipher:'AES-256-GCM',salt:base64(salt),iv:base64(iv),ciphertext:base64(new Uint8Array(encrypted))});
}
export async function openEncryptedBackup(text:string,password:string):Promise<{data:WorkspaceData;summary:BackupSummary}> {
  const schema=z.object({format:z.literal('atag-encrypted-backup'),version:z.literal(1),kdf:z.literal('PBKDF2-SHA256'),iterations:z.literal(ITERATIONS),cipher:z.literal('AES-256-GCM'),salt:z.string(),iv:z.string(),ciphertext:z.string()}).strict();
  let envelope: z.infer<typeof schema>;
  try{envelope=schema.parse(parseJson(text));}catch{throw new Error('不是支持的 ATAG 加密备份文件。');}
  let decrypted:ArrayBuffer;
  try { decrypted=await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(unbase64(envelope.iv,12)),additionalData:AAD},await backupKey(password,new Uint8Array(unbase64(envelope.salt,16))),new Uint8Array(unbase64(envelope.ciphertext))); }
  catch {throw new Error('密码不正确或备份已损坏，现有数据未改变。');}
  const inner=z.object({createdAt:time,data:z.unknown()}).strict().parse(parseJson(new TextDecoder('utf-8',{fatal:true}).decode(decrypted)));
  const data=validateWorkspace(inner.data); return {data,summary:{...stats(data),createdAt:inner.createdAt}};
}
export function mergeRecords(current:WorkspaceData,incoming:WorkspaceData) {
  const next=structuredClone(current);
  for(const entry of incoming.records){
    const existing=next.records.find(r=>r.device.id===entry.device.id);
    if(existing){
      if(JSON.stringify(existing.keys)!==JSON.stringify(entry.keys) || (existing.device.chipSerial && entry.device.chipSerial && existing.device.chipSerial!==entry.device.chipSerial)) throw new Error('相同档案的密钥或序列号冲突，整个导入已取消。');
      const reports=new Map(existing.reports.map(r=>[r.id,r])); for(const item of entry.reports)if(!reports.has(item.id))reports.set(item.id,item);
      existing.reports=[...reports.values()];
      existing.device.chipSerial ??= entry.device.chipSerial;
    }else next.records.push(structuredClone(entry));
  }
  // Preserve current account, settings and nicknames on merge. Import credentials only if none exist.
  if(!next.account && incoming.account){next.account=structuredClone(incoming.account);next.accountExpired=incoming.accountExpired;next.anisetteUrl=incoming.anisetteUrl;}
  const validated=validateWorkspace(next); Object.assign(current,validated);
  return {deviceCount:incoming.records.length,reportCount:incoming.records.reduce((n,r)=>n+r.reports.length,0)};
}
