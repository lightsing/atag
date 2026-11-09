# ATAG Bluetooth OTA

Build and upload signed application updates for the current nRF52832 firmware.
Factory programming installs S112 and the Embassy bootloader; see
[manufacturing](../manufacturing/README.md). Bluetooth OTA replaces the application.

## Signing and building

Install the repository Python requirements and Rust `thumbv7em-none-eabihf`
target; `arm-none-eabi-objcopy` is required to extract images.
The signing private key is `.ota/signing-key.pem`. Its matching public key is
`firmware-nrf52832/ota-public-key.bin` and is compiled into the application.
`init-key` creates a new pair only when neither file exists. Keep the deployed
key pair for subsequent releases.

```sh
.venv/bin/python tools/ota/atag_ota.py build production/my-release --version 0.1.0
```

The new, empty output directory receives application/bootloader HEX files, the
public key, a signed `.atag-ota` package and a hash manifest. Versions use X.Y.Z
with single-digit components. The package signs SHA512 of the word-padded
application with Ed25519. It excludes S112, bootloader, UICR and user storage.

## Uploading

Press P0.13 to open the management window, scan and select the intended address:

```sh
.venv/bin/python tools/gatt/atag_gatt.py scan
.venv/bin/python tools/ota/atag_ota.py upload production/my-release/atag-0.1.0.atag-ota --address ADDRESS --report test-artifacts/ota-report.json
```

The client verifies the signature before transfer, waits for durable chunk
acknowledgements, and reconnects after restart to check firmware version,
serial, name, profile fingerprint and nondecreasing key round. Pairing is not
required for signed OTA; settings and key writes require session encryption.

An interrupted upload can be restarted. Swap/revert resumes after power loss.
An unconfirmed trial reverts on reset; a 30-second watchdog recovers a hung
application. Successful startup confirms the image. Firmware-version downgrade
prevention is not implemented. The protocol is ATAG-specific; there is no web
OTA interface.

## Verification

```sh
cargo test -p atag-firmware-nrf52832 --lib --locked
.venv/bin/python -m unittest discover -s tools/ota -v
```

Tests cover signatures, target/length/offset validation, application confirmation,
rollback and interrupted writes/erases at swap/revert boundaries while preserving
user pages. See [firmware protocol](../../firmware-nrf52832/README.md) for layouts,
partitions, battery limits and timeouts. Hardware acceptance must be run for the
particular release and board.
