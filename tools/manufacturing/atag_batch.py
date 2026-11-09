#!/usr/bin/env python3
"""Prepare five unconfigured ATAGs, or flash and verify one physical unit."""
from __future__ import annotations

import argparse
import asyncio
import csv
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
CHIP = 'nRF52832_xxAA'
DEFAULT_PROBE = '1366:0105:000602710998'
SERVICE = '0f4a0000-9b5b-4f04-9c22-a38b0a6e6db7'
LED_HARDWARE_ADDRESS = 0x10001080
LED_HARDWARE_DESCRIPTOR = b'ATGH\x01\x01\x1e\x01'


def run(command):
    completed = subprocess.run([str(part) for part in command], cwd=ROOT,
                               text=True, capture_output=True)
    if completed.returncode:
        raise RuntimeError((completed.stderr or completed.stdout).strip()[-3000:])
    return completed.stdout


def checksum(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save_json(path, data):
    with tempfile.NamedTemporaryFile('w', dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        os.chmod(temporary, 0o600)
        json.dump(data, stream, indent=2, ensure_ascii=False)
        stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, path)


def read_hex(path):
    result = {}; base = 0
    for line in path.read_text().splitlines():
        if not line: continue
        row = bytes.fromhex(line.removeprefix(':'))
        if len(row) != row[0] + 5 or sum(row) & 255:
            raise ValueError(f'Invalid Intel HEX checksum: {path}')
        length, kind = row[0], row[3]
        address = base + int.from_bytes(row[1:3], 'big')
        if kind == 0:
            for offset, value in enumerate(row[4:4+length]):
                if address+offset in result and result[address+offset] != value:
                    raise ValueError('Conflicting Intel HEX data')
                result[address+offset] = value
        elif kind == 4: base = int.from_bytes(row[4:6], 'big') << 16
        elif kind == 2: base = int.from_bytes(row[4:6], 'big') << 4
        elif kind not in (1, 3, 5): raise ValueError(f'Unsupported HEX record {kind}')
    return result


def merge(destination, source):
    for address, value in source.items():
        if address in destination and destination[address] != value:
            raise ValueError(f'Overlapping firmware sections at {address:#x}')
        destination[address] = value


def write_hex(path, memory):
    def record(address, kind, data):
        row = bytes([len(data)]) + address.to_bytes(2, 'big') + bytes([kind]) + data
        return ':' + (row + bytes([-sum(row) & 255])).hex().upper()
    addresses = sorted(memory); lines = []; position = 0; upper = None
    while position < len(addresses):
        address = addresses[position]
        if address >> 16 != upper:
            upper = address >> 16
            lines.append(record(0, 4, upper.to_bytes(2, 'big')))
        data = bytearray([memory[address]]); position += 1
        while (position < len(addresses) and len(data) < 16
               and addresses[position] == address + len(data)
               and addresses[position] >> 16 == upper):
            data.append(memory[addresses[position]]); position += 1
        lines.append(record(address & 0xffff, 0, data))
    lines.append(':00000001FF')
    path.write_text('\n'.join(lines) + '\n'); path.chmod(0o600)


def prepare(args):
    output = args.output.resolve()
    if output.exists(): raise ValueError('Output directory already exists; choose a new batch directory')
    run(['cargo', 'build-nrf52832'])
    run(['cargo', 'build-bootloader'])
    run(['cargo', 'build', '--release', '--package', 'atagctl'])
    output.mkdir(parents=True, mode=0o700)
    shared = output / 'shared'; shared.mkdir(mode=0o700)
    firmware = shared / 'atag-nrf52832.elf'
    softdevice = shared / 's112-7.3.0.hex'
    shutil.copy2(ROOT / 'target/thumbv7em-none-eabihf/release/atag-nrf52832', firmware)
    shutil.copy2(ROOT / 'firmware-nrf52832/s112/s112_nrf52_7.3.0_softdevice.hex', softdevice)
    shutil.copy2(ROOT / 'firmware-nrf52832/ota-public-key.bin', shared / 'ota-public-key.bin')
    app_hex = shared / 'application.hex'
    boot_hex = shared / 'bootloader.hex'
    objcopy = shutil.which('arm-none-eabi-objcopy')
    if objcopy is None: raise RuntimeError('arm-none-eabi-objcopy is required')
    run([objcopy, '-O', 'ihex', firmware, app_hex])
    run([objcopy, '-O', 'ihex', ROOT / 'target/thumbv7em-none-eabihf/release/atag-bootloader-nrf52832', boot_hex])
    application = read_hex(app_hex)
    if min(application) != 0x19000 or max(application) >= 0x41000:
        raise ValueError('Application is outside the S112/application flash layout')
    base = read_hex(softdevice); merge(base, application)
    merge(base, read_hex(boot_hex))
    has_led = bool(getattr(args,'has_led',False))
    if has_led:
        merge(base,{LED_HARDWARE_ADDRESS+i:value for i,value in enumerate(LED_HARDWARE_DESCRIPTOR)})
    for address in (0x10001200, 0x10001204):
        for offset, value in enumerate((21).to_bytes(4, 'little')):
            previous = base.get(address+offset, 0xff)
            if previous not in (0xff, value): raise ValueError('Conflicting nRESET UICR data')
            base[address+offset] = value
    manifest = {'schema': 1, 'created_utc': datetime.now(timezone.utc).isoformat(),
                'firmware_version': '0.1.0', 'softdevice': 'S112 7.3.0',
                'hardware': {'has_led':has_led,'led_pin':30 if has_led else None,'led_active_low':has_led},
                'ota_layout': 1,
                'regulator': 'LDO', 'lfclk': 'external_32768_hz',
                'factory_mode': 'unconfigured', 'count': args.count,
                'files': {}, 'units': []}
    names = set()
    for number in range(1, args.count+1):
        while True:
            name = 'ATAG-' + secrets.token_hex(4).upper()
            if name not in names: break
        names.add(name)
        identifier = f'unit-{number:02d}'
        directory = output / identifier; directory.mkdir(mode=0o700)
        run([ROOT / 'target/release/atagctl', 'generate-unconfigured', directory,
             identifier, name])
        profile = directory / f'{identifier}.provisioning-record.bin'
        payload = profile.read_bytes()
        if len(payload) != 256: raise ValueError('Unexpected profile record size')
        image = dict(base)
        merge(image, {0x7c000+offset: value for offset, value in enumerate(payload)})
        combined = directory / f'{identifier}-{name}.hex'
        write_hex(combined, image)
        if read_hex(combined) != image: raise ValueError('Combined HEX failed round-trip validation')
        manifest['units'].append({'unit': identifier, 'name': name, 'state': 'pending',
                                  'chip_id': None, 'image': str(combined.relative_to(output)),
                                  'profile': str(profile.relative_to(output))})
    with (output / 'labels.csv').open('w', newline='') as stream:
        writer = csv.writer(stream); writer.writerow(['unit', 'initial_name', 'image'])
        writer.writerows((unit['unit'], unit['name'], unit['image']) for unit in manifest['units'])
    (output / 'labels.csv').chmod(0o600)
    for path in output.rglob('*'):
        if path.is_file():
            path.chmod(0o600)
            manifest['files'][str(path.relative_to(output))] = checksum(path)
    save_json(output / 'manifest.json', manifest)
    print(json.dumps({'batch': str(output), 'units': [{'unit': unit['unit'], 'name': unit['name']}
                                                     for unit in manifest['units']]}, ensure_ascii=False))


def probe_command(args, operation, *tail):
    return ['probe-rs', operation, '--chip', CHIP, '--probe', args.probe,
            '--speed', str(args.speed), *tail]


def read_words(args, address, count):
    text = run(probe_command(args, 'read', 'b32', hex(address), str(count)))
    rows = [line.split(':', 1)[1] for line in text.splitlines() if re.match(r'^[0-9a-fA-F]+:', line)]
    words = [int(value, 16) for row in rows for value in row.split()]
    if len(words) != count: raise ValueError('Unexpected SWD readback')
    return words


async def verify_ble(unit, serial, firmware_version):
    from bleak import BleakClient, BleakScanner
    device = await BleakScanner.find_device_by_filter(
        lambda _device, adv: SERVICE in adv.service_uuids and adv.local_name == unit['name'],
        timeout=20)
    if device is None: raise RuntimeError('Expected named setup advertisement was not found')
    uuids = {'serial': '00002a25-0000-1000-8000-00805f9b34fb',
             'firmware': '00002a26-0000-1000-8000-00805f9b34fb',
             'model': '00002a24-0000-1000-8000-00805f9b34fb'}
    result = {'address': device.address, 'advertised_name': unit['name']}
    battery_uuid = '0f4a0004-9b5b-4f04-9c22-a38b0a6e6db7'
    async with BleakClient(device, timeout=30) as client:
        for field, uuid in uuids.items(): result[field] = (await client.read_gatt_char(uuid)).decode()
        if result['serial'] != serial or result['firmware'] != firmware_version:
            raise RuntimeError('BLE identity/version does not match programmed board')
        result['battery_mv'] = int.from_bytes(await client.read_gatt_char(battery_uuid), 'little')
        if not 2300 <= result['battery_mv'] <= 4350:
            raise RuntimeError('Battery-divider voltage outside production acceptance range')
        samples = []
        await client.start_notify(battery_uuid, lambda _, data: samples.append(bytes(data)))
        await asyncio.sleep(3)
        result['battery_notifications'] = len(samples)
        if not client.is_connected or len(samples) < 2:
            raise RuntimeError('BLE notification/connection check failed')
    return result


def flash(args):
    batch = args.batch.resolve()
    with (batch / '.flash.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        manifest_path = batch / 'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        for relative, expected in manifest['files'].items():
            path = (batch / relative).resolve()
            if not path.is_relative_to(batch) or checksum(path) != expected:
                raise ValueError(f'Batch file changed: {relative}')
        candidates = [unit for unit in manifest['units'] if unit['unit'] == args.unit] if args.unit else [unit for unit in manifest['units'] if unit['state'] == 'pending']
        if not candidates: raise ValueError('No matching pending unit')
        unit = candidates[0]
        if unit['state'] != 'pending' and not args.retry:
            raise ValueError('Unit already attempted; inspect its report and use --retry explicitly')
        info = read_words(args, 0x10000100, 5)
        if info[0] != 0x52832 or info[3] != 64 or info[4] != 512:
            raise ValueError('Expected nRF52832 with 64 KiB RAM and 512 KiB flash')
        words = read_words(args, 0x10000060, 2)
        chip = '-'.join(f'{value:08x}' for value in words)
        serial = b''.join(value.to_bytes(4, 'little') for value in words).hex()
        for other in manifest['units']:
            if other['unit'] != unit['unit'] and other.get('chip_id') == chip:
                raise ValueError(f'This board is already assigned to {other["unit"]}; connect the next physical board')
        if unit.get('chip_id') not in (None, chip):
            raise ValueError('Retry must use the originally assigned physical board')
        unit.update(chip_id=chip, state='flashing', attempted_utc=datetime.now(timezone.utc).isoformat())
        save_json(manifest_path, manifest)
        try:
            backup = batch / 'backups' / chip; backup.mkdir(parents=True, exist_ok=True, mode=0o700)
            for name, address, count in [('flash.bin', 0, 131072), ('uicr.bin', 0x10001000, 256)]:
                path = backup / name
                if not path.exists():
                    run(probe_command(args, 'read', '--output', path, '--format', 'binary', 'b32', hex(address), str(count)))
                    path.chmod(0o600)
            run(probe_command(args, 'erase', '--allow-erase-all'))
            run(probe_command(args, 'download', '--verify', '--reset', '--binary-format', 'hex', batch / unit['image']))
            result = asyncio.run(verify_ble(unit, serial, manifest['firmware_version']))
            report = {'unit': unit['unit'], 'chip_id': chip, 'passed': True, **result}
            reports = batch / 'reports'; reports.mkdir(exist_ok=True, mode=0o700)
            save_json(reports / f'{unit["unit"]}.json', report)
            unit.update(state='verified', verified_utc=datetime.now(timezone.utc).isoformat(), report=f'reports/{unit["unit"]}.json')
            unit.pop('error', None)
        except Exception as error:
            unit.update(state='failed', error=str(error)); save_json(manifest_path, manifest)
            raise
        save_json(manifest_path, manifest)
        print(json.dumps({'verified': unit['unit'], 'name': unit['name'], 'chip_id': chip,
                          'remaining': sum(item['state'] == 'pending' for item in manifest['units'])}))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    prepare_parser = commands.add_parser('prepare')
    prepare_parser.add_argument('output', type=Path)
    prepare_parser.add_argument('--count', type=int, default=5)
    prepare_parser.add_argument('--has-led',action='store_true',help='Only for boards with an active-low LED on P0.30')
    flash_parser = commands.add_parser('flash')
    flash_parser.add_argument('batch', type=Path)
    flash_parser.add_argument('--unit')
    flash_parser.add_argument('--probe', default=DEFAULT_PROBE)
    flash_parser.add_argument('--speed', type=int, default=1000)
    flash_parser.add_argument('--retry', action='store_true')
    args = parser.parse_args()
    if args.command == 'prepare':
        if not 1 <= args.count <= 100: parser.error('count must be 1..100')
        prepare(args)
    else: flash(args)


if __name__ == '__main__': main()
