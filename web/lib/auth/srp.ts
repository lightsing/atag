import {sha256} from '@noble/hashes/sha2.js';
import {hmac} from '@noble/hashes/hmac.js';
import {bytesToBig,bigToBytes,concat} from '../workspace/crypto.ts';
import {decodePlist,protocolError,type Plist} from './plist.ts';
export const MODULUS_HEX='AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050A'+
 '37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50'+
 'E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B8'+
 '55F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773B'+
 'CA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748'+
 '544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6'+
 'AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB6'+
 '94B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73';
export const N=BigInt('0x'+MODULUS_HEX);
const G=2n, utf8=(s:string)=>new TextEncoder().encode(s), hash=(...chunks:Uint8Array[])=>sha256(concat(...chunks));
const trim=(bytes:Uint8Array)=>bytes.slice(Math.max(0,bytes.findIndex(x=>x!==0)));
/** Fixed public iteration bound; JS BigInt itself is not a constant-time primitive. */
export function modPow(base:bigint,exponent:bigint,bits:number):bigint{
  let result=1n; base=(base%N+N)%N;
  for(let i=bits-1;i>=0;i--){const square=result*result%N,multiply=square*base%N,mask=-((exponent>>BigInt(i))&1n);result=(multiply&mask)|(square&~mask);}
  return result;
}
export class AppleSrpClient{
  #secret:bigint;
  readonly publicKey:Uint8Array;
  constructor(secret?:Uint8Array){
    const random=secret?new Uint8Array(secret):crypto.getRandomValues(new Uint8Array(32));
    if(random.length!==32)throw protocolError();if(!secret)random[0]|=0x80;
    this.#secret=bytesToBig(random);random.fill(0);if(this.#secret===0n)throw protocolError();
    this.publicKey=trim(bigToBytes(modPow(G,this.#secret,256),256));
  }
  destroy(){this.#secret=0n;}
  async challenge(username:string,passwordHash:Uint8Array,salt:Uint8Array,iterations:number,protocol:string,serverPublic:Uint8Array):Promise<AppleSrpProof>{
    if(passwordHash.length!==32||!Number.isInteger(iterations)||iterations<1||iterations>1_000_000||salt.length<1||salt.length>64||serverPublic.length<1||serverPublic.length>256)throw protocolError();
    const B=bytesToBig(serverPublic);if(B===0n||B>=N)throw protocolError();
    const input=protocol==='s2k'?new Uint8Array(passwordHash):protocol==='s2k_fo'?utf8(Array.from(passwordHash,b=>b.toString(16).padStart(2,'0')).join('')):null;
    if(!input)throw protocolError();
    try{
      const imported=await crypto.subtle.importKey('raw',new Uint8Array(input),'PBKDF2',false,['deriveBits']);
      const derived=new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:new Uint8Array(salt),iterations},imported,256));
      const inner=hash(utf8(':'),derived);derived.fill(0);const x=bytesToBig(hash(salt,inner));inner.fill(0);
      const padN=bigToBytes(N,256),padG=bigToBytes(G,256),padB=bigToBytes(B,256);
      const k=bytesToBig(hash(padN,padG)),u=bytesToBig(hash(bigToBytes(bytesToBig(this.publicKey),256),padB));if(u===0n)throw protocolError();
      const base=((B-k*modPow(G,x,256))%N+N)%N;if(base===0n)throw protocolError();
      const shared=trim(bigToBytes(modPow(base,this.#secret+u*x,513),256)),key=hash(shared);shared.fill(0);this.destroy();
      const xor=hash(padN),gHash=hash(padG);for(let i=0;i<xor.length;i++)xor[i]^=gHash[i];
      const m1=hash(xor,hash(utf8(username)),salt,this.publicKey,trim(padB),key),m2=hash(this.publicKey,m1,key);
      return new AppleSrpProof(m1,m2,key);
    }finally{input.fill(0);this.destroy();}
  }
}
export class AppleSrpProof{
  readonly clientProof:Uint8Array;
  #expected:Uint8Array;
  #key:Uint8Array;
  constructor(clientProof:Uint8Array,expected:Uint8Array,key:Uint8Array){this.clientProof=clientProof;this.#expected=expected;this.#key=key;}
  destroy(){this.#expected.fill(0);this.#key.fill(0);}
  async decrypt(serverProof:Uint8Array,encrypted:Uint8Array):Promise<Plist>{
    let diff=serverProof.length^32;for(let i=0;i<32;i++)diff|=(serverProof[i]??0)^this.#expected[i];
    if(diff!==0||encrypted.length===0||encrypted.length>1024*1024){this.destroy();throw protocolError();}
    const key=hmac(sha256,this.#key,utf8('extra data key:')),iv=hmac(sha256,this.#key,utf8('extra data iv:')).slice(0,16);
    try{const imported=await crypto.subtle.importKey('raw',new Uint8Array(key),'AES-CBC',false,['decrypt']);const plaintext=new Uint8Array(await crypto.subtle.decrypt({name:'AES-CBC',iv:new Uint8Array(iv)},imported,new Uint8Array(encrypted)));try{return decodePlist(plaintext);}finally{plaintext.fill(0);}}
    catch{throw protocolError();}finally{key.fill(0);iv.fill(0);this.destroy();}
  }
}
