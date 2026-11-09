#!/usr/bin/env python3
"""Match an on-air Offline Finding payload to a local atagctl manifest."""
import argparse
import asyncio
import base64
import json
from pathlib import Path

from bleak import BleakScanner


async def run(args):
    expected = {}
    for line in args.manifest.read_text().splitlines():
        label, _, value = line.partition("=")
        if label == "advertisement_key_base64" or label.endswith(".advertisement_key_base64"):
            key = base64.b64decode(value, validate=True)
            if len(key) != 28:
                raise ValueError("Manifest contains an invalid advertisement key")
            rotation = int(label.split(".")[1]) if label.startswith("rotation.") else 0
            expected[b"\x12\x19\x00" + key[6:] + bytes([key[0] >> 6, 0])] = rotation
    if not expected:
        raise ValueError("Manifest contains no advertisement keys")
    found = asyncio.Event()
    observations = []

    def received(device, advertisement):
        data = advertisement.manufacturer_data.get(0x004c)
        if data is None or len(data) != 27:
            return
        normalized = data[:2] + b"\x00" + data[3:]
        if normalized not in expected:
            return
        code = ((data[2] >> 2) & 0x30) | (data[2] & 0x0f)
        observations.append({
            "address": device.address, "rotation": expected[normalized],
            "rssi": advertisement.rssi, "status": data[2],
            "battery_mv_encoded": 4200 - (code * 1800 + 31) // 63,
        })
        found.set()

    async with BleakScanner(received):
        await asyncio.wait_for(found.wait(), timeout=args.timeout)
    result = {"matching_offline_finding": observations}
    if args.output:
        args.output.write_text(json.dumps(result, indent=2) + "\n")
        args.output.chmod(0o600)
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--timeout", type=float, default=20)
    parser.add_argument("--output", type=Path)
    asyncio.run(run(parser.parse_args()))
