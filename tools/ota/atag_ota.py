#!/usr/bin/env python3
"""Build and upload signed ATAG application images over BLE."""
from __future__ import annotations
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import time

from package import PRIVATE_KEY, PUBLIC_KEY, ROOT, init_key, load_package, sign, write_new

sys.path.insert(0, str(ROOT / 'tools/gatt'))

OTA_CONTROL = '0f4a000a-9b5b-4f04-9c22-a38b0a6e6db7'
OTA_DATA = '0f4a000b-9b5b-4f04-9c22-a38b0a6e6db7'
OTA_STATUS = '0f4a000c-9b5b-4f04-9c22-a38b0a6e6db7'
PROFILE_SNAPSHOT = '0f4a000d-9b5b-4f04-9c22-a38b0a6e6db7'


def run(command, *, env=None):
    subprocess.run([str(x) for x in command], cwd=ROOT, check=True, env=env)


def build(args):
    if args.public_key.read_bytes() != PUBLIC_KEY.read_bytes():
        raise ValueError('Package public key must match the public key compiled into firmware')
    if args.output.exists() and any(args.output.iterdir()):
        raise ValueError('Release directory is not empty; choose a new directory to keep artifacts consistent')
    args.output.mkdir(parents=True, exist_ok=True, mode=0o700)
    env = dict(os.environ, ATAG_FIRMWARE_VERSION=args.version)
    run(['cargo', 'build-nrf52832'], env=env)
    run(['cargo', 'build-bootloader'])
    target = ROOT / 'target/thumbv7em-none-eabihf/release'
    objcopy = shutil.which('arm-none-eabi-objcopy')
    if objcopy is None: raise RuntimeError('arm-none-eabi-objcopy is required')
    for binary, output in [('atag-nrf52832', 'application.hex'),
                           ('atag-bootloader-nrf52832', 'bootloader.hex')]:
        run([objcopy, '-O', 'ihex', target / binary, args.output / output])
    with tempfile.TemporaryDirectory() as tmp:
        raw = Path(tmp) / 'application.bin'
        run([objcopy, '-O', 'binary', '--gap-fill', '0xff', target / 'atag-nrf52832', raw])
        package = sign(raw.read_bytes(), args.version, args.key, args.public_key)
    path = args.output / f'atag-{args.version}.atag-ota'
    write_new(path, (json.dumps(package, indent=2) + '\n').encode())
    shutil.copy2(PUBLIC_KEY, args.output / 'ota-public-key.bin')
    release = {'version': args.version, 'layout': 1,
               'public_key_sha256': hashlib.sha256(PUBLIC_KEY.read_bytes()).hexdigest(),
               'files': {p.name:hashlib.sha256(p.read_bytes()).hexdigest()
                         for p in args.output.iterdir() if p.is_file()}}
    write_new(args.output / 'release.json', (json.dumps(release,indent=2)+'\n').encode())
    print(json.dumps({'package': str(path.resolve()), 'image_bytes': package['length'],
                      'sha256': package['sha256']}), flush=True)


def decode_status(wire):
    if len(wire) != 20 or wire[0] != 1: raise ValueError('Unsupported OTA status')
    version, state, error, installed, received, total, capacity, chunk, layout = struct.unpack('<BBBBIIIHH', wire)
    return dict(state=state,error=error,installed=bool(installed & 1),digest_received=bool(installed & 2),received=received,
                total=total,capacity=capacity,chunk=chunk,layout=layout)


async def profile_snapshot(client):
    wire=bytes(await client.read_gatt_char(PROFILE_SNAPSHOT))
    if len(wire)!=40 or wire[0]!=1: raise ValueError('Unsupported profile snapshot')
    return {'mode':wire[1],'rotation':int.from_bytes(wire[4:8],'little'),
            'profile_sha256':wire[8:40].hex()}


async def upload(args):
    from bleak import BleakClient
    from atag_gatt import discover, FIRMWARE, SERIAL
    package, image = load_package(args.package)
    devices = await discover(args.timeout, wait_for_first=True, address=args.address)
    if len(devices) != 1: raise RuntimeError(f'Found {len(devices)} tags; press P0.13 and specify --address')
    dev, adv = devices[0]
    async with BleakClient(dev, timeout=30) as client:
        serial = (await client.read_gatt_char(SERIAL)).decode()
        before_version = (await client.read_gatt_char(FIRMWARE)).decode()
        before = await profile_snapshot(client)
        before['name'] = adv.local_name
        status = decode_status(bytes(await client.read_gatt_char(OTA_STATUS)))
        if not status['installed'] or status['layout'] != 1 or len(image)>status['capacity']:
            raise RuntimeError('Missing/incompatible bootloader or image too large')
        async def wait_status(predicate, seconds=15):
            until = time.monotonic()+seconds
            while client.is_connected and time.monotonic()<until:
                value = decode_status(bytes(await client.read_gatt_char(OTA_STATUS)))
                if value['error']: raise RuntimeError(f'OTA rejected: {value}')
                if predicate(value): return value
                await asyncio.sleep(.01)
            raise TimeoutError('Timed out awaiting durable OTA acknowledgement')
        await client.write_gatt_char(OTA_CONTROL,bytes([1,4,0,0])+hashlib.sha512(image).digest()+bytes(4),response=True)
        await wait_status(lambda s:s['digest_received'])
        begin = bytes([1,1,0,0])+struct.pack('<I',len(image))+bytes.fromhex(package['signature'])
        await client.write_gatt_char(OTA_CONTROL, begin, response=True)
        await wait_status(lambda s:s['state']==1 and s['total']==len(image) and s['received']==0,30)
        chunk = min(status['chunk'], 112)
        if client.mtu_size < 75: raise RuntimeError('ATT MTU >= 75 required')
        chunk = min(chunk, (client.mtu_size-7)//4*4)
        for offset in range(0,len(image),chunk):
            payload = image[offset:offset+chunk]
            await client.write_gatt_char(OTA_DATA,struct.pack('<I',offset)+payload,response=True)
            await wait_status(lambda s:s['received']==offset+len(payload))
            if offset//4096 != (offset+len(payload))//4096 or offset+len(payload)==len(image):
                print(json.dumps({'event':'progress','received':offset+len(payload),'total':len(image)}),flush=True)
        completed = asyncio.get_running_loop().create_future()
        def notified(_, wire):
            value=decode_status(bytes(wire))
            if value['state']==2 and not completed.done(): completed.set_result(value)
            elif value['error'] and not completed.done(): completed.set_exception(RuntimeError(f'OTA rejected: {value}'))
        await client.start_notify(OTA_STATUS,notified)
        await client.write_gatt_char(OTA_CONTROL,bytes([1,2])+bytes(70),response=True)
        await asyncio.wait_for(completed,30)
        print(json.dumps({'event':'update_scheduled','serial':serial,'version':package['version']}),flush=True)
        until = time.monotonic()+10
        while client.is_connected and time.monotonic()<until: await asyncio.sleep(.1)
        if client.is_connected: raise RuntimeError('Verified update was scheduled but device did not restart')
    # App boot opens a bounded verification window after an OTA trial.
    devices=await discover(45,wait_for_first=True,address=dev.address)
    if len(devices)!=1: raise RuntimeError('Update scheduled, but new firmware did not advertise for verification')
    async with BleakClient(devices[0][0],timeout=30) as client:
        if (await client.read_gatt_char(SERIAL)).decode()!=serial: raise RuntimeError('Wrong device after OTA')
        version=(await client.read_gatt_char(FIRMWARE)).decode()
        after=await profile_snapshot(client)
        after['name']=devices[0][1].local_name
        preserved=(before['name']==after['name'] and before['profile_sha256']==after['profile_sha256']
                   and before['mode']==after['mode'] and after['rotation']>=before['rotation'])
        report={'serial':serial,'previous_version':before_version,'version':version,
                'expected_version':package['version'],'preserved':preserved,'before':before,'after':after}
        if args.report: write_new(args.report,(json.dumps(report,indent=2)+'\n').encode())
        print(json.dumps(report,ensure_ascii=False),flush=True)
        if version!=package['version'] or not preserved: raise RuntimeError('Post-OTA version/configuration check failed')


def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__)
    commands=parser.add_subparsers(dest='command',required=True)
    commands.add_parser('init-key')
    p=commands.add_parser('build'); p.add_argument('output',type=Path)
    p.add_argument('--version',default='0.1.0'); p.add_argument('--key',type=Path,default=PRIVATE_KEY)
    p.add_argument('--public-key',type=Path,default=PUBLIC_KEY)
    p=commands.add_parser('upload'); p.add_argument('package',type=Path); p.add_argument('--address')
    p.add_argument('--timeout',type=float,default=120); p.add_argument('--report',type=Path)
    args=parser.parse_args()
    if args.command=='init-key':
        init_key(); print(json.dumps({'private_key':str(PRIVATE_KEY),'public_key':str(PUBLIC_KEY)}))
    elif args.command=='build': build(args)
    else: asyncio.run(upload(args))


if __name__=='__main__': main()
