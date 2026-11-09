import {ClientError,validateAgentBaseUrl} from '../client-support.ts';
import type {QueryAccount} from '../workspace/types';
import type {AnisetteResponse,AppleRelayRequest,AppleRelayResponse,AppleTransport} from '../auth/types';
import {base64,unbase64} from '../workspace/crypto.ts';
export interface CiphertextReport{id:string;payload:string}
export interface BridgeHealth{service?:string;protocolVersion:1;agentVersion:string;capabilities:{anisette:boolean;appleRelay:boolean}}

// Keep the browser outside the agent's deadlines: machine worker 240s / HTTP
// 245s, Apple authentication 60s / HTTP 65s. Health remains a fast connectivity check.
const REQUEST_TIMEOUT_MS:Record<string,number>={
  '/v1/health':8_000,
  '/v1/anisette':250_000,
  '/v1/apple/request':70_000,
};

/** Only Anisette and fixed-destination byte forwarding cross the local boundary. */
export class BridgeClient implements AppleTransport{
  readonly baseUrl:string;
  private readonly fetchImpl:typeof fetch;
  constructor(url:string,fetchImpl:typeof fetch=globalThis.fetch.bind(globalThis)){
    this.fetchImpl=fetchImpl;const parsed=validateAgentBaseUrl(url);if(!parsed.ok)throw new ClientError('INVALID_REQUEST',parsed.message);
    if(!['127.0.0.1','localhost','[::1]'].includes(new URL(parsed.url).hostname))throw new ClientError('INVALID_REQUEST','本地桥接只接受 loopback 地址。');
    this.baseUrl=parsed.url;
  }
  async request<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T>{
    if(signal?.aborted)throw new ClientError('CANCELLED');const controller=new AbortController(),aborted=()=>controller.abort();signal?.addEventListener('abort',aborted,{once:true});
    let timedOut=false;const timeout=setTimeout(()=>{timedOut=true;controller.abort();},REQUEST_TIMEOUT_MS[path]??(body?55_000:8_000));
    try{
      const response=await this.fetchImpl(this.baseUrl+path,{method:body?'POST':'GET',headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal,cache:'no-store',credentials:'omit',redirect:'error'});
      const content=await response.text();if(content.length>12*1024*1024)throw new ClientError('UPSTREAM_UNAVAILABLE');let value;try{value=JSON.parse(content);}catch{throw new ClientError('VERSION_MISMATCH');}
      if(!response.ok){
        const error=value?.error;
        const known=['AUTH_REQUIRED','AUTH_EXPIRED','TIMEOUT','UNAUTHORIZED','INVALID_REQUEST','UPSTREAM_UNAVAILABLE'].includes(error?.code);
        const message=known&&typeof error.message==='string'&&error.message.trim()&&error.message.length<=512&&!/[\x00-\x1f\x7f]/.test(error.message)?error.message:undefined;
        throw new ClientError(known?error.code:'INTERNAL_ERROR',message,{status:response.status,...(known&&typeof error.retryable==='boolean'?{retryable:error.retryable}:{})});
      }
      return value as T;
    }catch(error){if(timedOut)throw new ClientError('TIMEOUT');if(signal?.aborted)throw new ClientError('CANCELLED');if(error instanceof ClientError)throw error;throw new ClientError('AGENT_UNAVAILABLE');}
    finally{clearTimeout(timeout);signal?.removeEventListener('abort',aborted);}
  }
  async connect(signal?:AbortSignal):Promise<BridgeHealth>{
    const health=await this.request<BridgeHealth>('/v1/health',undefined,signal);
    if(health?.protocolVersion!==1||typeof health.agentVersion!=='string'||health.capabilities?.anisette!==true||health.capabilities?.appleRelay!==true)throw new ClientError('VERSION_MISMATCH','请更新本地桥接以支持网页登录所需的 Anisette 和 Apple 请求转发。');
    return health;
  }
  async getAnisette(source:string,uid:string,deviceId:string,clientProfile:'auto'|'macos'|'windows'='auto',signal?:AbortSignal):Promise<AnisetteResponse>{
    const value=await this.request<AnisetteResponse>('/v1/anisette',{source,uid,deviceId,clientProfile},signal);
    if(!value||typeof value.clientInfo!=='string'||typeof value.userAgent!=='string'||!value.headers||typeof value.headers!=='object'||value.clientInfo.length>2048||value.userAgent.length>2048)throw new ClientError('UPSTREAM_UNAVAILABLE');
    const headers:Record<string,string>={};for(const [name,item] of Object.entries(value.headers)){
      if(!(name.toLowerCase().startsWith('x-apple-')||['x-mme-device-id','loc'].includes(name.toLowerCase()))||typeof item!=='string'||item.length>8192||/[\r\n]/.test(item))throw new ClientError('UPSTREAM_UNAVAILABLE');headers[name]=item;
    }
    const names=Object.keys(headers).map(k=>k.toLowerCase());if(!names.includes('x-apple-i-md')||!names.includes('x-apple-i-md-m'))throw new ClientError('UPSTREAM_UNAVAILABLE');
    return {headers,clientInfo:value.clientInfo,userAgent:value.userAgent};
  }
  async forwardApple(request:AppleRelayRequest,signal?:AbortSignal):Promise<AppleRelayResponse>{
    const value=await this.request<AppleRelayResponse>('/v1/apple/request',request,signal);
    if(!value||!Number.isInteger(value.status)||value.status<100||value.status>599||typeof value.bodyBase64!=='string'||value.bodyBase64.length>12*1024*1024)throw new ClientError('UPSTREAM_UNAVAILABLE');
    return value;
  }
  async fetchCiphertexts(account:QueryAccount,source:string,ids:string[],from:string,to:string,signal?:AbortSignal):Promise<CiphertextReport[]>{
    return fetchFindMyCiphertexts(this,account,source,ids,from,to,signal);
  }
}

/** Report protocol shared by the browser bridge and the iOS direct transport. */
export async function fetchFindMyCiphertexts(transport:AppleTransport,account:QueryAccount,source:string,ids:string[],from:string,to:string,signal?:AbortSignal):Promise<CiphertextReport[]>{
    if(!ids.length||ids.length>256||ids.some(id=>unbase64(id).length!==32)||!Number.isFinite(Date.parse(from))||!Number.isFinite(Date.parse(to))||Date.parse(from)>=Date.parse(to)||Date.parse(to)-Date.parse(from)>7*86400000)throw new ClientError('INVALID_REQUEST');
    const anisette=await transport.getAnisette(source,account.uid,account.deviceId,'auto',signal);
    const headers={...anisette.headers,Authorization:'Basic '+base64(new TextEncoder().encode(`${account.dsid}:${account.searchPartyToken}`)),Accept:'application/json','Content-Type':'application/json'};
    const send=async(endpoint:'findmy',body:unknown)=>{
      const response=await transport.forwardApple({endpoint,method:'POST',headers,bodyBase64:base64(new TextEncoder().encode(JSON.stringify(body)))},signal);
      if([401,403].includes(response.status))throw new ClientError('AUTH_EXPIRED');if(response.status<200||response.status>=300)throw new ClientError('UPSTREAM_UNAVAILABLE');
      try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(unbase64(response.bodyBase64)));}catch{throw new ClientError('UPSTREAM_UNAVAILABLE');}
    };
    const check=(value:Record<string,unknown>)=>{const code=String(value?.statusCode);if(['401','403'].includes(code))throw new ClientError('AUTH_EXPIRED');if(code!=='200')throw new ClientError('UPSTREAM_UNAVAILABLE');};
    const locations=(await send('findmy',{clientContext:{clientBundleIdentifier:'com.apple.icloud.searchpartyuseragent',policy:'foregroundClient'},fetch:[{primaryIds:ids,secondaryIds:[],ownedDeviceIds:[],keyType:1,startDate:Date.parse(from),startDateSecondary:Date.parse(from),endDate:Date.parse(to)}]}))?.acsnLocations;
    check(locations);if(!Array.isArray(locations.locationPayload))throw new ClientError('UPSTREAM_UNAVAILABLE');const reports:CiphertextReport[]=[];
    for(const group of locations.locationPayload){if(!group||typeof group.id!=='string'||!Array.isArray(group.locationInfo))throw new ClientError('UPSTREAM_UNAVAILABLE');for(const payload of group.locationInfo)reports.push({id:group.id,payload});}
    if(reports.length>20_000||reports.some(r=>!r||typeof r.id!=='string'||typeof r.payload!=='string'||r.payload.length>256))throw new ClientError('UPSTREAM_UNAVAILABLE');const requested=new Set(ids);return reports.filter(r=>requested.has(r.id));
}
