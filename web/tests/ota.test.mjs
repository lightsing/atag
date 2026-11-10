import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { OTA_CONTROL, OTA_DATA, OTA_PROFILE, OTA_STATUS, OTA_PUBLIC_KEY_HEX, parseOtaPackage } from '../lib/ble/ota-protocol.ts';
import { WebBluetoothClient } from '../lib/ble/web-bluetooth-client.ts';
import { DEVICE_INFORMATION_UUIDS } from '../lib/ble/protocol.ts';
import { fakeGatt, UUID } from './fake-gatt.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const image = Buffer.alloc(512, 0xff);
image.writeUInt32LE(0x20008000, 0);
image.writeUInt32LE(0x19021, 4);
const digest = createHash('sha512').update(image).digest();
const manifest = {
  format: 1, target: 'nRF52832-S112-7.3.0', layout: 1, version: '0.2.0', length: image.length,
  sha256: createHash('sha256').update(image).digest('hex'), public_key: publicHex,
  signature: sign(null, digest, privateKey).toString('hex'), image: image.toString('hex'),
};
const parse = (fields = {}) => parseOtaPackage(JSON.stringify({ ...manifest, ...fields }), publicHex);
const update = parse();

test('validates CLI-style Ed25519(SHA512(image)) packages against a pinned key', () => {
  const compiled = readFileSync(new URL('../../firmware-nrf52832/ota-public-key.bin', import.meta.url));
  assert.equal(OTA_PUBLIC_KEY_HEX, compiled.toString('hex'));
  assert.deepEqual(Buffer.from(update.digest), digest);
  assert.deepEqual(Buffer.from(update.image), image);
  assert.throws(() => parseOtaPackage(JSON.stringify(manifest)), /信任/);
  assert.throws(() => parse({ target: 'nRF52840' }), /型号/);
  assert.throws(() => parse({ layout: 2 }), /分区/);
  assert.throws(() => parse({ length: 513 }), /大小/);
  assert.throws(() => parse({ image: '00'.repeat(512) }), /启动地址/);
  assert.throws(() => parse({ image: manifest.image.slice(0, -2) + '00' }), /SHA-256/);
  assert.throws(() => parse({ signature: '00'.repeat(64) }), /签名校验/);
});

function statusWire({ state = 0, error = 0, flags = 1, received = 0, total = 0, layout = 1 } = {}) {
  const bytes = Buffer.alloc(20);
  bytes.set([1, state, error, flags]);
  bytes.writeUInt32LE(received, 4);
  bytes.writeUInt32LE(total, 8);
  bytes.writeUInt32LE(0x28000, 12);
  bytes.writeUInt16LE(112, 16);
  bytes.writeUInt16LE(layout, 18);
  return bytes;
}

function profileWire(rotation = 42, fingerprint = 0xa5) {
  const bytes = Buffer.alloc(40);
  bytes.set([1, 2, 1, 1]);
  bytes.writeUInt32LE(rotation, 4);
  bytes.fill(fingerprint, 8);
  return bytes;
}

function otaGatt({ installed = true, beginError, dropReady, bootVersion = update.version, bootProfile = profileWire(43) } = {}) {
  const peer = fakeGatt({ characteristics: [
    [OTA_STATUS, statusWire({ flags: installed ? 1 : 0 })], [OTA_CONTROL, new Uint8Array(72)],
    [OTA_DATA, new Uint8Array(116)], [OTA_PROFILE, profileWire()],
  ] });
  let pending = false;
  let state = 0;
  let received = 0;
  let hasDigest = false;
  const chunks = [];
  const commands = [];
  function status(error = 0, notify = true) {
    const bytes = statusWire({ state, error, flags: hasDigest ? 3 : 1, received, total: state ? image.length : 0 });
    if (notify) peer.notify(OTA_STATUS, bytes);
    else peer.chars.get(OTA_STATUS).set(bytes);
  }
  peer.setWriteHandler((uuid, bytes) => {
    assert.ok(!pending, 'client wrote before previous durable receipt');
    assert.ok(uuid === OTA_CONTROL || uuid === OTA_DATA, 'upgrade must not request pairing or write settings');
    pending = true;
    const wire = Buffer.from(bytes);
    if (uuid === OTA_CONTROL) {
      assert.equal(wire.length, 72);
      assert.equal(wire[0], 1);
      assert.equal(wire.readUInt16LE(2), 0);
      commands.push(wire[1]);
      if (wire[1] === 4) {
        assert.deepEqual(wire.subarray(4, 68), digest);
        assert.equal(wire.readUInt32LE(68), 0);
      } else if (wire[1] === 1) {
        assert.ok(hasDigest);
        assert.equal(wire.readUInt32LE(4), image.length);
        assert.equal(wire.subarray(8).toString('hex'), manifest.signature);
      } else {
        assert.equal(wire[1], 2);
        assert.equal(received, image.length);
        assert.deepEqual(wire.subarray(4), Buffer.alloc(68));
      }
    } else {
      assert.equal(state, 1);
      assert.equal(wire.readUInt32LE(0), received);
      assert.ok(wire.length <= 72 && wire.length % 4 === 0);
    }
    // ATT completes before flash. The client must wait for this offset change.
    setTimeout(() => {
      pending = false;
      if (uuid === OTA_DATA) {
        chunks.push(wire.subarray(4));
        received += wire.length - 4;
        status(0, chunks.length !== 1); // Exercise a lost notification and live-status fallback.
      } else if (wire[1] === 4) {
        hasDigest = true;
        status();
      } else if (wire[1] === 1) {
        if (!beginError) state = 1;
        status(beginError);
      } else {
        state = 2;
        if (!dropReady) status();
        peer.gatt.disconnect();
        peer.chars.get(OTA_STATUS).set(statusWire());
        peer.chars.get(DEVICE_INFORMATION_UUIDS.firmwareVersion).set(new TextEncoder().encode(bootVersion));
        peer.chars.get(OTA_PROFILE).set(bootProfile);
      }
    }, 5);
  });
  return { peer, chunks, commands };
}

async function connected(peer) {
  const client = new WebBluetoothClient({ bluetooth: peer.bluetooth, secureContext: true, operationTimeoutMs: 500 });
  await client.requestDevice();
  await client.connect();
  return client;
}

test('OTA waits for durable offsets, reconnects without pairing and verifies the new version and profile', async () => {
  const { peer, chunks, commands } = otaGatt();
  const client = await connected(peer);
  const progress = [];
  assert.equal(client.getCapabilities().ota, true);
  const receipt = await client.uploadFirmware(update, item => progress.push(item));
  assert.equal(receipt.scheduled, true);
  assert.deepEqual(commands, [4, 1, 2]);
  assert.deepEqual(Buffer.concat(chunks), image);
  assert.equal(progress.at(-1).phase, 'finishing');
  assert.equal(progress.at(-1).received, image.length);
  assert.equal(client.state, 'disconnected');
  assert.equal(peer.requests.length, 1);
  await client.connect();
  assert.deepEqual(await client.verifyFirmware(receipt), { result: 'verified', version: '0.2.0' });
  assert.equal(peer.writes.some(write => write.uuid === UUID.PAIRING), false);
  assert.equal(peer.reads.includes(DEVICE_INFORMATION_UUIDS.serial), false);
  client.dispose();
});

test('OTA distinguishes disconnect before FINISH acknowledgement from verified installation', async () => {
  const { peer } = otaGatt({ dropReady: true, bootVersion: '0.1.0' });
  const client = await connected(peer);
  const receipt = await client.uploadFirmware(update, () => {});
  assert.equal(receipt.scheduled, false);
  await client.connect();
  assert.deepEqual(await client.verifyFirmware(receipt), { result: 'version_mismatch', version: '0.1.0' });
  client.dispose();
});

test('OTA verification cannot confirm an old profile or a same-version image', async () => {
  for (const [options, expected] of [
    [{ bootProfile: profileWire(41) }, 'profile_mismatch'],
    [{ bootVersion: '0.1.0' }, 'same_version'],
  ]) {
    const { peer } = otaGatt(options);
    const client = await connected(peer);
    const receipt = await client.uploadFirmware({ ...update, version: options.bootVersion ?? update.version }, () => {});
    await client.connect();
    assert.equal((await client.verifyFirmware(receipt)).result, expected);
    client.dispose();
  }
});

test('missing bootloader and low battery prevent writes; cancellation never sends FINISH', async () => {
  for (const peer of [fakeGatt(), otaGatt({ installed: false }).peer]) {
    const client = await connected(peer);
    assert.equal(client.getCapabilities().ota, false);
    await assert.rejects(client.uploadFirmware(update, () => {}), { code: 'incompatible' });
    assert.deepEqual(peer.writes, []);
    client.dispose();
  }

  const { peer, commands, chunks } = otaGatt();
  peer.chars.get(UUID.BATTERY).set(Uint8Array.of(0xb7, 0x0b)); // 2999 mV
  const client = await connected(peer);
  await assert.rejects(client.uploadFirmware(update, () => {}), /3\.0 V/);
  assert.deepEqual(commands, []);
  peer.chars.get(UUID.BATTERY).set(Uint8Array.of(0xf0, 0x0f));
  const cancellation = new AbortController();
  await assert.rejects(client.uploadFirmware(update, progress => {
    if (progress.received) cancellation.abort();
  }, cancellation.signal), { code: 'cancelled' });
  assert.deepEqual(commands, [4, 1]);
  assert.equal(chunks.length, 1);
  assert.equal(client.state, 'disconnected');
  client.dispose();
});

test('OTA stops on a Tag rejection and never writes image data', async () => {
  const { peer, commands, chunks } = otaGatt({ beginError: 9 });
  const client = await connected(peer);
  await assert.rejects(client.uploadFirmware(update, () => {}), /3\.0 V/);
  assert.deepEqual(commands, [4, 1]);
  assert.deepEqual(chunks, []);
  assert.equal(client.state, 'disconnected');
  client.dispose();
});
