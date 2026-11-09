import {sha256} from '@noble/hashes/sha2.js';
import {base64,unbase64} from '../workspace/crypto.ts';
import type {QueryAccount} from '../workspace/types';
import {ClientError} from '../client-support.ts';
import {DEFAULT_ANISETTE_SOURCE} from '../preferences.ts';
import {AppleSrpClient} from './srp.ts';
import {decodePlist,encodePlist,dict,text,data,identifier,protocolError,type Plist} from './plist.ts';
import {idleLogin,type AppleLoginInput,type AppleLoginSnapshot,type AppleTransport,type AppleVerificationMethod,type AppleEndpoint,type AnisetteResponse} from './types.ts';
export type {AppleLoginInput,AppleLoginSnapshot,AppleLoginPhase,AppleVerificationMethod} from './types.ts';

const utf8=(s:string)=>new TextEncoder().encode(s);
const authError=(message:string)=>new ClientError('AUTH_REQUIRED',message,{retryable:false});
// AUTH_REQUIRED also covers account repair and verification-code failures.
// Only Apple's explicit account/password rejection should clear the form password.
class CredentialsRejected extends ClientError {
  constructor(){super('AUTH_REQUIRED','Apple 账户或密码不正确，请检查后重新输入。',{retryable:false});}
}
const maskAccount=(s:string)=>{const [name,domain]=s.split('@');return domain?`${[...name][0]??'*'}***@${domain}`:'Apple 账户';};
const protocol=(stage='响应')=>new ClientError('UPSTREAM_UNAVAILABLE',`Apple ${stage}未通过验证，登录未保存。`,{retryable:false});
// Only fixed stage labels reach the UI; never render upstream bodies or crypto errors.
async function validated<T>(stage:string,read:()=>T|Promise<T>):Promise<T>{
  try{return await read();}catch(error){throw error instanceof ClientError?error:protocol(stage);}
}
const busyPhases=new Set(['authenticating','sending_code','verifying','saving']);
const relaySteps:Record<AppleEndpoint,string>={
  gsa:'登录验证',mobileme:'Find My 会话授权',methods:'获取验证方式',
  sms_request:'发送短信验证码',sms_submit:'验证短信验证码',
  trusted_request:'发送受信任设备验证码',trusted_submit:'验证受信任设备验证码',findmy:'查询 Find My 报告',
};
interface Challenge {adsid:string;idmsToken:string;trusted:boolean}
interface Authenticated {adsid:string;pet:string}

function mobileMeClient(anisette:AnisetteResponse):{clientInfo:string;userAgent:string}{
  // Keep the provisioned model, OS and networking stack. MobileMe is an
  // accountsd/iCloudHelper request, rather than an AuthKit/akd request.
  // Matches FindMy.py's endpoint-specific get_client_info application profile.
  const clientInfo=/^<[^<>]+> <(?:macOS|Mac OS X);[^<>]+> <[^<>]+>$/.test(anisette.clientInfo)
    ?anisette.clientInfo.replace(/ <[^<>]+>$/,' <com.apple.AOSKit/282 (com.apple.accountsd/113)>')
    :anisette.clientInfo;
  return {clientInfo,userAgent:anisette.userAgent.replace(/^akd\/1\.0(?=\s|$)/,'com.apple.iCloudHelper/282')};
}

function anisetteIdentity(anisette:AnisetteResponse,fallback:{uid:string;deviceId:string}):{uid:string;deviceId:string}{
  const header=(name:string)=>Object.entries(anisette.headers).find(([key])=>key.toLowerCase()===name)?.[1];
  const localUser=header('x-apple-i-md-lu');
  let uid=localUser??fallback.uid;
  // Native providers encode their local user identifier; the v3 protocol uses
  // a hexadecimal hash directly. Keep either provider's actual identifier.
  if(localUser&&!/^[0-9a-f]{32,64}$/i.test(localUser)){
    try{
      const decoded=new TextDecoder('utf-8',{fatal:true}).decode(unbase64(localUser));
      if(/^[a-z0-9-]{1,128}$/i.test(decoded))uid=decoded;
    }catch{/* the provider supplied its identifier directly */}
  }
  const deviceId=header('x-mme-device-id')??fallback.deviceId;
  if(!/^[a-z0-9-]{1,128}$/i.test(uid)||!/^[a-z0-9-]{1,128}$/i.test(deviceId))throw protocol('Anisette 机器标识');
  return {uid,deviceId};
}

/** Browser-owned login. Only public SRP messages, one-time codes and token-authenticated
 * Apple requests reach the relay; the Apple password/password hash never does. */
export class BrowserAppleLogin {
  #state=idleLogin();#listeners=new Set<(s:AppleLoginSnapshot)=>void>();
  #controller=new AbortController();#generation=0;#timer:ReturnType<typeof setTimeout>|null=null;
  #hash:Uint8Array|null=null;#username='';#identity={uid:'',deviceId:''};#source:string=DEFAULT_ANISETTE_SOURCE;#profile:'auto'|'macos'|'windows'='auto';
  #machineIdentity:{uid:string;deviceId:string}|null=null;
  #challenge:Challenge|null=null;#deadline=0;
  readonly #transport:()=>AppleTransport;
  readonly #save:(account:QueryAccount,source:string,signal:AbortSignal)=>Promise<void>;
  constructor(transport:()=>AppleTransport,save:(account:QueryAccount,source:string,signal:AbortSignal)=>Promise<void>){this.#transport=transport;this.#save=save;}
  snapshot(){return structuredClone(this.#state);}
  subscribe(listener:(s:AppleLoginSnapshot)=>void){this.#listeners.add(listener);listener(this.snapshot());return()=>{this.#listeners.delete(listener);};}
  #set(patch:Partial<AppleLoginSnapshot>){this.#state={...this.#state,...patch};this.#state.busy=busyPhases.has(this.#state.phase);if(!this.#state.busy)this.#state.progress=null;for(const listener of this.#listeners)listener(this.snapshot());}
  #wipe(){this.#hash?.fill(0);this.#hash=null;this.#challenge=null;this.#username='';this.#identity={uid:'',deviceId:''};this.#machineIdentity=null;if(this.#timer)clearTimeout(this.#timer);this.#timer=null;}
  cancel(){this.#generation++;this.#controller.abort();this.#controller=new AbortController();this.#wipe();this.#set(idleLogin());}
  #expire(){this.#generation++;this.#controller.abort();this.#wipe();this.#set({phase:'expired',error:{code:'AUTH_EXPIRED',message:'登录验证已过期，请重新登录。'},methods:[],selectedMethodId:null});}
  #guard(generation:number){if(generation!==this.#generation||this.#controller.signal.aborted)throw new ClientError('CANCELLED');if(Date.now()>=this.#deadline){this.#expire();throw new ClientError('AUTH_EXPIRED','登录验证已过期，请重新登录。');}}
  #idle(){if(this.#state.busy)throw new ClientError('INVALID_REQUEST','请等待当前登录操作完成。');}
  #failure(error:unknown,generation:number,recoverable=false){
    if(generation!==this.#generation)return;
    const safe=error instanceof ClientError?error:protocol();
    if(safe.code==='CANCELLED')return;
    if(!recoverable)this.#wipe();
    this.#set({phase:recoverable?'awaiting_code':'error',error:{code:safe.code,message:safe.message,...(safe instanceof CredentialsRejected?{credentialsRejected:true}:{})},...(!recoverable?{methods:[],selectedMethodId:null}: {})});
  }
  async start(input:AppleLoginInput){
    this.#idle();this.cancel();const generation=this.#generation;
    const username=input.username.trim();
    if(!username||username.length>320||/[\x00-\x1f\x7f]/.test(username)||!input.password||input.password.length>4096){const e=authError('请填写有效的 Apple 账户和密码。');this.#failure(e,generation);throw e;}
    this.#deadline=Date.now()+600000;this.#username=username;const raw=utf8(input.password);this.#hash=sha256(raw);raw.fill(0);
    this.#identity={uid:crypto.randomUUID().toUpperCase(),deviceId:crypto.randomUUID().toUpperCase()};
    this.#source=input.anisetteSource?.trim()||DEFAULT_ANISETTE_SOURCE;this.#profile=input.clientProfile??'auto';
    this.#timer=setTimeout(()=>this.#expire(),600000);
    this.#set({phase:'authenticating',accountLabel:maskAccount(username),expiresAt:new Date(this.#deadline).toISOString(),error:null});
    try{
      const result=await this.#authenticate(generation);this.#guard(generation);
      if('pet'in result)await this.#finish(result,generation);
      else{this.#challenge=result;const methods=await this.#methods(result,generation);this.#guard(generation);this.#set({phase:'choose_method',methods,selectedMethodId:null});}
    }catch(error){this.#failure(error,generation);throw this.#safe(error);}
  }
  #safe(error:unknown){return error instanceof ClientError?error:protocol();}
  async requestCode(methodId:string){
    this.#idle();const generation=this.#generation;this.#guard(generation);
    const challenge=this.#challenge,method=this.#state.methods.find(m=>m.id===methodId);
    if(!challenge||!method)throw authError('请选择 Apple 提供的验证方式。');
    if(this.#state.sendsRemaining<=0)throw authError('本次验证码发送次数已用完，请重新登录。');
    this.#set({phase:'sending_code',selectedMethodId:methodId,error:null,sendsRemaining:this.#state.sendsRemaining-1});
    try{await this.#second(challenge,method.kind==='trusted_device'?'trusted_request':'sms_request',method.kind==='trusted_device'?'GET':'PUT',method.kind==='sms'?{phoneNumber:{id:Number(method.id.slice(4))},mode:'sms'}:undefined,undefined,generation);this.#guard(generation);this.#set({phase:'awaiting_code'});}
    catch(error){this.#failure(error,generation,true);throw this.#safe(error);}
  }
  async submitCode(code:string){
    this.#idle();const generation=this.#generation;this.#guard(generation);
    if(!/^\d{6}$/.test(code))throw authError('验证码须为 6 位数字。');
    const challenge=this.#challenge,method=this.#state.methods.find(m=>m.id===this.#state.selectedMethodId);
    if(!challenge||!method||this.#state.phase!=='awaiting_code')throw authError('请先发送验证码。');
    if(this.#state.attemptsRemaining<=0)throw authError('本次验证次数已用完，请重新登录。');
    this.#set({phase:'verifying',error:null,attemptsRemaining:this.#state.attemptsRemaining-1});
    let codeVerified=false;
    try{
      const response=await this.#second(challenge,method.kind==='trusted_device'?'trusted_submit':'sms_submit',method.kind==='trusted_device'?'GET':'POST',method.kind==='sms'?{phoneNumber:{id:Number(method.id.slice(4))},securityCode:{code},mode:'sms'}:undefined,method.kind==='trusted_device'?code:undefined,generation);
      this.#guard(generation);await validated('验证码响应解析',()=>this.#checkCodeResponse(response));codeVerified=true;
      const result=await this.#authenticate(generation);this.#guard(generation);
      if(!('pet'in result))throw authError('Apple 验证后仍要求额外验证，请检查账户后重新登录。');
      await this.#finish(result,generation);
    }catch(error){const recover=!codeVerified&&this.#state.attemptsRemaining>0&&error instanceof ClientError&&error.code==='AUTH_REQUIRED';this.#failure(error,generation,recover);throw this.#safe(error);}
  }
  async #anisette(generation:number):Promise<AnisetteResponse>{
    this.#guard(generation);this.#set({progress:'正在准备登录所需的机器认证…'});
    const value=await this.#transport().getAnisette(this.#source,this.#identity.uid,this.#identity.deviceId,this.#profile,this.#controller.signal).catch(error=>{
      if(error instanceof ClientError&&error.code==='TIMEOUT')throw new ClientError('TIMEOUT','准备登录所需的机器认证（Anisette）超时，登录未保存。请检查所选认证来源后重试。',{status:error.status,retryable:error.retryable});
      throw error;
    });this.#guard(generation);
    const identity=anisetteIdentity(value,this.#identity);
    if(this.#machineIdentity&&(identity.uid!==this.#machineIdentity.uid||identity.deviceId!==this.#machineIdentity.deviceId))throw protocol('登录期间的 Anisette 机器身份一致性');
    this.#machineIdentity=identity;this.#identity=identity;
    return value;
  }
  async #relay(endpoint:AppleEndpoint,method:'GET'|'POST'|'PUT',headers:Record<string,string>,body:Uint8Array|undefined,generation:number,code=false,stage?:'登录初始化'|'密码验证'){
    const operation=stage??relaySteps[endpoint];
    this.#guard(generation);this.#set({progress:`正在进行 Apple ${operation}…`});
    const response=await this.#transport().forwardApple({endpoint,method,headers,...(body?{bodyBase64:base64(body)}:{})},this.#controller.signal).catch(error=>{
      if(error instanceof ClientError&&error.code==='TIMEOUT')throw new ClientError('TIMEOUT',`Apple ${operation}超时，登录未保存。`,{status:error.status,retryable:true});
      if(error instanceof ClientError&&error.code==='UPSTREAM_UNAVAILABLE'&&error.status===502)throw new ClientError('UPSTREAM_UNAVAILABLE',`Apple ${operation}未收到可用响应，登录未保存。`,{status:error.status,retryable:error.retryable});
      throw error;
    });
    this.#guard(generation);
    if(response.status<200||response.status>=300){
      if([400,401,403].includes(response.status))throw authError(code?'验证码无效或已过期，请重试。':'Apple 拒绝了登录或验证会话，请检查账户后重试。');
      throw new ClientError('UPSTREAM_UNAVAILABLE',`Apple ${operation}返回异常响应（HTTP ${response.status}），登录未保存。`,{status:response.status,retryable:response.status===429||response.status>=500});
    }
    return unbase64(response.bodyBase64);
  }
  #status(value:Record<string,Plist>,code=false){
    const ec=value.ec;if(typeof ec!=='number')throw protocolError();if(ec===0)return;
    if([-80045,-80046,-23782].includes(ec))throw new ClientError('UPSTREAM_UNAVAILABLE',`Apple 拒绝了当前 Anisette 或客户端身份（错误 ${ec}），请检查认证来源。`,{retryable:false});
    if(code)throw authError('验证码无效或已过期，请重试。');
    if(ec===-20101)throw new CredentialsRejected();
    throw authError(`Apple 拒绝了登录（错误 ${ec}），请检查账户状态后重试。`);
  }
  async #gsa(parameters:Record<string,Plist>,exchange:{anisette:AnisetteResponse;requestId:string},generation:number):Promise<Record<string,Plist>>{
    const a=exchange.anisette;const cpd:Record<string,Plist>={bootstrap:true,icscrec:true,pbe:false,prkgen:true,svct:'iCloud',...a.headers,'X-Apple-I-Request-UUID':exchange.requestId};
    for(const name of ['X-Apple-I-Client-Time','X-Apple-I-TimeZone','X-Apple-Locale','X-Apple-I-MD','X-Apple-I-MD-LU','X-Apple-I-MD-M','X-Apple-I-MD-RINFO','X-Mme-Device-Id','X-Apple-I-SRL-NO']){
      const found=Object.entries(a.headers).find(([k])=>k.toLowerCase()===name.toLowerCase());if(found){delete cpd[found[0]];cpd[name]=found[1];}
    }
    const bytes=await this.#relay('gsa','POST',{'X-MMe-Client-Info':a.clientInfo,'User-Agent':a.userAgent,'Content-Type':'text/x-xml-plist',Accept:'*/*'},encodePlist({Header:{Version:'1.0.1'},Request:{...parameters,cpd}}),generation,false,parameters.o==='init'?'登录初始化':'密码验证');
    return validated(parameters.o==='init'?'登录初始化响应解析':'密码验证响应解析',()=>{
      const response=dict(dict(decodePlist(bytes)).Response);this.#status(dict(response.Status));return response;
    });
  }
  async #authenticate(generation:number):Promise<Challenge|Authenticated>{
    const srp=new AppleSrpClient();
    try{
      // Correlate init and complete like akd: one OTP and one request UUID per SRP exchange.
      const exchange={anisette:await this.#anisette(generation),requestId:crypto.randomUUID().toUpperCase()};
      const init=await this.#gsa({A2k:srp.publicKey,u:this.#username,ps:['s2k','s2k_fo'],o:'init'},exchange,generation);this.#guard(generation);
      const proof=await validated('SRP 参数校验',()=>{
        if(typeof init.i!=='number'||!this.#hash)throw protocolError();
        return srp.challenge(this.#username,this.#hash,data(init.s),init.i,text(init.sp),data(init.B));
      });
      try{
        this.#guard(generation);
        if(typeof init.c!=='string'&&!(init.c instanceof Uint8Array))throw protocol('登录挑战字段');
        const complete=await this.#gsa({c:init.c,M1:proof.clientProof,u:this.#username,o:'complete'},exchange,generation);
        const spd=await validated('SRP 证明与会话解密',async()=>dict(await proof.decrypt(data(complete.M2),data(complete.spd))));this.#guard(generation);
        const status=dict(complete.Status);
        const adsid=await validated('会话账号标识',()=>identifier(spd.adsid)),kind=status.au??(status.hsc===409?'trustedDeviceSecondaryAuth':undefined);
        if(kind===undefined)return {adsid,pet:await validated('登录授权凭据（PET）',()=>text(dict(dict(spd.t)['com.apple.gs.idms.pet']).token))};
        if(kind==='secondaryAuth'||kind==='trustedDeviceSecondaryAuth')return {adsid,idmsToken:await validated('双重认证会话字段',()=>text(spd.GsIdmsToken)),trusted:kind==='trustedDeviceSecondaryAuth'};
        throw authError('Apple 要求额外的账户处理，请先在 Apple 官方设备或网站完成后重试。');
      }finally{proof.destroy();}
    }finally{srp.destroy();}
  }
  async #second(challenge:Challenge,endpoint:AppleEndpoint,method:'GET'|'POST'|'PUT',body:Record<string,Plist>|undefined,code:string|undefined,generation:number){
    const a=await this.#anisette(generation);
    return this.#relay(endpoint,method,{...a.headers,'X-Mme-Client-Info':a.clientInfo,'User-Agent':a.userAgent,'Accept-Language':'en-us','X-Apple-Identity-Token':base64(utf8(`${challenge.adsid}:${challenge.idmsToken}`)),Accept:body?'application/json':endpoint==='methods'?'text/html, application/json':'text/x-xml-plist',...(body?{'Content-Type':'application/json'}:{'Content-Type':'text/x-xml-plist'}),...(code?{'security-code':code}:{})},body?utf8(JSON.stringify(body)):undefined,generation,endpoint==='sms_submit'||endpoint==='trusted_submit');
  }
  async #methods(challenge:Challenge,generation:number):Promise<AppleVerificationMethod[]>{
    const methods:AppleVerificationMethod[]=challenge.trusted?[{id:'trusted',kind:'trusted_device',label:'受信任的 Apple 设备'}]:[];
    try{const bytes=await this.#second(challenge,'methods','GET',undefined,undefined,generation);this.#guard(generation);methods.push(...parsePhoneMethods(new TextDecoder().decode(bytes)));}catch(error){if(!methods.length)throw error;}
    if(!methods.length)throw authError('Apple 没有提供可用的验证方式，请在受信任设备检查账户。');return methods;
  }
  #checkCodeResponse(bytes:Uint8Array){
    if(!new TextDecoder().decode(bytes).trim())return;
    try{const value=JSON.parse(new TextDecoder().decode(bytes));if(Array.isArray(value.serviceErrors)&&value.serviceErrors.length)throw authError('验证码无效或已过期，请重试。');return;}catch(error){if(error instanceof ClientError)throw error;}
    const value=dict(decodePlist(bytes));if(typeof value.ec==='number'&&value.ec!==0)throw authError('验证码无效或已过期，请重试。');if(value.Status)this.#status(dict(value.Status),true);
  }
  async #finish(authenticated:Authenticated,generation:number){
    const a=await this.#anisette(generation);
    const client=mobileMeClient(a);
    const bytes=await this.#relay('mobileme','POST',{...a.headers,'X-Apple-ADSID':authenticated.adsid,'X-Mme-Client-Info':client.clientInfo,'User-Agent':client.userAgent,'Content-Type':'text/x-xml-plist',Authorization:'Basic '+base64(utf8(`${this.#username}:${authenticated.pet}`))},encodePlist({'apple-id':this.#username,delegates:{'com.apple.mobileme':{}},password:authenticated.pet,'client-id':this.#identity.uid}),generation);
    const root=await validated('Find My 授权响应解析',()=>dict(decodePlist(bytes)));
    if(root.localizedError!==undefined||root.status!==undefined&&root.status!==0)throw authError('Apple 未授予 Find My 查询会话，请检查账户后重试。');
    const delegate=await validated('Find My 授权响应解析',()=>dict(dict(root.delegates)['com.apple.mobileme']));
    if((delegate.status??root.status)!==0)throw authError('Apple 未授予 Find My 查询会话，请检查账户后重试。');
    const dsid=await validated('Find My 账号标识',()=>identifier(root.dsid));
    const tokens=await validated('Find My 服务凭据解析',()=>dict(dict(delegate['service-data']).tokens));
    if(typeof tokens.searchPartyToken!=='string'||!tokens.searchPartyToken){
      // Capability names are fixed public labels, never credential values or arbitrary keys.
      const returned=['mmeAuthToken','mailToken','cloudKitToken','mmeFMIPToken','mmeFMFToken'].filter(name=>typeof tokens[name]==='string'&&tokens[name]);
      throw new ClientError('UPSTREAM_UNAVAILABLE',`Apple 已完成账号验证，但未返回 Find My 查询凭据（searchPartyToken），登录未保存。已返回的凭据类型：${returned.join('、')||'无已知类型'}。`,{retryable:false});
    }
    const account:QueryAccount={dsid,searchPartyToken:tokens.searchPartyToken,...this.#identity,accountLabel:maskAccount(this.#username)};
    this.#guard(generation);this.#set({phase:'saving',progress:'正在保存登录到此浏览器…'});await this.#save(account,this.#source,this.#controller.signal);this.#guard(generation);this.#wipe();this.#set({phase:'complete',expiresAt:null,methods:[],selectedMethodId:null,error:null});
  }
}
export function parsePhoneMethods(source:string):AppleVerificationMethod[]{
  const values:unknown[]=[];try{values.push(JSON.parse(source));}catch{for(const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)){try{values.push(JSON.parse(match[1]));}catch{/* not a JSON script */}}}
  const methods=new Map<string,AppleVerificationMethod>();
  for(const raw of values){const v=raw as Record<string,any>;const phones=v?.direct?.phoneNumberVerification?.trustedPhoneNumbers??v?.phoneNumberVerification?.trustedPhoneNumbers??v?.trustedPhoneNumbers;if(!Array.isArray(phones))continue;
    for(const phone of phones.slice(0,20)){if(!Number.isSafeInteger(phone?.id)||phone.id<1)continue;let label=String(phone.numberWithDialCode??phone.number??'受信任电话号码').replace(/[\x00-\x1f\x7f-\x9f]/g,'').slice(0,80);if(!/[•*…]/.test(label)){const digits=label.replace(/\D/g,'');label=digits?'••• '+digits.slice(-2):'受信任电话号码';}const id='sms:'+phone.id;methods.set(id,{id,kind:'sms',label});}
  }return [...methods.values()];
}
