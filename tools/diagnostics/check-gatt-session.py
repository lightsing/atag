#!/usr/bin/env python3
"""Observe a button-opened ATAG session until its absolute timeout."""
import argparse
import asyncio
import json
from pathlib import Path
import sys

from bleak import BleakClient, BleakScanner

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "gatt"))
from atag_gatt import BATTERY, FIRMWARE, INFO, MODEL, SERIAL, SERVICE, decode_information, ensure_security


async def run(args):
    device = await BleakScanner.find_device_by_filter(
        lambda _device, advertisement: SERVICE in advertisement.service_uuids,
        timeout=args.wait,
    )
    if device is None:
        raise RuntimeError("No ATAG GATT window observed")
    print(json.dumps({"gatt_window_found": device.address}), flush=True)
    disconnected = asyncio.Event()
    samples = []
    loop = asyncio.get_running_loop()

    def received(_sender, payload):
        sample = decode_information(bytes(payload))
        previous = samples[-1] if samples else None
        samples.append(sample)
        if previous is None or any(previous[key] != sample[key]
                                   for key in ("rotation", "encrypted")):
            print(json.dumps(sample), flush=True)

    async with BleakClient(device, disconnected_callback=lambda _: disconnected.set()) as client:
        connected_at = loop.time()
        identity = {}
        for name, uuid in (("model", MODEL), ("firmware", FIRMWARE), ("serial", SERIAL)):
            identity[name] = (await client.read_gatt_char(uuid)).decode()
        identity["battery_mv"] = int.from_bytes(await client.read_gatt_char(BATTERY), "little")
        print(json.dumps(identity), flush=True)
        await ensure_security(client)
        received(None, await client.read_gatt_char(INFO, timeout=90))
        await client.start_notify(INFO, received)
        await asyncio.wait_for(disconnected.wait(), timeout=130)
        elapsed = loop.time() - connected_at
    result = {
        "address": device.address,
        "identity": identity,
        "connected_seconds": elapsed,
        "sample_count": len(samples),
        "timeout_passed": 110 <= elapsed <= 125 and samples[-1]["connection_seconds_left"] <= 2,
        "encrypted_notification_seen": any(item["encrypted"] for item in samples[1:]),
        "rotations_seen": sorted({item["rotation"] for item in samples}),
        "samples": samples,
    }
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    args.output.chmod(0o600)
    print(json.dumps({key: value for key, value in result.items() if key != "samples"}), flush=True)
    if not result["timeout_passed"] or not result["encrypted_notification_seen"]:
        raise RuntimeError("Session timeout/encryption verification failed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--wait", type=float, default=180)
    asyncio.run(run(parser.parse_args()))
