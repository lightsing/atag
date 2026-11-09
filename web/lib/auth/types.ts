export type AppleLoginPhase = 'idle'|'authenticating'|'choose_method'|'sending_code'|'awaiting_code'|'verifying'|'saving'|'complete'|'error'|'expired';
export interface AppleVerificationMethod { id:string; kind:'trusted_device'|'sms'; label:string }
export interface AppleLoginSnapshot {
  phase:AppleLoginPhase; busy:boolean; progress:string|null; accountLabel:string|null;
  methods:AppleVerificationMethod[]; selectedMethodId:string|null; expiresAt:string|null;
  attemptsRemaining:number; sendsRemaining:number; error:{code:string;message:string;credentialsRejected?:boolean}|null;
}
export interface AppleLoginInput { username:string;password:string;anisetteSource?:string;clientProfile?:'auto'|'macos'|'windows' }
export const idleLogin = ():AppleLoginSnapshot => ({phase:'idle',busy:false,progress:null,accountLabel:null,methods:[],selectedMethodId:null,expiresAt:null,attemptsRemaining:3,sendsRemaining:5,error:null});
export type AppleEndpoint = 'gsa'|'mobileme'|'methods'|'sms_request'|'sms_submit'|'trusted_request'|'trusted_submit'|'findmy';
export interface AppleRelayRequest {endpoint:AppleEndpoint;method:'GET'|'POST'|'PUT';headers:Record<string,string>;bodyBase64?:string}
export interface AppleRelayResponse {status:number;bodyBase64:string;headers:Record<string,string>}
export interface AnisetteResponse {headers:Record<string,string>;clientInfo:string;userAgent:string}
export interface AppleTransport {
  getAnisette(source:string,uid:string,deviceId:string,clientProfile:'auto'|'macos'|'windows',signal?:AbortSignal):Promise<AnisetteResponse>;
  forwardApple(request:AppleRelayRequest,signal?:AbortSignal):Promise<AppleRelayResponse>;
}
