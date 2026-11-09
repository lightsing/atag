// Test-only Apple peer. Never imported by product code or present as a UI data source.
// Server SRP math uses Node crypto independently of the browser SRP implementation.
import {createHash,createHmac,pbkdf2Sync,createCipheriv,timingSafeEqual} from 'node:crypto';
import {decodePlist,encodePlist} from '../lib/auth/plist.ts';
import {readFileSync} from 'node:fs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/apple-srp.json',import.meta.url)));
// Older independent vectors omit N; use the RFC5054 2048-bit group.
export const GROUP=fixture.vectors[0].N?BigInt('0x'+fixture.vectors[0].N):BigInt('0xAC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050A37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B855F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB694B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73');
const hash=(...chunks)=>createHash('sha256').update(Buffer.concat(chunks.map(b=>Buffer.from(b)))).digest();
const hmac=(key,text)=>createHmac('sha256',key).update(text).digest();
const integer=bytes=>BigInt('0x'+Buffer.from(bytes).toString('hex'));
const bytes=(n,length)=>Buffer.from(n.toString(16).padStart(length?length*2:Math.ceil(n.toString(16).length/2)*2,'0'),'hex');
const pow=(base,exponent)=>{let out=1n;base%=GROUP;while(exponent){if(exponent&1n)out=out*base%GROUP;base=base*base%GROUP;exponent>>=1n;}return out;};
const response=(value,status=200)=>({status,headers:{'content-type':'text/x-xml-plist'},bodyBase64:Buffer.from(encodePlist(value)).toString('base64')});
const empty=()=>({status:204,headers:{},bodyBase64:''});
export class AppleUpstreamFixture{
  constructor(options={}){this.options={twoFactor:true,trusted:true,password:'test-password-only',...options};this.rounds=new Map();this.verified=false;this.requests=[];this.starts=0;this.sends=0;this.delegates=0;this.saved=[];this.release=null;}
  async getAnisette(){return {headers:{'x-apple-i-md':'synthetic-otp','x-apple-i-md-m':'synthetic-machine','x-apple-i-client-time':new Date().toISOString(),'x-mme-device-id':'synthetic-id'},clientInfo:'<Synthetic Test Client>',userAgent:'SyntheticAuth/1'};}
  async forwardApple(request){
    this.requests.push(structuredClone(request));
    if(this.options.hold===request.endpoint)await new Promise(resolve=>{this.release=resolve;});
    const body=request.bodyBase64?new Uint8Array(Buffer.from(request.bodyBase64,'base64')):new Uint8Array();
    if(request.endpoint==='gsa'){
      const parameters=decodePlist(body).Request;
      if(parameters.o==='init'){
        this.starts++;const username=parameters.u,salt=Buffer.from('000102030405060708090a0b0c0d0e0f','hex'),a=Buffer.from(parameters.A2k),A=integer(a),b=BigInt('0x'+'42'.repeat(32));
        const derived=pbkdf2Sync(hash(Buffer.from(this.options.password)),salt,4096,32,'sha256'),x=integer(hash(salt,hash(Buffer.from(':'),derived))),v=pow(2n,x);
        const k=integer(hash(bytes(GROUP,256),bytes(2n,256))),B=(k*v+pow(2n,b))%GROUP,u=integer(hash(bytes(A,256),bytes(B,256)));
        const K=hash(bytes(pow(A*pow(v,u)%GROUP,b))),xor=hash(bytes(GROUP,256)),hg=hash(bytes(2n,256));for(let i=0;i<32;i++)xor[i]^=hg[i];
        const m1=hash(xor,hash(Buffer.from(username)),salt,a,bytes(B),K),m2=hash(a,m1,K),cookie='round-'+this.starts;
        this.rounds.set(cookie,{m1,m2,K});return response({Response:{Status:{ec:0},s:new Uint8Array(salt),i:4096,sp:'s2k',B:new Uint8Array(bytes(B)),c:cookie}});
      }
      const round=this.rounds.get(parameters.c);if(!round||parameters.M1.length!==32||!timingSafeEqual(Buffer.from(parameters.M1),round.m1))return response({Response:{Status:{ec:-20101}}});
      const needs=this.options.twoFactor&&!this.verified,kind=this.options.extraAction?'accountRepair':needs?(this.options.trusted?'trustedDeviceSecondaryAuth':'secondaryAuth'):null;
      const spd=encodePlist(kind?{adsid:'12345',GsIdmsToken:'synthetic-idms'}:{adsid:'12345',t:this.options.missingPet?{}:{'com.apple.gs.idms.pet':{token:'synthetic-pet'}}});
      const cipher=createCipheriv('aes-256-cbc',hmac(round.K,'extra data key:'),hmac(round.K,'extra data iv:').subarray(0,16));
      const encrypted=Buffer.concat([cipher.update(spd),cipher.final()]),m2=Buffer.from(round.m2);if(this.options.badM2)m2[0]^=1;
      return response({Response:{Status:{ec:0,...(kind?{au:kind}:{})},M2:new Uint8Array(m2),spd:new Uint8Array(encrypted)}});
    }
    if(request.endpoint==='methods')return {status:200,headers:{'content-type':'text/html'},bodyBase64:Buffer.from('<html><script class="boot_args">'+JSON.stringify({direct:{phoneNumberVerification:{trustedPhoneNumbers:[{id:7,numberWithDialCode:'+1 ••• ••42'}]}}})+'</script></html>').toString('base64')};
    if(['trusted_request','sms_request'].includes(request.endpoint)){this.sends++;return empty();}
    if(['trusted_submit','sms_submit'].includes(request.endpoint)){
      const code=request.endpoint==='trusted_submit'?request.headers['security-code']:JSON.parse(Buffer.from(body).toString()).securityCode.code;
      if(code!=='012345')return request.endpoint==='trusted_submit'?response({ec:-21669}):{status:400,headers:{},bodyBase64:Buffer.from('{"serviceErrors":[{}]}').toString('base64')};
      this.verified=true;return request.endpoint==='trusted_submit'?response({ec:0}):empty();
    }
    if(request.endpoint==='mobileme'){
      this.delegates++;const value=decodePlist(body);if(value.password!=='synthetic-pet')throw new Error('raw password reached delegate');
      return response({dsid:'12345',status:0,delegates:{'com.apple.mobileme':{status:this.options.badDelegate?-1:0,'service-data':{tokens:{searchPartyToken:'synthetic-query-session'}}}}});
    }
    if(request.endpoint==='findmy')return {status:200,headers:{},bodyBase64:Buffer.from('{"acsnLocations":{"statusCode":"200","locationPayload":[]}}').toString('base64')};
    throw new Error('unexpected test endpoint');
  }
}
