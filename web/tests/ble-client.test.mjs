import assert from "node:assert/strict";
import { test } from "node:test";
import { WebBluetoothClient } from "../lib/ble/web-bluetooth-client.ts";
import { DEFAULT_SETTINGS } from "../lib/ble/settings-protocol.ts";
import { fakeGatt, frame, UUID, waitUntil } from "./fake-gatt.mjs";

async function connected(t, fixture = fakeGatt(), extra = {}) {
  const client = new WebBluetoothClient({
    bluetooth: fixture.bluetooth, secureContext: true, operationTimeoutMs: 80,
    pairingTimeoutMs: 80, pollMs: 1, ...extra,
  });
  t.after(() => client.dispose());
  await client.requestDevice();
  await client.connect();
  return { client, fixture };
}

async function ledConnected(t, options = {}) {
  const f = fakeGatt(options);
  const telemetry = new Uint8Array(f.chars.get(UUID.INFO).value.buffer).slice();
  telemetry[3] |= 0xc0;
  f.chars.get(UUID.INFO).set(telemetry);
  const { encodeSettings } = await import("../lib/ble/settings-protocol.ts");
  f.chars.get(UUID.SETTINGS).set(encodeSettings({ ...DEFAULT_SETTINGS, led_enabled: true }));
  const result = await connected(t, f);
  await result.client.readTelemetry();
  await result.client.readSettings();
  return result;
}

test("discovery accepts random names, authorizes standard identity service, connect uses public reads only", async t => {
  const { client, fixture: f } = await connected(t);
  assert.deepEqual(f.requests[0].filters, [{ services: [UUID.SERVICE] }]);
  assert.ok(f.requests[0].optionalServices.includes(UUID.DIS));
  assert.equal(client.deviceInfo.name, "ATAG-8BC12EF0");
  assert.equal(client.getSession().identity.serial, null);
  assert.equal(client.getSession().batteryMillivolts, 4080);
  assert.equal(client.getSession().encryption, "unencrypted");
  assert.equal(client.getSession().telemetry, null);
  assert.equal(f.reads.some(uuid => [UUID.INFO, UUID.NAME, UUID.SETTINGS].includes(uuid)), false);
  assert.equal(f.writes.length, 0);
});

test("LED identification refuses absent hardware and waits for a fresh transient acknowledgement", async t => {
  const { client, fixture: f } = await connected(t);
  await client.readTelemetry();
  await client.readSettings();
  await assert.rejects(client.identifyLed(true), e => e.code === "unsupported");
  assert.equal(f.writes.some(w => w.uuid === UUID.CONTROL), false);
  const telemetry = new Uint8Array(f.chars.get(UUID.INFO).value.buffer).slice();
  telemetry[3] |= 0xc0;
  f.notify(UUID.INFO, telemetry);
  const { encodeSettings } = await import("../lib/ble/settings-protocol.ts");
  f.chars.get(UUID.SETTINGS).set(encodeSettings({ ...DEFAULT_SETTINGS, led_enabled: true }));
  await client.readSettings();
  f.setWriteHandler((uuid, payload, peer) => {
    if (uuid === UUID.CONTROL) peer.notify(UUID.STATUS, Uint8Array.of(1, payload[0] === 3 ? 7 : 8, 0, 2, 0, 0, 0, 0));
  });
  const started = await client.identifyLed(true);
  assert.equal(started.operation, "led");
  assert.equal(started.state, "accepted");
  assert.equal(started.commitConfirmed, false);
  assert.equal((await client.identifyLed(false)).resultCode, 8);
});

test("LED commands require encryption and distinguish unknown hardware from absent hardware", async t => {
  const { client, fixture: f } = await connected(t);
  await assert.rejects(client.identifyLed(true), e => e.code === "pairing_failed");
  assert.equal(f.writes.length, 0); // Find must not initiate pairing.
  f.chars.get(UUID.INFO).set(Uint8Array.of(0)); // A failed telemetry read must not imply no LED.
  await client.ensureEncrypted();
  await client.readSettings();
  assert.equal(client.getSession().telemetry, null);
  await assert.rejects(client.identifyLed(true), e => e.code === "incompatible" && /未知/.test(e.message));
  assert.equal(f.writes.some(w => w.uuid === UUID.CONTROL), false);
});

test("LED starts require a saved enabled setting; stop is allowed after disabling", async t => {
  const { client, fixture: f } = await ledConnected(t);
  f.setWriteHandler((uuid, _payload, peer) => {
    if (uuid === UUID.SETTINGS) peer.notify(UUID.STATUS, frame(5));
    if (uuid === UUID.CONTROL) peer.notify(UUID.STATUS, frame(8));
  });
  await client.writeSettings({ ...DEFAULT_SETTINGS, led_enabled: false });
  const draft = { ...client.getSession().settings, led_enabled: true };
  assert.equal(draft.led_enabled, true);
  await assert.rejects(client.identifyLed(true), e => e.code === "invalid_settings");
  assert.equal(f.writes.some(w => w.uuid === UUID.CONTROL), false);
  assert.equal((await client.identifyLed(false)).resultCode, 8);
});

test("LED receipts must match start/stop exactly and cannot complete a settings save", async t => {
  const { client, fixture: f } = await ledConnected(t, { initialStatus: frame(7) });
  const deadline = client.getSession().estimatedConnectionDeadline;
  let settled = false;
  const starting = client.identifyLed(true).then(result => { settled = true; return result; });
  await waitUntil(() => f.writes.some(w => w.uuid === UUID.CONTROL));
  f.notify(UUID.STATUS, frame(8));
  f.notify(UUID.STATUS, frame(5));
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(settled, false);
  f.notify(UUID.STATUS, frame(7));
  assert.equal((await starting).commitConfirmed, false);
  assert.equal(client.getSession().estimatedConnectionDeadline, deadline);

  settled = false;
  const stopping = client.identifyLed(false).then(result => { settled = true; return result; });
  await waitUntil(() => f.writes.filter(w => w.uuid === UUID.CONTROL).length === 2);
  f.notify(UUID.STATUS, frame(7));
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(settled, false);
  f.notify(UUID.STATUS, frame(8));
  assert.equal((await stopping).commitConfirmed, false);

  settled = false;
  const saving = client.writeSettings(DEFAULT_SETTINGS).then(result => { settled = true; return result; });
  await waitUntil(() => f.writes.some(w => w.uuid === UUID.SETTINGS));
  for (const code of [7, 8, 9]) f.notify(UUID.STATUS, frame(code));
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(settled, false);
  assert.equal(client.getSession().settings.led_enabled, true);
  f.notify(UUID.STATUS, frame(5));
  assert.equal((await saving).commitConfirmed, true);
  assert.equal(client.getSession().settings.led_enabled, false);
});

test("LED rejection retains its cause without changing saved permission", async t => {
  const { client, fixture: f } = await ledConnected(t);
  for (const cause of [1, 2, 3]) {
    f.setWriteHandler((uuid, _payload, peer) => {
      if (uuid === UUID.CONTROL) peer.notify(UUID.STATUS, frame(9, 0, cause));
    });
    const result = await client.identifyLed(true);
    assert.equal(result.state, "rejected");
    assert.equal(result.errorCode, cause);
    assert.equal(result.commitConfirmed, false);
    assert.equal(client.getSession().settings.led_enabled, true);
  }
});

test("cached LED result and ATT response do not confirm a new command; disconnect is unknown", async t => {
  const { client, fixture: f } = await ledConnected(t, { initialStatus: frame(7) });
  await assert.rejects(client.identifyLed(true), e => e.code === "timeout" && /LED 指令/.test(e.message) && !/保存|Flash/.test(e.message));
  f.setWriteHandler((uuid, _payload, peer) => { if (uuid === UUID.CONTROL) peer.gatt.disconnect(); });
  await assert.rejects(client.identifyLed(false), e => e.code === "disconnected" && /结果未知/.test(e.message) && !/保存|Flash/.test(e.message));
});

test("button baseline replay is not identification; a changed counter identifies without extending the deadline", async t => {
  const { client, fixture: f } = await connected(t);
  const deadline = client.getSession().estimatedConnectionDeadline;
  assert.equal(client.getSession().buttonCounter, 7);
  assert.equal(client.getSession().lastButtonPressAt, null);
  f.notify(UUID.BUTTON, Uint8Array.of(7, 0, 0, 0));
  assert.equal(client.getSession().lastButtonPressAt, null);
  f.notify(UUID.BUTTON, Uint8Array.of(8, 0, 0, 0));
  assert.ok(client.getSession().lastButtonPressAt);
  assert.equal(client.getSession().estimatedConnectionDeadline, deadline);
});

test("pairing echo 1 does not unlock protected reads; only state 2 permits telemetry", async t => {
  const { client, fixture: f } = await connected(t, fakeGatt({ autoPair: false }));
  const operation = client.readTelemetry();
  await waitUntil(() => f.writes.some(w => w.uuid === UUID.PAIRING));
  assert.equal(client.getSession().encryption, "pairing");
  assert.equal(f.reads.includes(UUID.INFO), false);
  f.pairReady();
  const telemetry = await operation;
  assert.equal(telemetry.version, 1);
  assert.equal(client.getSession().encryption, "encrypted");
  assert.equal(telemetry.connectionSecondsLeft, 118);
  assert.equal(client.getSession().identity.serial, "0102030405060708");
});

test("pairing never ready fails without touching protected attributes", async t => {
  const { client, fixture: f } = await connected(t, fakeGatt({ autoPair: false }), { pairingTimeoutMs: 15 });
  await assert.rejects(client.readName(), e => e.code === "pairing_failed");
  assert.equal(f.reads.includes(UUID.NAME), false);
  assert.equal(client.getSession().encryption, "unencrypted");
});

test("name updates ignore unrelated key/settings receipts and resolve only the matching fresh commit", async t => {
  const f = fakeGatt();
  f.setWriteHandler((uuid, _bytes, peer) => {
    if (uuid === UUID.NAME) {
      peer.notify(UUID.STATUS, frame(1, 2));
      peer.notify(UUID.STATUS, frame(5, 2));
      peer.notify(UUID.STATUS, frame(3, 2));
    }
  });
  const { client } = await connected(t, f);
  const result = await client.writeName("中文标签");
  assert.equal(result.operation, "name"); assert.equal(result.commitConfirmed, true);
  assert.equal(client.getSession().deviceName, "中文标签");
  assert.equal(client.getSession().identity.serial, "0102030405060708");
  assert.equal(f.writes.find(w => w.uuid === UUID.NAME).bytes.length, 12);
});

test("cached prior success and ATT response alone cannot confirm a new write", async t => {
  const { client } = await connected(t, fakeGatt({ initialStatus: frame(3) }), { operationTimeoutMs: 20 });
  await assert.rejects(client.writeName("未确认"), e => e.code === "timeout");
  assert.equal(client.getSession().deviceName, null);
});

test("a settings commit followed immediately by disconnect remains a durable success", async t => {
  const f = fakeGatt();
  f.setWriteHandler((uuid, _bytes, peer) => {
    if (uuid === UUID.SETTINGS) { peer.notify(UUID.STATUS, frame(5, 2)); peer.gatt.disconnect(); }
  });
  const { client } = await connected(t, f);
  const saved = { ...DEFAULT_SETTINGS, connection_seconds: 10 };
  const result = await client.writeSettings(saved);
  assert.equal(result.commitConfirmed, true); assert.equal(result.operation, "settings");
  assert.equal(client.state, "disconnected");
  assert.equal(client.getSession().estimatedConnectionDeadline, null);
  assert.equal(client.getSession().settings.connection_seconds, 10);
});

test("disconnect before commit is unknown; rejected names do not update the device name", async t => {
  const f = fakeGatt();
  f.setWriteHandler((uuid, _bytes, peer) => { if (uuid === UUID.NAME) peer.notify(UUID.STATUS, frame(4)); });
  const { client } = await connected(t, f);
  const rejected = await client.writeName("被拒绝");
  assert.equal(rejected.state, "rejected"); assert.equal(rejected.commitConfirmed, false);
  assert.equal(client.getSession().deviceName, null);
  f.setWriteHandler((uuid, _bytes, peer) => { if (uuid === UUID.NAME) peer.gatt.disconnect(); });
  await assert.rejects(client.writeName("结果未知"), e => e.code === "disconnected");
});

test("only one protected update is sent at a time", async t => {
  const { client, fixture: f } = await connected(t);
  const first = client.writeName("串行写入");
  await waitUntil(() => f.writes.some(w => w.uuid === UUID.NAME));
  await assert.rejects(client.writeSettings(DEFAULT_SETTINGS), e => e.code === "busy");
  assert.equal(f.writes.some(w => w.uuid === UUID.SETTINGS), false);
  f.notify(UUID.STATUS, frame(3));
  await first;
});

test("closing during connection prevents a late native connection from staying open", async t => {
  let complete;
  const connectDelay = new Promise(resolve => { complete = resolve; });
  const f = fakeGatt({ connectDelay });
  const client = new WebBluetoothClient({ bluetooth: f.bluetooth, secureContext: true });
  t.after(() => client.dispose());
  await client.requestDevice();
  const opening = client.connect();
  const rejected = assert.rejects(opening);
  client.disconnect();
  complete();
  await rejected;
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(f.gatt.connected, false);
  assert.equal(client.state, "disconnected");
});
