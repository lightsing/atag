import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '@noble/hashes/sha2.js';
import { BrowserWorkspaceClient, validateAnisetteUrl } from '../lib/workspace/browser-workspace-client.ts';
import { MemoryWorkspaceStore } from '../lib/workspace/store.ts';
import { P224, concat, nextRollingKey, publicKey, base64, unbase64, decryptReport, makeConfiguration, reportKeys } from '../lib/workspace/crypto.ts';
import { validateWorkspace } from '../lib/workspace/backup.ts';
import { updateReportRotationInterval } from '../lib/workspace/report-interval.ts';
import { estimateRotation, REPORT_LOOKBACK_MS, ROTATION_COUNT_MAX, ROTATION_MAX } from '../lib/workspace/report-query.ts';
import { parseConfigPackage } from '../lib/ble/protocol.ts';
import { BridgeClient } from '../lib/agent/bridge-client.ts';

const privateOne = Uint8Array.from({length:28},(_,i)=>i===27?1:0);
const fixture='Lr6/gAEEcGpG3Hbct2eY5g5tiUdHiNFtwYAy0mj9GnBPphwrdqe8JedwKnBPqYaJKEn8pilIes83CdLk6LvhomR1lWhY7ZJitktKyXCWopVCrmanPZUe+A==';
const MINUTE = 60_000;

async function waitForRefresh(client, operation) {
  for (let i = 0; i < 200; i++) {
    const next = await client.getOperation(operation.id);
    if (!['running', 'queued'].includes(next.status)) return next;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('operation timeout');
}

async function encryptFixture(privateKey, time) {
  const header = new Uint8Array(5);
  new DataView(header.buffer).setUint32(0, Math.floor(time / 1000) - 978307200);
  const ephemeral = P224.BASE.multiply(2n).toBytes(false);
  const shared = P224.fromBytes(publicKey(privateKey)).multiply(2n).toBytes(false).slice(1, 29);
  const symmetric = sha256(concat(shared, Uint8Array.of(0, 0, 0, 1), ephemeral));
  const key = await crypto.subtle.importKey('raw', symmetric.slice(0, 16), 'AES-GCM', false, ['encrypt']);
  const clear = new Uint8Array(10);
  const view = new DataView(clear.buffer);
  view.setInt32(0, 377749000);
  view.setInt32(4, -1224194000);
  clear[8] = 23;
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: symmetric.slice(16) }, key, clear);
  return concat(header, ephemeral, new Uint8Array(ciphertext));
}

test('Anisette defaults to emulated macOS CoreADI and retains existing sources',()=>{
  assert.equal(validateAnisetteUrl(''),'mac-coreadi');assert.equal(validateAnisetteUrl(' mac-coreadi '),'mac-coreadi');
  assert.equal(validateAnisetteUrl(' local '),'local');assert.equal(validateAnisetteUrl('portable'),'portable');
  assert.equal(validateAnisetteUrl(' sidestore '),'sidestore');
  assert.equal(validateAnisetteUrl('https://anisette.example/'),'https://anisette.example/');
  for(const value of ['file:///private/data','http://anisette.example/','https://user:secret@anisette.example/'])assert.throws(()=>validateAnisetteUrl(value));
});

test('browser P-224 rolling derivation matches independent Rust/Python vectors',async()=>{
  assert.equal(Buffer.from(publicKey(privateOne).slice(1,29)).toString('hex'),'b70e0cbd6bb4bf7f321390b94a03c1d356c21122343280d6115c1d21');
  const first=nextRollingKey(privateOne,Uint8Array.from({length:32},(_,i)=>i));
  assert.equal(Buffer.from(first.seed).toString('hex'),'09a9c1f072ab2aa85eeb2f10b038c2e1d2a36f890a51b3394268808e633ba700');
  assert.equal(Buffer.from(publicKey(first.privateKey).slice(1,29)).toString('hex'),'335f9aaa896b3a0ca867fffb91cb62652f232559c8141f1382d9912a');
  const keys={kind:'rotating',masterPrivateKey:base64(privateOne),symmetricSeed:base64(Uint8Array.from({length:32},(_,i)=>i))};
  const window=await reportKeys(keys,{rotationStart:2,rotationCount:1});
  const [matched] = window.values();
  assert.equal(matched.rotation, 2);
  assert.equal(Buffer.from(publicKey(matched.privateKey).slice(1,29)).toString('hex'),'675f96c4e5a6b5bfc2988d03e1550af05453412c64d73fd37ee3d4ff');
});

test('browser decrypts independent 88/89-byte GCM reports; rejects tampering and decodes battery voltage',async()=>{
  const old=unbase64(fixture);const newer=Uint8Array.from([...old.slice(0,4),0,...old.slice(4)]);
  for(const bytes of [old,newer]){
    const report=await decryptReport('test',privateOne,bytes);
    assert.equal(report.latitude,37.7749);assert.equal(report.longitude,-122.4194);assert.equal(report.observedAt,'2025-11-08T00:00:00.000Z');
    assert.equal(report.horizontalAccuracyMeters,23);assert.equal(report.batteryMillivolts,2686);
  }
  const bad=old.slice();bad[70]^=1;await assert.rejects(decryptReport('test',privateOne,bad));
});

test('offline key generation, edits, reports and identity survive a new repository instance',async()=>{
  const store=new MemoryWorkspaceStore();const first=new BrowserWorkspaceClient(store);
  const bundle=await first.createProvisioningBundle({name:'我的标签',mode:'rotating',rotationIntervalMinutes:15});
  assert.equal(parseConfigPackage(unbase64(bundle.configurationBase64)).ok,true);
  assert.equal(first.bridgeConnected,false);
  await first.updateDevice(bundle.deviceId,{name:'通勤背包',icon:'backpack'});
  await first.confirmProvisioning(bundle.deviceId,'D300000001000000','0.1.0');
  await first.updateQuerySettings(bundle.deviceId,{rotationStart:513,rotationCount:1024});
  first.disconnectBridge();const second=new BrowserWorkspaceClient(store);
  assert.equal((await second.getDevice(bundle.deviceId)).name,'通勤背包');
  assert.equal((await second.getDevice(bundle.deviceId)).chipSerial,'d300000001000000');
  assert.equal((await second.getQuerySettings(bundle.deviceId)).rotationStart,513);
  await assert.rejects(second.refreshReports(bundle.deviceId),{code:'AGENT_UNAVAILABLE'});
  assert.equal((await second.listDevices()).length,1);
});

test('automatic range uses the latest known round and keeps older in-window rounds', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  const at = offset => new Date(now + offset * MINUTE).toISOString();
  const record = { keys: { kind: 'rotating' }, device: { rotationIntervalMinutes: 15 }, reports: [{ observedAt: at(-5) }] };
  assert.equal(estimateRotation(record, now), null);
  record.reports.push(
    { observedAt: at(-90), rotation: 900 },
    { observedAt: at(-10000), rotation: 205 },
    { observedAt: at(1), rotation: 1000 },
  );
  const reportEstimate = estimateRotation(record, now);
  assert.deepEqual(reportEstimate.anchor, { observedAt: at(-90), rotation: 900, source: 'report' });
  assert.equal(reportEstimate.estimatedRotation, 906);
  assert.equal(reportEstimate.rotationStart, 205);
  assert.equal(reportEstimate.rotationStart + reportEstimate.rotationCount - 1, 907);

  record.reports = [{ observedAt: at(-REPORT_LOOKBACK_MS / MINUTE - 30), rotation: 900 }];
  const stale = estimateRotation(record, now);
  assert.equal(stale.rotationStart, 899); // Include the known round if the Tag lost power.
  assert.ok(stale.rotationStart + stale.rotationCount > stale.estimatedRotation);

  record.rotationTiming = { observedAt: at(-2), intervalMinutes: 1, rotation: ROTATION_MAX - 1 };
  const limited = estimateRotation(record, now);
  assert.equal(limited.anchor.source, 'tag');
  assert.equal(limited.rotationCount, ROTATION_COUNT_MAX);
  assert.equal(limited.rotationStart + limited.rotationCount - 1, ROTATION_MAX);
  assert.equal(limited.limited, true);
});

test('report inference needs sustained evidence and ignores small differences and a single pause', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  const at = minutes => new Date(now + minutes * MINUTE).toISOString();
  const record = { keys: { kind: 'rotating' }, device: { rotationIntervalMinutes: 15 }, reports: [] };
  const use = points => {
    record.reports = points.map(([rotation, time]) => ({ observedAt: at(time), rotation }));
  };
  use([[100, -481], [108, -241], [108, -240], [116, 1]]);
  assert.equal(updateReportRotationInterval(record, now), false); // Duplicate round and a future report.
  use([[100, -257], [108, -129], [116, -1]]);
  assert.equal(updateReportRotationInterval(record, now), false); // 16 vs. 15 minutes.
  use([[100, -481], [108, -121], [116, -1]]);
  assert.equal(updateReportRotationInterval(record, now), false); // Pause between rounds 100 and 108.
  use([[100, -481], [108, -241], [116, -1]]);
  assert.equal(updateReportRotationInterval(record, now), true);
  assert.equal(record.reportRotationInterval.intervalMinutes, 30);
  use([[100, -481], [108, -241], [116, -1], [124, 119], [132, 239]]);
  assert.equal(updateReportRotationInterval(record, now + 240 * MINUTE), true);
  assert.equal(record.reportRotationInterval.intervalMinutes, 15);
});

test('cached reports are a persistent fallback; a bound Tag reading outranks newer reports', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-09T12:00:00Z') });
  const store = new MemoryWorkspaceStore();
  const client = new BrowserWorkspaceClient(store);
  const bundle = await client.createProvisioningBundle({ name: '我的标签', mode: 'rotating', rotationIntervalMinutes: 15 });
  const { deviceId } = bundle;
  const serial = 'D300000001000000';
  const beforeProvisioning = new Date().toISOString();
  const timing = { observedAt: beforeProvisioning, rotation: 123, intervalMinutes: 20 };
  assert.equal(await client.observeRotationTiming(serial, timing), false);
  t.mock.timers.tick(MINUTE);
  await client.confirmProvisioning(deviceId, serial);
  assert.equal(await client.observeRotationTiming(serial, timing), false);
  timing.observedAt = new Date().toISOString();
  t.mock.timers.tick(9 * 60 * MINUTE);
  await store.update(data => {
    data.records[0].reports = [124, 132, 140].map((rotation, i) => ({
      id: 'report_' + rotation, deviceId, rotation,
      observedAt: new Date(Date.now() - (511 - 240 * i) * MINUTE).toISOString(),
      latitude: 37.77, longitude: -122.41, horizontalAccuracyMeters: 23, batteryMillivolts: 2686, source: 'findmy',
    }));
  });
  const estimate = await client.getQuerySettings(deviceId);
  assert.equal(estimate.intervalMinutes, 30);
  assert.equal(estimate.intervalSource, 'report');
  assert.equal((await store.read()).records[0].reportRotationInterval.intervalMinutes, 30);
  const reportBackup = await client.exportBackup('test-password');
  assert.equal(await client.observeRotationTiming(serial, timing), true);
  assert.equal(await client.observeRotationTiming('d300000002000000', timing), false);
  assert.equal(await client.observeRotationTiming(serial, { ...timing, intervalMinutes: 25 }), false);
  const second = new BrowserWorkspaceClient(store);
  await second.restoreBackup(reportBackup, 'test-password');
  const view = await second.getQuerySettings(deviceId);
  assert.equal(view.intervalMinutes, 20);
  assert.equal(view.intervalSource, 'tag');
  assert.equal(view.estimate.estimatedRotation, 141); // Recent report anchor, measured Tag period.
  assert.deepEqual(await second.getProvisioningBundle(deviceId), bundle);

  const restoredStore = new MemoryWorkspaceStore();
  const restored = new BrowserWorkspaceClient(restoredStore);
  await restored.restoreBackup(reportBackup, 'test-password');
  assert.equal((await restoredStore.read()).records[0].reportRotationInterval.intervalMinutes, 30);
  await restored.restoreBackup(await second.exportBackup('test-password'), 'test-password');
  assert.equal((await restored.getQuerySettings(deviceId)).intervalSource, 'tag');
  await restored.confirmProvisioning(deviceId, serial);
  await restored.restoreBackup(reportBackup, 'test-password');
  const reprovisioned = await restored.getQuerySettings(deviceId);
  assert.equal(reprovisioned.intervalMinutes, 15);
  assert.equal(reprovisioned.intervalSource, 'profile');
});

test('refresh recovers a cached round, learns the period from new reports, and honors manual mode', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-09T12:00:00Z') });
  const store = new MemoryWorkspaceStore();
  const client = new BrowserWorkspaceClient(store);
  const { deviceId } = await client.createProvisioningBundle({ name: 'rotating fixture', mode: 'rotating' });
  const { keys } = (await store.read()).records[0];
  const rounds = [...await reportKeys(keys, { rotationStart: 2, rotationCount: 9 })];
  const [firstId, firstKey] = rounds[0];
  const [middleId, middleKey] = rounds[4];
  const [laterId, laterKey] = rounds[8];
  const now = Date.now();
  const first = await encryptFixture(firstKey.privateKey, now - 365 * MINUTE);
  const middle = await encryptFixture(middleKey.privateKey, now - 245 * MINUTE);
  const later = await encryptFixture(laterKey.privateKey, now - 125 * MINUTE);
  const legacy = await decryptReport(deviceId, firstKey.privateKey, first);
  await store.update(data => {
    data.records[0].reports = [legacy];
    data.records[0].query = { rotationStart: 2, rotationCount: 2 };
    data.account = { dsid: '123', searchPartyToken: 'test', uid: 'uid', deviceId: 'client', accountLabel: null };
    data.anisetteUrl = 'local';
  });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const requests = [];
  globalThis.fetch = async (url, init) => {
    if (url.endsWith('/health')) return Response.json({ protocolVersion: 1, agentVersion: 'test', capabilities: { anisette: true, appleRelay: true } });
    if (url.endsWith('/anisette')) return Response.json({ headers: { 'x-apple-i-md': 'test', 'x-apple-i-md-m': 'test' }, clientInfo: 'test', userAgent: 'test' });
    const ids = JSON.parse(atob(JSON.parse(init.body).bodyBase64)).fetch[0].primaryIds;
    requests.push(ids);
    const locationPayload = [[firstId, first], [middleId, middle], [laterId, later]]
      .filter(([id]) => ids.includes(id))
      .map(([id, payload]) => ({ id, locationInfo: [base64(payload)] }));
    const bodyBase64 = btoa(JSON.stringify({ acsnLocations: { statusCode: '200', locationPayload } }));
    return Response.json({ status: 200, headers: {}, bodyBase64 });
  };
  await client.connectBridge('http://127.0.0.1:18432');
  assert.equal((await client.getQuerySettings(deviceId)).estimate, null);
  const refresh = async () => waitForRefresh(client, await client.refreshReports(deviceId));

  assert.deepEqual((await refresh()).result, { newReportCount: 0 });
  assert.deepEqual(requests[0], rounds.slice(0, 2).map(([id]) => id));
  assert.deepEqual((await client.getDevice(deviceId)).latestReport, { ...legacy, rotation: 2 });
  assert.equal((await client.getQuerySettings(deviceId)).estimate.estimatedRotation, 26);

  assert.deepEqual((await refresh()).result, { newReportCount: 2 });
  assert.ok(requests[1].includes(laterId));
  assert.equal((await client.getDevice(deviceId)).latestReport.rotation, 10);
  assert.equal((await store.read()).records[0].reportRotationInterval.intervalMinutes, 30);
  assert.deepEqual((await refresh()).result, { newReportCount: 0 });
  assert.deepEqual(requests[2], [...(await reportKeys(keys, { rotationStart: 1, rotationCount: 16 })).keys()]);

  await client.updateQuerySettings(deviceId, { rotationMode: 'manual', rotationStart: 2, rotationCount: 1 });
  assert.deepEqual((await refresh()).result, { newReportCount: 0 });
  assert.deepEqual(requests[3], [firstId]);
});

test('encrypted backups roundtrip keys, reports and settings; exclude account by default',async()=>{
  const store=new MemoryWorkspaceStore(),client=new BrowserWorkspaceClient(store);
  const bundle=await client.createProvisioningBundle({name:'真实设备',mode:'fixed'});
  await store.update(data=>{data.account={dsid:'123',searchPartyToken:'synthetic-session',uid:'uid',deviceId:'device',accountLabel:null};data.anisetteUrl='local';});
  await store.update(data=>{
    data.records[0].reports=[{id:'report_test',deviceId:bundle.deviceId,observedAt:'2025-11-08T00:00:00.000Z',latitude:37.7749,longitude:-122.4194,horizontalAccuracyMeters:23,batteryMillivolts:2686,source:'findmy'}];
  });
  const backup=await client.exportBackup('long-enough-password');
  assert.ok(!backup.includes('真实设备'));assert.ok(!backup.includes('synthetic-session'));assert.ok(!backup.includes('privateKey'));
  const targetStore=new MemoryWorkspaceStore(),target=new BrowserWorkspaceClient(targetStore);
  const summary=await target.previewBackup(backup,'long-enough-password');assert.equal(summary.deviceCount,1);assert.equal(summary.reportCount,1);assert.equal(summary.hasAccount,false);
  await target.restoreBackup(backup,'long-enough-password');assert.equal((await target.listDevices())[0].latestReport.latitude,37.7749);
  assert.deepEqual((await targetStore.read()).records[0].keys,(await store.read()).records[0].keys);
  assert.equal((await target.getStats()).hasAccount,false);
  const included=await client.exportBackup('long-enough-password',true);assert.equal((await target.previewBackup(included,'long-enough-password')).hasAccount,true);
});

test('wrong password, damaged backup and conflicts leave existing workspace unchanged',async()=>{
  const store=new MemoryWorkspaceStore(),client=new BrowserWorkspaceClient(store);
  const bundle=await client.createProvisioningBundle({name:'保留设备',mode:'fixed'});
  const backup=await client.exportBackup('test-password');const before=await store.read();
  await assert.rejects(client.restoreBackup(backup,'wrong-password'));assert.deepEqual(await store.read(),before);
  const changed=JSON.parse(backup);changed.ciphertext=changed.ciphertext.slice(0,-5)+'AAAA=';
  await assert.rejects(client.restoreBackup(JSON.stringify(changed),'test-password'));assert.deepEqual(await store.read(),before);
  await store.update(data=>data.records[0].keys={kind:'fixed',privateKey:base64(privateOne)});const conflictBefore=await store.read();
  await assert.rejects(client.restoreBackup(backup,'test-password'),/冲突/);assert.deepEqual(await store.read(),conflictBefore);
  await assert.rejects(client.updateQuerySettings(bundle.deviceId,{rotationCount:0}));assert.deepEqual(await store.read(),conflictBefore);
});

test('merge is idempotent and preserves current nicknames',async()=>{
  const client=new BrowserWorkspaceClient(new MemoryWorkspaceStore());
  const bundle=await client.createProvisioningBundle({name:'设备',mode:'fixed'});
  const device=await client.getDevice(bundle.deviceId);
  const backup=await client.exportBackup('test-password');await client.updateDevice(device.id,{name:'新昵称'});
  await client.restoreBackup(backup,'test-password');await client.restoreBackup(backup,'test-password');
  assert.equal((await client.listDevices()).length,1);assert.equal((await client.getDevice(device.id)).name,'新昵称');
  const reports=await client.listReports(device.id,{from:'2025-01-01T00:00:00Z',to:'2027-01-01T00:00:00Z'});assert.deepEqual(reports.reports,[]);
});

test('duplicate serial binding is rejected atomically',async()=>{
  const client=new BrowserWorkspaceClient(new MemoryWorkspaceStore());
  const a=await client.createProvisioningBundle({name:'a',mode:'fixed'}),b=await client.createProvisioningBundle({name:'b',mode:'fixed'});
  await client.confirmProvisioning(a.deviceId,'d300000001000000');
  await assert.rejects(client.confirmProvisioning(b.deviceId,'d300000001000000'));
  assert.equal((await client.getDevice(b.deviceId)).chipSerial,null);
});

test('bridge metadata and forwarding are explicit and private keys never enter relay bodies',async()=>{
  const requests=[];const fetcher=async(url,init)=>{
    requests.push({url,init});
    if(url.endsWith('/health'))return Response.json({protocolVersion:1,agentVersion:'test',capabilities:{anisette:true,appleRelay:true}});
    if(url.endsWith('/anisette'))return Response.json({headers:{'x-apple-i-md':'synthetic','x-apple-i-md-m':'synthetic-machine'},clientInfo:'test',userAgent:'test'});
    const body=JSON.parse(init.body);assert.equal(body.endpoint,'findmy');const value={acsnLocations:{statusCode:'200',locationPayload:[]}};
    return Response.json({status:200,headers:{},bodyBase64:Buffer.from(JSON.stringify(value)).toString('base64')});
  };
  const bridge=new BridgeClient('http://127.0.0.1:18432',fetcher);await bridge.connect();
  assert.equal(requests.length,1);
  assert.equal(requests[0].url,'http://127.0.0.1:18432/v1/health');
  assert.equal(requests[0].init.headers.Authorization,undefined);
  await bridge.fetchCiphertexts({dsid:'123',searchPartyToken:'session',uid:'uid',deviceId:'client',accountLabel:null},'local',[base64(new Uint8Array(32))],'2026-11-01T00:00:00Z','2026-11-08T00:00:00Z');
  assert.ok(requests.every(r=>!String(r.init.body).includes('privateKey')));
  assert.ok(requests.every(r=>!new Headers(r.init.headers).has('Authorization')));
  const request=JSON.parse(requests.find(r=>r.url.endsWith('/apple/request')).init.body);
  assert.deepEqual(Object.keys(request).sort(),['bodyBase64','endpoint','headers','method']);
  assert.equal(request.headers.Authorization,'Basic '+Buffer.from('123:session').toString('base64'));
  assert.equal(requests.filter(r=>r.url.endsWith('/apple/request')).length,1);
  assert.equal(request.endpoint,'findmy');assert.equal(requests.at(-1).init.credentials,'omit');
  assert.throws(()=>new BridgeClient('https://remote.example.test'),/loopback/);
});

test('bridge rejects unsupported protocol versions without retrying another route',async()=>{
  for(const protocolVersion of [0,2,3,'1',undefined]){
    const requests=[];
    const bridge=new BridgeClient('http://127.0.0.1:18432',async url=>{
      requests.push(url);
      return Response.json({protocolVersion,agentVersion:'0.1.0',capabilities:{anisette:true,appleRelay:true}});
    });
    await assert.rejects(bridge.connect(),{code:'VERSION_MISMATCH'});
    assert.deepEqual(requests,['http://127.0.0.1:18432/v1/health']);
  }
});

test('browser fetch pipeline decrypts and persists ciphertext locally; expired sessions remain browser-owned',async()=>{
  const original=globalThis.fetch;let expired=false;const requests=[];
  const bytes=unbase64(fixture);new DataView(bytes.buffer).setUint32(0,Math.floor(Date.now()/1000)-978307200-30);
  globalThis.fetch=async(url,init)=>{
    if(url.endsWith('/health'))return Response.json({protocolVersion:1,agentVersion:'test',capabilities:{anisette:true,appleRelay:true}});
    if(url.endsWith('/anisette'))return Response.json({headers:{'x-apple-i-md':'test','x-apple-i-md-m':'test'},clientInfo:'test',userAgent:'test'});
    const body=JSON.parse(init.body);requests.push(body);
    if(expired)return Response.json({status:401,headers:{},bodyBase64:''});
    const ids=JSON.parse(Buffer.from(body.bodyBase64,'base64').toString()).fetch[0].primaryIds;
    return Response.json({status:200,headers:{},bodyBase64:Buffer.from(JSON.stringify({acsnLocations:{statusCode:'200',locationPayload:[{id:ids[0],locationInfo:[base64(bytes),base64(bytes)]}]}})).toString('base64')});
  };
  try{
    const store=new MemoryWorkspaceStore(),client=new BrowserWorkspaceClient(store);
    await client.createProvisioningBundle({name:'synthetic',mode:'fixed'});
    await store.update(data=>{data.records[0].keys={kind:'fixed',privateKey:base64(privateOne)};});
    const [device]=await client.listDevices();
    const account=JSON.stringify({dsid:'123',searchPartyToken:'synthetic',uid:'uid',deviceId:'client',accountLabel:null});
    await store.update(data=>{data.account=JSON.parse(account);data.anisetteUrl='local';});await client.connectBridge('http://127.0.0.1:18432');
    const wait=op=>waitForRefresh(client,op);
    const first=await wait(await client.refreshReports(device.id));assert.equal(first.status,'succeeded');assert.equal(first.result.newReportCount,1);
    assert.equal((await client.getDevice(device.id)).latestReport.latitude,37.7749);
    assert.equal((await wait(await client.refreshReports(device.id))).result.newReportCount,0);
    assert.ok(requests.every(body=>!JSON.stringify(body).includes(base64(privateOne))));
    expired=true;assert.equal((await wait(await client.refreshReports(device.id))).status,'failed');assert.equal((await client.getAuthState()).status,'expired');
    assert.equal((await new BrowserWorkspaceClient(store).getAuthState()).status,'expired');
    client.disconnectBridge();assert.equal((await client.getDevice(device.id)).latestReport.latitude,37.7749);
  }finally{globalThis.fetch=original;}
});

test('workspace validation rejects unsupported versions and mismatched key material',async()=>{
  const store=new MemoryWorkspaceStore(),client=new BrowserWorkspaceClient(store);
  await client.createProvisioningBundle({name:'current',mode:'fixed'});
  const current=await store.read();
  assert.equal(validateWorkspace(current).version,1);
  for(const version of [0,2,3,4]){
    assert.throws(()=>validateWorkspace({...current,version}),/版本/);
  }
  const mismatched=structuredClone(current);
  mismatched.records[0].device.advertisingMode='rotating';
  assert.throws(()=>validateWorkspace(mismatched),/密钥模式/);
  const malformed=structuredClone(current);
  malformed.records[0].keys={kind:'fixed',privateKeys:[base64(privateOne)]};
  assert.throws(()=>validateWorkspace(malformed),/结构/);
  assert.deepEqual(await store.read(),current);
});
