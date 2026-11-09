#!/usr/bin/env python3
"""Read/monitor ATAG telemetry or configure a physically opened GATT window.

Accessing protected information/configuration triggers Just Works pairing on
macOS. The firmware keeps session encryption keys only until disconnect.
"""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import struct
import zlib

from bleak import BleakClient, BleakScanner
from bleak.exc import BleakError
from settings_codec import decode_settings, encode_name, encode_settings

SERVICE = "0f4a0000-9b5b-4f04-9c22-a38b0a6e6db7"
CONFIG = "0f4a0001-9b5b-4f04-9c22-a38b0a6e6db7"
STATUS = "0f4a0002-9b5b-4f04-9c22-a38b0a6e6db7"
INFO = "0f4a0003-9b5b-4f04-9c22-a38b0a6e6db7"
BATTERY = "0f4a0004-9b5b-4f04-9c22-a38b0a6e6db7"
CONTROL = "0f4a0005-9b5b-4f04-9c22-a38b0a6e6db7"
NAME = "0f4a0006-9b5b-4f04-9c22-a38b0a6e6db7"
SETTINGS = "0f4a0007-9b5b-4f04-9c22-a38b0a6e6db7"
BUTTON_EVENTS = "0f4a0008-9b5b-4f04-9c22-a38b0a6e6db7"
PAIRING = "0f4a0009-9b5b-4f04-9c22-a38b0a6e6db7"
PROFILE_SNAPSHOT = "0f4a000d-9b5b-4f04-9c22-a38b0a6e6db7"
GAP_NAME = "00002a00-0000-1000-8000-00805f9b34fb"
MODEL = "00002a24-0000-1000-8000-00805f9b34fb"
FIRMWARE = "00002a26-0000-1000-8000-00805f9b34fb"
SERIAL = "00002a25-0000-1000-8000-00805f9b34fb"


def decode_information(data: bytes) -> dict:
    if len(data) != 40 or data[0] != 1:
        raise ValueError("Expected a 40-byte version-one telemetry packet")
    (version, mode, phase, flags, battery, supply, uptime, rotation, interval,
     reset, device_id, advertising_left, connection_left, low, recovery) = struct.unpack(
         "<BBBBHHIIII8sHHHH", data)
    return {
        "version": version, "mode": mode, "phase": phase,
        "button_pressed": bool(flags & 1), "undervoltage": bool(flags & 2),
        "encrypted": bool(flags & 4), "reset_pin_enabled": bool(flags & 8),
        "external_lfclk": bool(flags & 16), "dcdc": bool(flags & 32),
        "has_led": bool(flags & 64), "led_enabled": bool(flags & 128),
        "battery_mv": battery, "supply_mv": supply, "uptime_seconds": uptime,
        "rotation": rotation, "rotation_interval_seconds": interval,
        "reset_reason": f"0x{reset:08x}", "device_id": device_id.hex(),
        "advertising_seconds_left": advertising_left,
        "connection_seconds_left": connection_left,
        "overdischarge_mv": low, "recovery_mv": recovery,
    }


def decode_hardware(wire: bytes) -> dict:
    if len(wire) != 40 or wire[0] != 1:
        raise ValueError('Expected a 40-byte profile snapshot')
    return {'has_led': bool(wire[2] & 1), 'led_enabled': bool(wire[3] & 1),
            'led_identifying': bool(wire[3] & 2)}


async def discover(timeout: float, *, wait_for_first: bool = False, address: str | None = None) -> list:
    results = {}
    found = asyncio.Event()

    def received(device, advertisement):
        if SERVICE in [uuid.lower() for uuid in advertisement.service_uuids] and (address is None or device.address == address):
            results[device.address] = (device, advertisement)
            found.set()

    async with BleakScanner(received):
        if wait_for_first:
            try:
                await asyncio.wait_for(found.wait(), timeout=timeout)
            except TimeoutError:
                return []
            # Briefly collect peers so a second ATAG requires explicit selection.
            await asyncio.sleep(1)
        else:
            await asyncio.sleep(timeout)
    return list(results.values())


async def run(args: argparse.Namespace) -> None:
    if args.command == "scan":
        for dev, adv in await discover(args.timeout):
            print(json.dumps({"address": dev.address, "name": adv.local_name or dev.name,
                              "rssi": adv.rssi}), flush=True)
        return
    devices = await discover(args.timeout, wait_for_first=True, address=args.address)
    if len(devices) != 1:
        raise RuntimeError(f"Found {len(devices)} ATAG devices; press P0.13, or use scan and --address")
    dev, advertisement = devices[0]
    async with BleakClient(dev, timeout=30) as client:
        public = {"address": dev.address, "name": dev.name}
        for key, uuid in (("model", MODEL), ("firmware", FIRMWARE), ("serial", SERIAL)):
            public[key] = (await client.read_gatt_char(uuid)).decode()
        public["battery_mv"] = int.from_bytes(await client.read_gatt_char(BATTERY), "little")
        public["device_name"] = advertisement.local_name or dev.name
        if client.services.get_characteristic(PROFILE_SNAPSHOT) is not None:
            public.update(decode_hardware(bytes(await client.read_gatt_char(PROFILE_SNAPSHOT))))
        print(json.dumps(public), flush=True)
        if args.command in ('find-led', 'stop-led'):
            if args.command == 'find-led':
                if not public.get('has_led'): raise RuntimeError('This tag has no LED; use identify to locate it by button press')
                if not public.get('led_enabled'): raise RuntimeError('Enable led_enabled in settings before LED identification')
            await ensure_security(client)
            await write_committed(client, CONTROL, bytes([3 if args.command=='find-led' else 4]),
                                  7 if args.command=='find-led' else 8, 9)
            print(json.dumps({'led_identifying':args.command=='find-led','maximum_seconds':10}),flush=True)
            if args.command=='find-led':
                # Disconnect cancels identification. Keep this session open for the pattern.
                await asyncio.sleep(10.2)
            return
        if args.command in ('identify', 'watch-buttons'):
            last_count = int.from_bytes(await client.read_gatt_char(BUTTON_EVENTS), 'little')
            pressed = asyncio.Event()
            def button_changed(_sender, data):
                nonlocal last_count
                count = int.from_bytes(data, 'little')
                if count != last_count:
                    print(json.dumps({'event': 'button_pressed', 'button_count': count,
                                      'serial': public['serial'], 'device_name': public['device_name'],
                                      'address': dev.address}, ensure_ascii=False), flush=True)
                    pressed.set()
                last_count = count
            await client.start_notify(BUTTON_EVENTS, button_changed)
            print(json.dumps({'waiting_for_button': True, 'seconds': args.seconds}), flush=True)
            end = asyncio.get_running_loop().time() + args.seconds
            while client.is_connected and asyncio.get_running_loop().time() < end:
                if args.command == 'identify' and pressed.is_set():
                    return
                await asyncio.sleep(.1)
            if args.command == 'identify' and not pressed.is_set():
                raise RuntimeError('No button press received for this connection')
            return
        if args.command == "info":
            if not args.public:
                await ensure_security(client)
                print(json.dumps(decode_information(bytes(await client.read_gatt_char(INFO)))), flush=True)
        elif args.command == "monitor":
            await ensure_security(client)
            print(json.dumps(decode_information(bytes(await client.read_gatt_char(INFO)))), flush=True)
            await client.start_notify(INFO, lambda _sender, data:
                                     print(json.dumps(decode_information(bytes(data))), flush=True))
            end = asyncio.get_running_loop().time() + args.seconds
            while client.is_connected and asyncio.get_running_loop().time() < end:
                await asyncio.sleep(.2)
        elif args.command == "configure":
            data = args.payload.read_bytes()
            if len(data) != 104 or data[:4] != b"ATAG" or zlib.crc32(data[:100]) != int.from_bytes(data[100:], "little"):
                raise ValueError("Invalid 104-byte ATAG configuration")
            # CoreBluetooth initiates SMP reliably on a protected read. A first
            # protected write can instead fail with Insufficient Encryption.
            await ensure_security(client)
            await write_committed(client, CONFIG, data, 1, 2)
            print(json.dumps({"configuration_committed": True}), flush=True)
        elif args.command == 'rename':
            raw = encode_name(args.name)
            await ensure_security(client)
            await write_committed(client, NAME, raw, 3, 4)
            print(json.dumps({'name_committed': args.name}, ensure_ascii=False), flush=True)
        elif args.command in ('settings', 'set-settings'):
            await ensure_security(client)
            settings = decode_settings(bytes(await client.read_gatt_char(SETTINGS)))
            if args.command == 'set-settings':
                updates = json.loads(args.file.read_text()) if args.file else {}
                if not isinstance(updates, dict):
                    raise ValueError('Settings file must contain a JSON object')
                for item in args.set:
                    field, separator, value = item.partition('=')
                    if not separator:
                        raise ValueError('Use --set field=value')
                    updates[field] = json.loads(value)
                if not updates:
                    raise ValueError('Provide --file or at least one --set')
                settings.update(updates)
                await write_committed(client, SETTINGS, encode_settings(settings), 5, 6)
                print(json.dumps({'settings_committed': True}), flush=True)
            print(json.dumps(settings, ensure_ascii=False), flush=True)
        else:
            await ensure_security(client)
            await client.write_gatt_char(CONTROL,
                bytes([1 if args.command == "reboot" else 2]), response=True)
            print(json.dumps({"command_accepted": args.command}), flush=True)


async def write_committed(client, characteristic, data, accepted_code, rejected_code):
    completed = asyncio.get_running_loop().create_future()

    def status_received(_sender, status):
        if len(status) < 3 or completed.done():
            return
        if status[1] == accepted_code:
            completed.set_result(None)
        elif status[1] == rejected_code:
            completed.set_exception(ValueError(f'Device rejected update (code {status[2]})'))

    await client.start_notify(STATUS, status_received)
    try:
        await client.write_gatt_char(characteristic, data, response=True)
        await asyncio.wait_for(completed, timeout=15)
    finally:
        if not completed.done():
            completed.cancel()
        if client.is_connected:
            try:
                await client.stop_notify(STATUS)
            except BleakError:
                pass  # A commit can deliberately close the current session.


async def ensure_security(client, timeout=90):
    """Pair explicitly before a protected ATT operation, avoiding stuck reads."""
    if bytes(await client.read_gatt_char(PAIRING)) == b'\x02':
        return
    await client.write_gatt_char(PAIRING, b'\x01', response=True)
    print(json.dumps({'waiting_for_pairing': True}), flush=True)
    end = asyncio.get_running_loop().time() + timeout
    while client.is_connected and asyncio.get_running_loop().time() < end:
        try:
            if bytes(await client.read_gatt_char(PAIRING, timeout=3)) == b'\x02':
                return
        except TimeoutError:
            pass
        await asyncio.sleep(.25)
    raise RuntimeError('Pairing did not complete before the connection deadline')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--address")
    parser.add_argument("--timeout", type=float, default=8)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("scan")
    info = commands.add_parser("info")
    info.add_argument("--public", action="store_true", help="Only read unencrypted identity/voltage")
    monitor = commands.add_parser("monitor")
    monitor.add_argument("--seconds", type=float, default=10)
    configure = commands.add_parser("configure")
    configure.add_argument("payload", type=Path)
    rename = commands.add_parser('rename')
    rename.add_argument('name', help='1..29 UTF-8 bytes')
    commands.add_parser('settings')
    settings = commands.add_parser('set-settings')
    settings.add_argument('--file', type=Path)
    settings.add_argument('--set', action='append', default=[], metavar='FIELD=JSON_VALUE')
    for command in ('identify', 'watch-buttons'):
        buttons = commands.add_parser(command)
        buttons.add_argument('--seconds', type=float, default=30)
    commands.add_parser("reboot")
    commands.add_parser("factory-reset")
    commands.add_parser('find-led')
    commands.add_parser('stop-led')
    asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    main()
