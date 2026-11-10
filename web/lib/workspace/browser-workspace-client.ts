import type { WorkspaceClient,WorkspaceOperation,AuthState,DeviceMetadataPatch,ProvisioningBundle,ProvisioningBundleRequest,ReportPage,ReportQuery,TagDevice } from '../contracts';
import { ClientError,toClientError } from '../client-support.ts';
import { BridgeClient,type BridgeHealth } from '../agent/bridge-client.ts';
import { discoverBridge } from '../agent/discovery.ts';
import { IndexedDbWorkspaceStore,type WorkspaceStore } from './store.ts';
import { base64,generateMaterial,makeConfiguration,reportKeys,decryptReport,unbase64 } from './crypto.ts';
import { exportEncryptedBackup,openEncryptedBackup,mergeRecords,stats,validateWorkspace } from './backup.ts';
import { updateReportRotationInterval } from './report-interval.ts';
import { estimateRotation, querySettingsView, REPORT_LOOKBACK_MS, type QuerySettingsView } from './report-query.ts';
import type { QuerySettings, RotationTiming, WorkspaceRecord } from './types.ts';
import {BrowserAppleLogin,type AppleLoginInput} from '../auth/apple-login.ts';
import {BUILTIN_ANISETTE_SOURCES,DEFAULT_ANISETTE_SOURCE} from '../preferences.ts';

const signalCheck=(signal?:AbortSignal)=>{if(signal?.aborted)throw new ClientError('CANCELLED');};
const reportOrder=(a:{observedAt:string;id:string},b:{observedAt:string;id:string})=>b.observedAt.localeCompare(a.observedAt)||b.id.localeCompare(a.id);
const find=(records:WorkspaceRecord[],id:string)=>{const record=records.find(r=>r.device.id===id);if(!record)throw new ClientError('NOT_FOUND','此浏览器中找不到该设备档案。');return record;};
export function validateAnisetteUrl(value:string):string{
  const source=value.trim()||DEFAULT_ANISETTE_SOURCE;
  if(BUILTIN_ANISETTE_SOURCES.some(value=>value===source))return source;
  let url:URL;try{url=new URL(source);}catch{throw new Error('请填写有效的 Anisette URL。');}
  if(url.username||url.password||url.hash||!(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw new Error('Anisette 需使用 HTTPS 或 loopback HTTP，不能包含凭据。');
  return url.toString();
}
/** Browser-owned device profiles, key material, reports and query sessions. */
export class BrowserWorkspaceClient implements WorkspaceClient {
  #bridge:BridgeClient|null=null;
  #operations=new Map<string,WorkspaceOperation>();
  #generation=0;
  readonly #login:BrowserAppleLogin;
  private readonly store:WorkspaceStore;
  constructor(store:WorkspaceStore=new IndexedDbWorkspaceStore()){
    this.store=store;
    this.#login=new BrowserAppleLogin(()=>{if(!this.#bridge)throw new ClientError('AGENT_UNAVAILABLE','登录需要先连接本地桥接。');return this.#bridge;},async(account,source,signal)=>{
      await this.store.update(data=>{signalCheck(signal);data.account=account;data.accountExpired=false;data.anisetteUrl=source;},signal);this.#generation++;
    });
  }
  getAppleLoginState(){return this.#login.snapshot();}
  subscribeAppleLogin(listener:Parameters<BrowserAppleLogin['subscribe']>[0]){return this.#login.subscribe(listener);}
  startAppleLogin(input:AppleLoginInput){return this.#login.start({...input,anisetteSource:validateAnisetteUrl(input.anisetteSource??'')});}
  requestAppleCode(methodId:string){return this.#login.requestCode(methodId);}
  submitAppleCode(code:string){return this.#login.submitCode(code);}
  cancelAppleLogin(){this.#login.cancel();}
  async logoutApple(){this.#login.cancel();this.#generation++;await this.store.update(data=>{data.account=null;data.accountExpired=false;});}
  get bridgeConnected(){return !!this.#bridge;}
  async connectBridge(url:string,signal?:AbortSignal):Promise<BridgeHealth>{
    const bridge=new BridgeClient(url);const health=await bridge.connect(signal);signalCheck(signal);this.#bridge=bridge;
    return health;
  }
  async discoverBridge(preferred: string, signal?: AbortSignal, onPermissionPending?: (pending: boolean) => void): Promise<{url:string;health:BridgeHealth}|null> {
    const found = await discoverBridge(preferred, { signal, onPermissionPending });
    signalCheck(signal);
    if (!found) return null;
    this.#bridge = found.client;
    return {url:found.client.baseUrl,health:found.health};
  }
  disconnectBridge(){this.#login.cancel();this.#bridge=null;this.#generation++;}
  async getAuthState():Promise<AuthState>{const data=await this.store.read();return {status:data.account?(data.accountExpired?'expired':'ready'):'not_configured',accountLabel:data.account?.accountLabel??null};}
  async listDevices(signal?:AbortSignal){signalCheck(signal);return (await this.store.read()).records.map(r=>({...r.device,provisioningState:r.provisioning}));}
  async getDevice(id:string,signal?:AbortSignal){signalCheck(signal);const r=find((await this.store.read()).records,id);return {...r.device,provisioningState:r.provisioning};}
  async updateDevice(id:string,patch:DeviceMetadataPatch,signal?:AbortSignal){signalCheck(signal);return this.store.update(data=>{
    const record=find(data.records,id);const next={...record.device,...patch};record.device=next;validateWorkspace(data);return structuredClone({...record.device,provisioningState:record.provisioning});
  });}
  async deleteDevice(id:string,signal?:AbortSignal){signalCheck(signal);await this.store.update(data=>{find(data.records,id);data.records=data.records.filter(r=>r.device.id!==id);});}
  async listReports(id:string,query:ReportQuery,signal?:AbortSignal):Promise<ReportPage>{
    signalCheck(signal);const record=find((await this.store.read()).records,id);
    const from=Date.parse(query.from),to=Date.parse(query.to);if(!Number.isFinite(from)||!Number.isFinite(to)||from>to)throw new ClientError('INVALID_REQUEST');
    let after:{observedAt:string;id:string}|null=null;
    if(query.cursor){try{const c=JSON.parse(atob(query.cursor));if(c.deviceId!==id||c.from!==query.from||c.to!==query.to||typeof c.id!=='string'||typeof c.observedAt!=='string')throw 0;after=c;}catch{throw new ClientError('INVALID_REQUEST','历史游标无效。');}}
    const reports=record.reports.filter(r=>Date.parse(r.observedAt)>=from&&Date.parse(r.observedAt)<=to&&(!after||reportOrder(r,after)>0)).sort(reportOrder);
    const limit=Math.max(1,Math.min(200,Math.floor(query.limit??200)));const page=reports.slice(0,limit);const last=page.at(-1);
    return {reports:page,nextCursor:reports.length>limit&&last?btoa(JSON.stringify({deviceId:id,from:query.from,to:query.to,id:last.id,observedAt:last.observedAt})):null};
  }
  async createProvisioningBundle(input:ProvisioningBundleRequest,signal?:AbortSignal):Promise<ProvisioningBundle>{
    signalCheck(signal);const keys=generateMaterial(input.mode);const interval=input.mode==='rotating'?(input.rotationIntervalMinutes??15):null;
    const bytes=makeConfiguration(keys,interval);const id='tag_'+crypto.randomUUID().replaceAll('-','');
    const device:TagDevice={id,name:input.name.trim(),icon:'tag',color:'#cb623b',advertisingMode:input.mode,rotationIntervalMinutes:interval,firmwareVersion:null,chipSerial:null,capabilities:{provisioning:true,management:true,telemetry:true,ring:false,ota:false},latestReport:null,createdAt:new Date().toISOString()};
    await this.store.update(data=>{signalCheck(signal);data.records.push({device,keys,query:{rotationStart:1,rotationCount:512},reports:[],provisioning:'draft'});validateWorkspace(data);});
    return {deviceId:id,mode:input.mode,rotationIntervalMinutes:interval,configurationBase64:base64(bytes)};
  }
  async confirmProvisioning(id: string, serial: string | null, firmwareVersion?: string | null) {
    await this.store.update(data => {
      const record = find(data.records, id);
      if (record.device.chipSerial && serial && record.device.chipSerial !== serial.toLowerCase()) {
        throw new Error('档案已绑定其他 Tag，未改变绑定。');
      }
      record.provisioning = 'confirmed';
      record.device.chipSerial = serial?.toLowerCase() ?? record.device.chipSerial ?? null;
      record.device.firmwareVersion = firmwareVersion ?? record.device.firmwareVersion;
      // Applying a package replaces the active interval with the one from the profile.
      delete record.rotationTiming;
      delete record.reportRotationInterval;
      record.provisionedAt = new Date().toISOString();
      validateWorkspace(data);
    });
  }
  async getProvisioningBundle(id:string):Promise<ProvisioningBundle>{
    const record=find((await this.store.read()).records,id);
    return {deviceId:id,mode:record.device.advertisingMode,rotationIntervalMinutes:record.device.rotationIntervalMinutes,configurationBase64:base64(makeConfiguration(record.keys,record.device.rotationIntervalMinutes))};
  }
  async getQuerySettings(id: string): Promise<QuerySettingsView> {
    const record = find((await this.store.read()).records, id);
    const now = Date.now();
    if (!updateReportRotationInterval(record, now)) return querySettingsView(record, now);
    return this.store.update(data => {
      // Another tab may have saved a Tag reading since the snapshot above.
      const current = find(data.records, id);
      const asOf = Date.now();
      updateReportRotationInterval(current, asOf);
      return querySettingsView(current, asOf);
    });
  }
  async updateQuerySettings(id:string,patch:Partial<QuerySettings>){await this.store.update(data=>{const record=find(data.records,id);record.query={...record.query,...patch};validateWorkspace(data);});}
  async observeRotationTiming(serial: string, timing: RotationTiming): Promise<boolean> {
    const observedAt = Date.parse(timing.observedAt);
    const now = Date.now();
    if (!Number.isFinite(observedAt) || observedAt > now || !Number.isInteger(timing.rotation) ||
        timing.rotation < 1 || timing.rotation > 0xffffffff || !Number.isInteger(timing.intervalMinutes) ||
        timing.intervalMinutes < 1 || timing.intervalMinutes > 0xffffffff) return false;
    const normalizedSerial = serial.toLowerCase();
    return this.store.update(data => {
      const record = data.records.find(item => item.device.chipSerial === normalizedSerial);
      if (!record || record.keys.kind !== 'rotating') return false;
      const provisioned = Date.parse(record.provisionedAt ?? '');
      if (provisioned <= now && observedAt < provisioned) return false;
      const previous = Date.parse(record.rotationTiming?.observedAt ?? '');
      if (previous >= observedAt && previous <= now) return false;
      record.rotationTiming = { ...timing, observedAt: new Date(observedAt).toISOString() };
      return true;
    });
  }
  async refreshReports(id:string,signal?:AbortSignal):Promise<WorkspaceOperation>{
    signalCheck(signal);const pending=[...this.#operations.values()].find(o=>o.deviceId===id&&(o.status==='queued'||o.status==='running'));if(pending)return structuredClone(pending);
    const bridge=this.#bridge;if(!bridge)throw new ClientError('AGENT_UNAVAILABLE','获取新报告需要连接本地桥接。档案、已有报告与密钥仍保存在此浏览器。');
    const data=await this.store.read();const record=find(data.records,id);if(!data.account)throw new ClientError('AUTH_REQUIRED','请先在网页设置中登录 Apple 账号。');if(data.accountExpired)throw new ClientError('AUTH_EXPIRED','此浏览器的 Apple 登录已失效，请在网页重新登录。');
    const generation=this.#generation;const operation:WorkspaceOperation={id:'op_'+crypto.randomUUID(),deviceId:id,kind:'refresh_reports',status:'running',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),result:null,error:null};
    for(const [key,op]of this.#operations)if(this.#operations.size>=256&&!['running','queued'].includes(op.status))this.#operations.delete(key);
    this.#operations.set(operation.id,operation);
    void(async()=>{try{
      const now = Date.now();
      const from = new Date(now - REPORT_LOOKBACK_MS).toISOString();
      const to = new Date(now).toISOString();
      if (record.query.rotationMode !== 'manual') updateReportRotationInterval(record, now);
      const estimate = record.query.rotationMode === 'manual' ? null : estimateRotation(record, now);
      const keys = await reportKeys(record.keys, estimate ?? record.query, signal);
      const ids = [...keys.keys()];
      const collected=new Map<string,Awaited<ReturnType<typeof decryptReport>>>();
      for(let i=0;i<ids.length;i+=256){
        signalCheck(signal);if(generation!==this.#generation)throw new ClientError('CANCELLED');
        const batch=ids.slice(i,i+256);const accepted=new Set(batch);const raw=await bridge.fetchCiphertexts(data.account!,data.anisetteUrl,batch,from,to,signal);
        for (const report of raw) {
          if (!accepted.has(report.id)) continue;
          const key = keys.get(report.id)!;
          const decoded = await decryptReport(id, key.privateKey, unbase64(report.payload));
          if (decoded.observedAt < from || decoded.observedAt > to) continue;
          if (key.rotation !== undefined) decoded.rotation = key.rotation;
          collected.set(decoded.id, decoded);
          if (collected.size > 20000) throw new Error('报告数量超出限制。');
        }
      }
      signalCheck(signal);if(generation!==this.#generation)throw new ClientError('CANCELLED');
      const count = await this.store.update(current => {
        signalCheck(signal);
        if (generation !== this.#generation) throw new ClientError('CANCELLED');
        const target = find(current.records, id);
        const byId = new Map(target.reports.map(report => [report.id, report]));
        let added = 0;
        for (const report of collected.values()) {
          const saved = byId.get(report.id);
          if (!saved) {
            byId.set(report.id, report);
            added++;
          } else if (saved.rotation === undefined && report.rotation !== undefined) {
            // Refetching a legacy report recovers its round without counting it twice.
            byId.set(report.id, { ...saved, rotation: report.rotation });
          }
        }
        target.reports = [...byId.values()].sort(reportOrder).slice(0, 20000);
        target.device.latestReport = target.reports[0] ?? null;
        updateReportRotationInterval(target, Date.now());
        return added;
      }, signal);
      operation.status='succeeded';operation.result={newReportCount:count};
    }catch(error){const normalized=toClientError(error);operation.status=normalized.code==='CANCELLED'?'cancelled':'failed';operation.error=normalized;
      if(normalized.code==='AUTH_EXPIRED')await this.store.update(current=>{if(current.account?.searchPartyToken===data.account?.searchPartyToken)current.accountExpired=true;}).catch(()=>{});}
    finally{operation.updatedAt=new Date().toISOString();}})();
    return structuredClone(operation);
  }
  async getOperation(id:string,signal?:AbortSignal){signalCheck(signal);const op=this.#operations.get(id);if(!op)throw new ClientError('NOT_FOUND');return structuredClone(op);}
  async getStats(){return stats(await this.store.read());}
  async exportBackup(password:string,includeAccount=false){return exportEncryptedBackup(await this.store.read(),password,includeAccount);}
  async previewBackup(text:string,password:string){return (await openEncryptedBackup(text,password)).summary;}
  async restoreBackup(text:string,password:string){const {data}=await openEncryptedBackup(text,password);return this.store.update(current=>mergeRecords(current,data));}
}
