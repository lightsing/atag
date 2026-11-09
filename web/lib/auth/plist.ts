import {base64,unbase64} from '../workspace/crypto.ts';
export type Plist = string|number|bigint|boolean|Uint8Array|Plist[]|{[key:string]:Plist};
export const protocolError=()=>new Error('Apple 登录响应无效或未通过验证，未保存登录。');
export const dict=(value:Plist):Record<string,Plist>=>{if(!value||typeof value!=='object'||Array.isArray(value)||value instanceof Uint8Array)throw protocolError();return value;};
export const text=(value:Plist|undefined):string=>{if(typeof value!=='string'||!value)throw protocolError();return value;};
export const data=(value:Plist|undefined):Uint8Array=>{if(!(value instanceof Uint8Array))throw protocolError();return value;};
export const identifier=(value:Plist|undefined):string=>{if(typeof value==='string'&&value)return value;if((typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)||typeof value==='bigint')return String(value);throw protocolError();};
const escape=(value:string)=>value.replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]!));
export function encodePlist(value:Plist):Uint8Array{
  const encode=(v:Plist):string=>{
    if(v instanceof Uint8Array)return `<data>${base64(v)}</data>`;
    if(Array.isArray(v))return `<array>${v.map(encode).join('')}</array>`;
    if(v&&typeof v==='object')return `<dict>${Object.entries(v).map(([k,x])=>`<key>${escape(k)}</key>${encode(x)}`).join('')}</dict>`;
    if(typeof v==='boolean')return v?'<true/>':'<false/>';
    if(typeof v==='bigint'||typeof v==='number'&&Number.isInteger(v))return `<integer>${v}</integer>`;
    if(typeof v==='number'&&Number.isFinite(v))return `<real>${v}</real>`;
    if(typeof v==='string')return `<string>${escape(v)}</string>`;throw protocolError();
  };
  // GrandSlam expects Apple's plist envelope, including the standard DOCTYPE.
  return new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${encode(value)}</plist>\n`);
}
export function decodePlist(bytes:Uint8Array):Plist{
  if(bytes.length===0||bytes.length>1024*1024)throw protocolError();
  if(new TextDecoder().decode(bytes.slice(0,8))==='bplist00')return decodeBinary(bytes);
  const xml=new TextDecoder('utf-8',{fatal:true}).decode(bytes).trim();
  // No custom entities or remote DTDs; Apple's standard plist DOCTYPE has no entity subset.
  if(/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(xml))throw protocolError();
  const document=new DOMParser().parseFromString(xml,'application/xml');
  if(document.getElementsByTagName('parsererror').length)throw protocolError();
  const children=(element:Element)=>Array.from(element.childNodes).filter(n=>n.nodeType===1) as Element[];
  let count=0;
  const read=(element:Element,depth=0):Plist=>{
    if(depth>32||++count>10000)throw protocolError();const content=element.textContent??'';
    switch(element.tagName){
      case 'plist':{const list=children(element);if(list.length!==1)throw protocolError();return read(list[0],depth+1);}
      case 'dict':{const list=children(element);if(list.length%2)throw protocolError();const result:Record<string,Plist>=Object.create(null);for(let i=0;i<list.length;i+=2){if(list[i].tagName!=='key')throw protocolError();const key=list[i].textContent??'';if(Object.hasOwn(result,key))throw protocolError();result[key]=read(list[i+1],depth+1);}return result;}
      case 'array':return children(element).map(e=>read(e,depth+1));
      case 'string':case 'date':return content;
      case 'integer':{if(!/^-?\d+$/.test(content.trim()))throw protocolError();const n=BigInt(content.trim());return n>=Number.MIN_SAFE_INTEGER&&n<=Number.MAX_SAFE_INTEGER?Number(n):n;}
      case 'real':{const n=Number(content);if(!Number.isFinite(n))throw protocolError();return n;}
      case 'data':return unbase64(content.replace(/\s/g,''));
      case 'true':return true;case 'false':return false;default:throw protocolError();
    }
  };
  if(!document.documentElement)throw protocolError();return read(document.documentElement);
}
function decodeBinary(bytes:Uint8Array):Plist{
  if(bytes.length<40)throw protocolError();const trailer=bytes.length-32,view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const uint=(offset:number,size:number):number=>{if(size<1||size>8||offset<0||offset+size>bytes.length)throw protocolError();let n=0n;for(let i=0;i<size;i++)n=n*256n+BigInt(bytes[offset+i]);if(n>BigInt(Number.MAX_SAFE_INTEGER))throw protocolError();return Number(n);};
  const offsetSize=bytes[trailer+6],refSize=bytes[trailer+7],count=uint(trailer+8,8),root=uint(trailer+16,8),table=uint(trailer+24,8);
  if(count<1||count>10000||root>=count||table<8||table+count*offsetSize>trailer||refSize<1||refSize>6)throw protocolError();
  const active=new Set<number>();let visited=0;
  const read=(index:number,depth=0):Plist=>{
    if(depth>32||index>=count||active.has(index)||++visited>20000)throw protocolError();active.add(index);
    try{
      let pos=uint(table+index*offsetSize,offsetSize);if(pos<8||pos>=table)throw protocolError();const marker=bytes[pos++],kind=marker>>4;let length=marker&15;
      if(length===15){const tag=bytes[pos++];if(tag>>4!==1||(tag&15)>3)throw protocolError();const size=2**(tag&15);length=uint(pos,size);pos+=size;}
      const bound=(n:number)=>{if(!Number.isSafeInteger(n)||n<0||pos+n>table)throw protocolError();};
      if(kind===0){if(marker===8)return false;if(marker===9)return true;throw protocolError();}
      if(kind===1){const size=2**(marker&15);bound(size);if(size>8)throw protocolError();let n=0n;for(let i=0;i<size;i++)n=n*256n+BigInt(bytes[pos+i]);if(size===8)n=BigInt.asIntN(64,n);return n>=Number.MIN_SAFE_INTEGER&&n<=Number.MAX_SAFE_INTEGER?Number(n):n;}
      if(kind===2){const size=2**(marker&15);bound(size);if(size!==4&&size!==8)throw protocolError();const n=size===4?view.getFloat32(pos):view.getFloat64(pos);if(!Number.isFinite(n))throw protocolError();return n;}
      if(kind===3){bound(8);return new Date((view.getFloat64(pos)+978307200)*1000).toISOString();}
      if(kind===4){bound(length);return bytes.slice(pos,pos+length);}
      if(kind===5){bound(length);return new TextDecoder('utf-8',{fatal:true}).decode(bytes.slice(pos,pos+length));}
      if(kind===6){bound(length*2);let s='';for(let i=0;i<length;i++)s+=String.fromCharCode(view.getUint16(pos+i*2));return s;}
      if(kind===10){bound(length*refSize);return Array.from({length},(_,i)=>read(uint(pos+i*refSize,refSize),depth+1));}
      if(kind===13){bound(length*refSize*2);const result:Record<string,Plist>=Object.create(null);for(let i=0;i<length;i++){const key=read(uint(pos+i*refSize,refSize),depth+1);if(typeof key!=='string'||Object.hasOwn(result,key))throw protocolError();result[key]=read(uint(pos+(length+i)*refSize,refSize),depth+1);}return result;}
      throw protocolError();
    }finally{active.delete(index);}
  };
  return read(root);
}
