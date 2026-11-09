import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DOMParser} from '@xmldom/xmldom';
import {sha256} from '@noble/hashes/sha2.js';
import {AppleSrpClient} from '../lib/auth/srp.ts';
import {BrowserAppleLogin,parsePhoneMethods} from '../lib/auth/apple-login.ts';
import {decodePlist,encodePlist} from '../lib/auth/plist.ts';
import {AppleUpstreamFixture} from './apple-upstream-fixture.mjs';
import {BrowserWorkspaceClient} from '../lib/workspace/browser-workspace-client.ts';
import {MemoryWorkspaceStore} from '../lib/workspace/store.ts';
import {ClientError} from '../lib/client-support.ts';
globalThis.DOMParser=DOMParser;
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/apple-srp.json',import.meta.url)));
const hex=s=>new Uint8Array(Buffer.from(s,'hex'));
const input={username:'alice@example.test',password:'test-password-only',anisetteSource:'local'};
function setup(t,options={}){
  const peer=new AppleUpstreamFixture(options),saved=[];
  const login=new BrowserAppleLogin(()=>peer,async(account,source,signal)=>{assert.equal(signal.aborted,false);saved.push({account,source});});
  t.after(()=>login.cancel());return {peer,login,saved};
}

test('browser Apple SRP/CBC matches independent pysrp/Python vectors for both password protocols',async()=>{
  for(const v of fixtures.vectors){
    const client=new AppleSrpClient(hex(v.client_a));assert.equal(Buffer.from(client.publicKey).toString('hex'),v.A);
    const proof=await client.challenge(v.username,sha256(new TextEncoder().encode(v.password)),hex(v.salt),v.iterations,v.protocol,hex(v.B));
    assert.equal(Buffer.from(proof.clientProof).toString('hex'),v.m1);
    assert.equal((await proof.decrypt(hex(v.m2),new Uint8Array(Buffer.from(v.spd_base64,'base64')))).adsid,'12345');
    const invalid=new AppleSrpClient(hex(v.client_a));const bad=await invalid.challenge(v.username,sha256(new TextEncoder().encode(v.password)),hex(v.salt),v.iterations,v.protocol,hex(v.B));
    await assert.rejects(bad.decrypt(new Uint8Array(32),new Uint8Array(Buffer.from(v.spd_base64,'base64'))));
  }
});
test('unsafe SRP groups, excessive work and unknown password schemes are rejected',async()=>{
  const v=fixtures.vectors[0];for(const [iterations,protocol,B]of [[0,'s2k',hex(v.B)],[1000001,'s2k',hex(v.B)],[1,'unknown',hex(v.B)],[1,'s2k',new Uint8Array([0])]]){
    const client=new AppleSrpClient(hex(v.client_a));await assert.rejects(client.challenge(v.username,new Uint8Array(32),hex(v.salt),iterations,protocol,B));client.destroy();
  }
});
test('plist parser supports bare/XML/binary data, unicode and negative status codes',()=>{
  const value={name:'验证码',status:0,negative:-21669,blob:Uint8Array.of(0,1,2),flags:[true,false]};
  const decoded=decodePlist(encodePlist(value));assert.equal(decoded.name,value.name);assert.deepEqual(decoded.blob,value.blob);
  assert.equal(decodePlist(new TextEncoder().encode('<dict><key>ec</key><integer>0</integer></dict>')).ec,0);
  const binary=JSON.parse(readFileSync(new URL('./fixtures/apple-binary-plist.json',import.meta.url)));const parsed=decodePlist(new Uint8Array(Buffer.from(binary.base64,'base64')));
  assert.equal(parsed.adsid,binary.expected.adsid);assert.equal(parsed.negative,binary.expected.negative);assert.equal(parsed.unicode,binary.expected.unicode);
  assert.throws(()=>decodePlist(new TextEncoder().encode('<!DOCTYPE plist [<!ENTITY x "secret">]><plist><string>&x;</string></plist>')));
});
test('outgoing Apple plist includes the standard document type accepted by GrandSlam',()=>{
  const wire=encodePlist({Header:{Version:'1.0.1'},Request:{o:'init',cpd:{bootstrap:true},A2k:Uint8Array.of(0,1,2)}});
  const document=new DOMParser().parseFromString(new TextDecoder().decode(wire),'application/xml');
  assert.equal(document.doctype?.name,'plist');
  assert.equal(document.doctype?.publicId.replace(/^["']|["']$/g,''),'-//Apple//DTD PLIST 1.0//EN');
  assert.equal(document.doctype?.systemId.replace(/^["']|["']$/g,''),'http://www.apple.com/DTDs/PropertyList-1.0.dtd');
  assert.equal(decodePlist(wire).Request.o,'init');
});
test('a complete browser login saves only query material; raw password/hash never enter relay or snapshot',async t=>{
  const {login,peer,saved}=setup(t,{twoFactor:false});await login.start(input);
  assert.equal(login.snapshot().phase,'complete');assert.equal(saved.length,1);assert.equal(saved[0].account.searchPartyToken,'synthetic-query-session');assert.equal(saved[0].source,'local');
  const wire=JSON.stringify(peer.requests);assert.ok(!wire.includes(input.password));assert.ok(!wire.includes(Buffer.from(input.password).toString('base64')));
  assert.ok(!wire.includes(Buffer.from(sha256(new TextEncoder().encode(input.password))).toString('base64')));
  assert.ok(!JSON.stringify(login.snapshot()).includes('synthetic-query-session'));assert.equal(peer.delegates,1);
});
test('login progress identifies each active step and clears when waiting, complete or cancelled',async t=>{
  const {login,saved}=setup(t),snapshots=[];
  const unsubscribe=login.subscribe(state=>snapshots.push(state));
  t.after(unsubscribe);
  await login.start(input);
  assert.equal(login.snapshot().progress,null);
  await login.requestCode('trusted');
  assert.equal(login.snapshot().progress,null);
  await login.submitCode('012345');
  assert.equal(login.snapshot().progress,null);
  assert.equal(saved.length,1);
  for(const step of ['机器认证','登录初始化','密码验证','获取验证方式','发送受信任设备验证码','验证受信任设备验证码','Find My 会话授权','保存登录']){
    assert.ok(snapshots.some(state=>state.busy&&state.progress?.includes(step)),step);
  }
  assert.ok(snapshots.every(state=>state.busy||state.progress===null));
  assert.ok(!JSON.stringify(snapshots).includes(input.password));
  login.cancel();
  assert.equal(login.snapshot().progress,null);
});

test('machine timeouts identify preparation before any Apple request or partial save',async t=>{
  const {login,peer,saved}=setup(t);
  peer.getAnisette=async()=>{throw new ClientError('TIMEOUT','private transport detail',{status:504});};
  await assert.rejects(login.start(input),error=>error.code==='TIMEOUT'&&error.status===504&&error.message.includes('机器认证（Anisette）'));
  assert.equal(peer.requests.length,0);
  assert.equal(saved.length,0);
  assert.equal(login.snapshot().phase,'error');
  assert.equal(login.snapshot().progress,null);
  assert.ok(!JSON.stringify(login.snapshot()).includes('private transport detail'));
});
test('MobileMe uses accountsd/iCloudHelper while keeping the official v3 Mac identity',async t=>{
  const {login,peer,saved}=setup(t,{twoFactor:false});
  const headers={'x-apple-i-md':'synthetic-otp','x-apple-i-md-m':'synthetic-machine','x-apple-i-md-lu':Buffer.from('synthetic-local-user').toString('base64'),'x-mme-device-id':'synthetic-machine-device'};
  peer.getAnisette=async()=>({headers,clientInfo:'<MacBookPro13,2> <macOS;13.1;22C65> <com.apple.AuthKit/1 (com.apple.akd/1.0)>',userAgent:'akd/1.0 CFNetwork/1404.0.5 Darwin/22.2.0'});
  await login.start({...input,anisetteSource:'sidestore'});
  const gsa=peer.requests.find(r=>r.endpoint==='gsa'),mobileme=peer.requests.find(r=>r.endpoint==='mobileme');
  assert.equal(gsa.headers['X-MMe-Client-Info'],'<MacBookPro13,2> <macOS;13.1;22C65> <com.apple.AuthKit/1 (com.apple.akd/1.0)>');
  assert.equal(mobileme.headers['X-Mme-Client-Info'],'<MacBookPro13,2> <macOS;13.1;22C65> <com.apple.AOSKit/282 (com.apple.accountsd/113)>');
  assert.equal(mobileme.headers['User-Agent'],'com.apple.iCloudHelper/282 CFNetwork/1404.0.5 Darwin/22.2.0');
  for(const [name,value]of Object.entries(headers))assert.equal(mobileme.headers[name],value);
  assert.equal(decodePlist(new Uint8Array(Buffer.from(mobileme.bodyBase64,'base64')))['client-id'],'synthetic-local-user');
  assert.equal(saved[0].account.uid,'synthetic-local-user');assert.equal(saved[0].account.deviceId,'synthetic-machine-device');
  assert.equal(saved[0].source,'sidestore');
});
test('the v3 hash identifier is retained and a changing machine aborts login before authorization',async t=>{
  for(const changes of [false,true]){
    const {login,peer,saved}=setup(t,{twoFactor:false});let calls=0;
    peer.getAnisette=async()=>({headers:{'x-apple-i-md':'synthetic-otp','x-apple-i-md-m':'synthetic-machine','x-apple-i-md-lu':'a'.repeat(64),'x-mme-device-id':changes&&++calls>1?'changed-device':'stable-device'},clientInfo:'synthetic-client',userAgent:'synthetic-agent'});
    if(changes){
      await assert.rejects(login.start({...input,anisetteSource:'sidestore'}),error=>error.message.includes('机器身份一致性'));
      assert.equal(peer.delegates,0);assert.equal(saved.length,0);
    }else{
      await login.start({...input,anisetteSource:'sidestore'});
      const request=peer.requests.find(r=>r.endpoint==='mobileme');
      assert.equal(decodePlist(new Uint8Array(Buffer.from(request.bodyBase64,'base64')))['client-id'],'a'.repeat(64));
      assert.equal(saved[0].account.uid,'a'.repeat(64));assert.equal(saved[0].account.deviceId,'stable-device');
    }
  }
});
test('a top-level delegate refusal is reported before accessing missing service data',async t=>{
  const {login,peer,saved}=setup(t,{twoFactor:false});const forward=peer.forwardApple.bind(peer);
  peer.forwardApple=async request=>request.endpoint==='mobileme'?{status:200,headers:{},bodyBase64:Buffer.from(encodePlist({status:1,localizedError:'UNAUTHORIZED',description:'private-upstream-detail'})).toString('base64')}:forward(request);
  await assert.rejects(login.start(input),error=>error.code==='AUTH_REQUIRED'&&error.message.includes('未授予 Find My'));
  assert.equal(saved.length,0);assert.ok(!JSON.stringify(login.snapshot()).includes('private-upstream-detail'));
});
test('Apple HTTP failures identify the login step without displaying response bodies or saving an account',async t=>{
  for(const [failedStep,status,stage] of [['init',503,'登录初始化'],['complete',404,'密码验证'],['mobileme',502,'Find My 会话授权']]){
    const {login,peer,saved}=setup(t,{twoFactor:false});
    const forward=peer.forwardApple.bind(peer);
    peer.forwardApple=async(request)=>{
      const operation=request.endpoint==='gsa'?decodePlist(new Uint8Array(Buffer.from(request.bodyBase64,'base64'))).Request.o:request.endpoint;
      if(operation===failedStep)return {status,headers:{'content-type':'text/html'},bodyBase64:Buffer.from('<html>private upstream detail</html>').toString('base64')};
      return forward(request);
    };
    await assert.rejects(login.start(input),error=>{
      assert.equal(error.code,'UPSTREAM_UNAVAILABLE');
      assert.equal(error.status,status);
      assert.equal(error.retryable,status>=500);
      assert.ok(error.message.includes(stage));
      assert.ok(error.message.includes(`HTTP ${status}`));
      return true;
    });
    assert.equal(login.snapshot().phase,'error');
    assert.equal(login.snapshot().error.credentialsRejected,undefined);
    assert.equal(saved.length,0);
    assert.ok(!JSON.stringify(login.snapshot()).includes('private upstream detail'));
  }
});
test('Apple machine-authentication refusals retain the error code without presenting them as password failures',async t=>{
  for(const ec of [-80045,-80046,-23782]){
    const {login,peer,saved}=setup(t);
    peer.forwardApple=async()=>({status:200,headers:{},bodyBase64:Buffer.from(encodePlist({Response:{Status:{ec,em:'private upstream detail'}}})).toString('base64')});
    await assert.rejects(login.start(input),error=>{
      assert.equal(error.code,'UPSTREAM_UNAVAILABLE');
      assert.equal(error.retryable,false);
      assert.ok(error.message.includes(String(ec)));
      assert.ok(error.message.includes('Anisette'));
      return true;
    });
    assert.equal(saved.length,0);
    assert.equal(login.snapshot().error.credentialsRejected,undefined);
    assert.ok(!JSON.stringify(login.snapshot()).includes('private upstream detail'));
  }
});
test('Apple transport failures name the failed login step without resubmitting',async t=>{
  for(const [failedStep,stage,status]of [['init','登录初始化',504],['complete','密码验证',504],['complete','密码验证',502],['mobileme','Find My 会话授权',504]]){
    const code=status===504?'TIMEOUT':'UPSTREAM_UNAVAILABLE';
    const {login,peer,saved}=setup(t,{twoFactor:false});let calls=0;
    const forward=peer.forwardApple.bind(peer);
    peer.forwardApple=async request=>{
      const operation=request.endpoint==='gsa'?decodePlist(new Uint8Array(Buffer.from(request.bodyBase64,'base64'))).Request.o:request.endpoint;
      if(operation===failedStep){calls++;throw new ClientError(code,'private transport detail',{status});}
      return forward(request);
    };
    await assert.rejects(login.start(input),error=>error.code===code&&error.status===status&&error.message.includes(stage));
    assert.equal(calls,1);assert.equal(saved.length,0);assert.ok(!JSON.stringify(login.snapshot()).includes('private transport detail'));
    assert.equal(login.snapshot().error.credentialsRejected,undefined);
  }
});
test('a timeout can be retried with a fresh exchange and the same password without an automatic replay',async t=>{
  const {login,peer,saved}=setup(t,{twoFactor:false});
  const forward=peer.forwardApple.bind(peer);
  let failed=false,proofs=0;
  peer.forwardApple=async request=>{
    const operation=request.endpoint==='gsa'?decodePlist(new Uint8Array(Buffer.from(request.bodyBase64,'base64'))).Request.o:request.endpoint;
    if(operation==='complete'){
      proofs++;
      if(!failed){failed=true;throw new ClientError('TIMEOUT',undefined,{status:504});}
    }
    return forward(request);
  };
  await assert.rejects(login.start(input),{code:'TIMEOUT'});
  assert.equal(login.snapshot().error.credentialsRejected,undefined);
  assert.equal(proofs,1);assert.equal(saved.length,0);
  await login.start(input);
  assert.equal(login.snapshot().phase,'complete');
  assert.equal(peer.starts,2);assert.equal(proofs,2);assert.equal(saved.length,1);
});
test('trusted-device verification is explicit, rejects bad code, preserves leading zero and performs fresh SRP',async t=>{
  const {login,peer,saved}=setup(t);await login.start(input);assert.equal(login.snapshot().phase,'choose_method');assert.equal(peer.sends,0);
  assert.deepEqual(login.snapshot().methods.map(m=>m.id),['trusted','sms:7']);
  await login.requestCode('trusted');assert.equal(login.snapshot().phase,'awaiting_code');
  await assert.rejects(login.submitCode('000000'));assert.equal(login.snapshot().phase,'awaiting_code');assert.equal(login.snapshot().attemptsRemaining,2);assert.equal(saved.length,0);
  assert.equal(login.snapshot().error.credentialsRejected,undefined);
  await login.submitCode('012345');assert.equal(login.snapshot().phase,'complete');assert.equal(peer.starts,2);assert.equal(saved.length,1);
});
test('each SRP exchange shares one OTP and request UUID, with fresh values after 2FA',async t=>{
  const {login,peer,saved}=setup(t);let issued=0;
  const anisette=peer.getAnisette.bind(peer);
  peer.getAnisette=async()=>{const reply=await anisette();reply.headers['x-apple-i-md']=`synthetic-otp-${++issued}`;return reply;};
  await login.start(input);await login.requestCode('trusted');await login.submitCode('012345');
  const cpd=peer.requests.filter(r=>r.endpoint==='gsa').map(r=>decodePlist(new Uint8Array(Buffer.from(r.bodyBase64,'base64'))).Request.cpd);
  assert.equal(cpd.length,4);assert.deepEqual(cpd[0],cpd[1]);assert.deepEqual(cpd[2],cpd[3]);
  assert.match(cpd[0]['X-Apple-I-Request-UUID'],/^[A-F0-9]{8}-[A-F0-9]{4}-4[A-F0-9]{3}-[89AB][A-F0-9]{3}-[A-F0-9]{12}$/);
  assert.notEqual(cpd[0]['X-Apple-I-Request-UUID'],cpd[2]['X-Apple-I-Request-UUID']);
  assert.notEqual(cpd[0]['X-Apple-I-MD'],cpd[2]['X-Apple-I-MD']);assert.equal(saved.length,1);
});
test('SMS method and resend work; no fabricated verification methods are accepted',async t=>{
  const {login,peer,saved}=setup(t,{trusted:false});await login.start(input);assert.equal(login.snapshot().methods[0].id,'sms:7');
  await assert.rejects(login.requestCode('sms:8'));assert.equal(peer.sends,0);
  await login.requestCode('sms:7');await login.requestCode('sms:7');assert.equal(peer.sends,2);assert.equal(login.snapshot().sendsRemaining,3);
  await login.submitCode('012345');assert.equal(saved.length,1);assert.equal(peer.verified,true);
});
test('post-verification failures identify the failed stage and never save partial sessions',async t=>{
  for(const stage of ['验证码响应解析','密码验证响应解析','SRP 证明与会话解密','登录授权凭据（PET）','Find My 查询凭据（searchPartyToken）']){
    const {login,peer,saved}=setup(t,{trusted:false});
    const forward=peer.forwardApple.bind(peer);
    peer.forwardApple=async request=>{
      const response=await forward(request);
      if(stage==='验证码响应解析'&&request.endpoint==='sms_submit')return {...response,status:200,bodyBase64:Buffer.from('<private-unexpected-response/>').toString('base64')};
      if(request.endpoint==='gsa'&&peer.verified&&decodePlist(new Uint8Array(Buffer.from(request.bodyBase64,'base64'))).Request.o==='complete'){
        const value=decodePlist(new Uint8Array(Buffer.from(response.bodyBase64,'base64')));
        if(stage==='密码验证响应解析')delete value.Response.Status;
        if(stage==='SRP 证明与会话解密')value.Response.M2[0]^=1;
        return {...response,bodyBase64:Buffer.from(encodePlist(value)).toString('base64')};
      }
      if(stage==='Find My 查询凭据（searchPartyToken）'&&request.endpoint==='mobileme'){
        const value=decodePlist(new Uint8Array(Buffer.from(response.bodyBase64,'base64')));
        value.delegates['com.apple.mobileme']['service-data'].tokens={mmeAuthToken:'private-session-material'};
        return {...response,bodyBase64:Buffer.from(encodePlist(value)).toString('base64')};
      }
      return response;
    };
    // This fixture controls the encrypted SPD before its independent AES-CBC encryption.
    if(stage==='登录授权凭据（PET）')peer.options.missingPet=true;
    await login.start(input);await login.requestCode('sms:7');
    await assert.rejects(login.submitCode('012345'),error=>{
      assert.equal(error.code,'UPSTREAM_UNAVAILABLE');assert.equal(error.retryable,false);
      assert.ok(error.message.includes(stage),error.message);return true;
    });
    assert.equal(saved.length,0);assert.equal(login.snapshot().phase,'error');
    assert.ok(!JSON.stringify(login.snapshot()).includes('private-'));
  }
});
test('code sending and submission budgets are bounded',async t=>{
  const {login,peer}=setup(t);await login.start(input);for(let i=0;i<5;i++)await login.requestCode('trusted');
  await assert.rejects(login.requestCode('trusted'));assert.equal(peer.sends,5);
  for(let i=0;i<3;i++)await assert.rejects(login.submitCode('000000'));assert.equal(login.snapshot().phase,'error');assert.equal(login.snapshot().attemptsRemaining,0);
});
test('invalid password, mutual proof, extra account action and delegate refusal never replace the saved account',async t=>{
  for(const options of [{twoFactor:false,password:'different'},{twoFactor:false,badM2:true},{extraAction:true},{twoFactor:false,badDelegate:true}]){
    const {login,saved}=setup(t,options);await assert.rejects(login.start(input));assert.equal(saved.length,0);assert.equal(login.snapshot().phase,'error');
    assert.equal(login.snapshot().error.credentialsRejected,options.password?true:undefined);
  }
});
test('generic HTTP, account-state and code refusals are not password rejections',async t=>{
  for(const status of [400,401,403]){
    const {login,peer}=setup(t);
    peer.forwardApple=async()=>({status,headers:{},bodyBase64:''});
    await assert.rejects(login.start(input),{code:'AUTH_REQUIRED'});
    assert.equal(login.snapshot().error.credentialsRejected,undefined);
  }
  for(const ec of [-20209,-99999]){
    const {login,peer}=setup(t);
    peer.forwardApple=async()=>({status:200,headers:{},bodyBase64:Buffer.from(encodePlist({Response:{Status:{ec}}})).toString('base64')});
    await assert.rejects(login.start(input),{code:'AUTH_REQUIRED'});
    assert.equal(login.snapshot().error.credentialsRejected,undefined);
  }
  const {login,peer}=setup(t);await login.start(input);await login.requestCode('trusted');
  peer.forwardApple=async()=>({status:200,headers:{},bodyBase64:Buffer.from(encodePlist({Status:{ec:-20101}})).toString('base64')});
  await assert.rejects(login.submitCode('012345'),{code:'AUTH_REQUIRED'});
  assert.equal(login.snapshot().phase,'awaiting_code');
  assert.equal(login.snapshot().error.credentialsRejected,undefined);
});
test('cancelling an in-flight response prevents late requests or login persistence',async t=>{
  const {login,peer,saved}=setup(t,{twoFactor:false,hold:'gsa'});const pending=login.start(input);
  for(let i=0;!peer.release&&i<100;i++)await new Promise(r=>setTimeout(r,1));assert.ok(peer.release);login.cancel();peer.release();
  await assert.rejects(pending,{code:'CANCELLED'});assert.equal(login.snapshot().phase,'idle');assert.equal(saved.length,0);assert.equal(peer.requests.length,1);
});
test('expired challenges cannot send more codes and cleanup their secret state',async t=>{
  const {login,peer,saved}=setup(t);await login.start(input);const now=Date.now;Date.now=()=>now()+600001;
  try{await assert.rejects(login.requestCode('trusted'),{code:'AUTH_EXPIRED'});}finally{Date.now=now;}
  assert.equal(login.snapshot().phase,'expired');assert.equal(peer.sends,0);assert.equal(saved.length,0);
});
test('phone method parsing accepts Apple JSON/HTML and masks unexpected unmasked numbers',()=>{
  const methods=parsePhoneMethods(JSON.stringify({trustedPhoneNumbers:[{id:7,number:'+1 555 123 4567'},{id:7,number:'••42'},{id:-1}]}));assert.equal(methods.length,1);assert.equal(methods[0].label,'••42');
  assert.deepEqual(parsePhoneMethods('<script>alert("not data")</script>'),[]);
});

test('workspace login persists only after success, logout keeps devices, cancellation preserves the old account',async()=>{
  const original=globalThis.fetch,peer=new AppleUpstreamFixture({twoFactor:false}),store=new MemoryWorkspaceStore();
  globalThis.fetch=async(url,init)=>{
    if(url.endsWith('/health'))return Response.json({protocolVersion:1,agentVersion:'test',capabilities:{anisette:true,appleRelay:true}});
    if(url.endsWith('/anisette'))return Response.json(await peer.getAnisette());
    return Response.json(await peer.forwardApple(JSON.parse(init.body)));
  };
  const workspace=new BrowserWorkspaceClient(store);
  try{
    await workspace.createProvisioningBundle({name:'kept-local',mode:'fixed'});
    await workspace.connectBridge('http://127.0.0.1:18432');await workspace.startAppleLogin(input);
    assert.equal((await workspace.getAuthState()).status,'ready');const previous=(await store.read()).account;
    peer.options.hold='gsa';const pending=workspace.startAppleLogin(input);for(let i=0;!peer.release&&i<100;i++)await new Promise(r=>setTimeout(r,1));workspace.cancelAppleLogin();peer.release();
    await assert.rejects(pending,{code:'CANCELLED'});assert.deepEqual((await store.read()).account,previous);
    await workspace.logoutApple();assert.equal((await workspace.getAuthState()).status,'not_configured');assert.equal((await workspace.listDevices()).length,1);
    assert.ok(!JSON.stringify(await store.read()).includes(input.password));
  }finally{workspace.cancelAppleLogin();globalThis.fetch=original;}
});
