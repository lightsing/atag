# ATAG nRF52832 firmware 0.1.0

Embassy/Rust with S112 7.3.0. Production configuration uses LDO and an external
32.768 kHz crystal. Device names and settings persist in Flash. Factory units
have independent random names and await GATT initialization; no Find My keys
are preinstalled. Signed application OTA uses a separate Embassy bootloader, trial boot and
automatic rollback on an unconfirmed reset. Optional active-low P0.30 LED
identification is gated by the board hardware descriptor.

## Board

| Pin | Function |
| --- | --- |
| P0.28 / AIN4 | VBAT → 1 MΩ → AIN4 → 1.5 MΩ → GND |
| P0.13 | Active-low button with internal pull-up and GPIO event wakeup |
| P0.21 | nRESET; external 10 kΩ pull-up; both UICR.PSELRESET words = 21 |
| P0.17 | Unused |
| P0.30 | Optional active-low LED; untouched when hardware capability is absent |
| UART | Not initialized |

DC/DC and clock selection are fixed in this build: LDO and external LFXO.

## Startup, button and connection flow

1. Load the latest committed device profile and rolling checkpoint.
2. If no display name exists, generate ATAG-XXXXXXXX using hardware randomness
   and save it before advertising. Normal resets preserve the name. Factory
   images preinstall an independent random name for each device.
3. A configured device starts fixed/rolling Offline Finding advertisements.
   An unconfigured boot opens one initial connectable window, then waits for
   the button after that window expires.
4. Short-press P0.13 to open the connectable window. The default waiting time
   is 60 seconds; once connected, the default connection lifetime is 120
   seconds, measured from establishment of that connection.
5. A short press while connected sends a button-counter notification. It does
   not extend the connection deadline or reset the device.
6. Holding P0.13 for the configured duration (default 5 seconds, following
   30 ms debounce) clears the active profile and reboots. Settings and keys
   become unconfigured, and a new random name is generated.
7. P0.21 reboots without clearing settings, display name or key checkpoint.
8. On disconnect/timeout, configured devices resume Offline Finding and
   unconfigured devices return to idle.

The advertised GATT name is unique in Setup as well as after initialization.
The standard GAP name and vendor name characteristic are updated on rename.
A host may cache a former peripheral name: use the current advertising local
name or vendor characteristic, and use the immutable chip serial as identity.
The GATT address remains stable across renames, settings changes and OTA updates.

## GATT service

Service UUID: 0f4a0000-9b5b-4f04-9c22-a38b0a6e6db7.
Suffixes below replace 0000 in that UUID. Numeric values are little-endian.

| Suffix | Value | Access |
| --- | --- | --- |
| 0001 | 104-byte ATAG key configuration with CRC32 | Encrypted write |
| 0002 | 8-byte operation status | Public read/notify |
| 0003 | 40-byte version-one telemetry | Encrypted read/notify |
| 0004 | uint16 battery terminal voltage in mV | Public read/notify |
| 0005 | uint8: 1 reboot; 2 factory reset; 3 find LED; 4 stop LED | Encrypted write |
| 0006 | Device name, 1..29 UTF-8 bytes, no control characters | Encrypted read/write |
| 0007 | 64-byte settings packet below | Encrypted read/write |
| 0008 | uint32 valid button-press counter since boot | Public read/notify |
| 0009 | Read 0 unencrypted or 2 encrypted; write 1 to request pairing | Public read/write/notify |
| 000a | 72-byte OTA command; BEGIN requires valid signature authorization | Public write |
| 000b | uint32 offset followed by 4..112 bytes of application data | Public write after signed BEGIN |
| 000c | 20-byte OTA state and durable received offset | Public read/notify |
| 000d | Version/mode/current round and SHA256 of name + settings + key configuration | Public read |

Standard Device Information service 180a exposes manufacturer, model,
firmware version and a 16-character FICR.DEVICEID serial. Some host APIs hide
the standard GAP name characteristic 2a00; the vendor name remains available.

Pairing is Just Works with session encryption, no PIN/MITM authentication and
no persistent bond store. Protected operations use session encryption.
The host tool requests pairing through 0009 and waits for state 2 before
issuing protected ATT operations. This avoids a protected read remaining
pending through a system pairing dialog. A system pairing confirmation may
still be necessary. While pairing is pending, reads may return 0; a write may
briefly be echoed as 1. State 2 alone indicates that encryption is ready.

For button identification, first read 0008 as the baseline, then subscribe.
A change means the user pressed this connected physical tag. Highlight the
corresponding connection/serial in the client; no LED is needed. The first
notification can contain the baseline and should not be treated as a press.

Status byte 0 is protocol version 1; byte 1 is the result:
0 waiting, 1 key configuration committed, 2 key configuration rejected,
3 name committed, 4 name rejected, 5 settings committed, 6 settings rejected;
7 LED identification started, 8 LED identification stopped, 9 LED request rejected.
LED results acknowledge a transient action, not a Flash commit. For result 9,
error byte 2 is 1 no hardware, 2 LED disabled, or 3 OTA busy. Settings rejection
6/error 2 means an LED enable was requested on hardware without an LED.
Byte 2 is a rejection code, byte 3 is key mode (0 unset, 1 fixed, 2 rotating).
Wait for the corresponding commit result; an ATT write response alone does
not indicate durable Flash storage. Send one update at a time.
Negotiate ATT MTU 128 (at least 107 for the key payload) and send each value
in one write-with-response operation; do not manually split the payload.

## Adjustable settings

| JSON field | Default | Allowed |
| --- | ---: | --- |
| led_enabled | false | boolean; enabling requires physical LED capability |
| advertising_interval_ms | 2000 | 100..10240 |
| gatt_interval_ms | 100 | 20..2000 |
| tx_power_dbm | 0 | -40, -20, -16, -12, -8, -4, 0, 3, 4 |
| rotation_minutes | 15 | 1..4294967295 |
| gatt_advertising_seconds | 60 | 10..3600 |
| connection_seconds | 120 | 10..3600 |
| battery_idle_seconds | 900 | 10..86400 |
| battery_gatt_seconds | 5 | 1..600 |
| reset_hold_seconds | 5 | 2..30 |
| battery_low_mv | 2400 | 1800..4200, below recovery |
| battery_recovery_mv | 2900 | 1800..4200, above low |
| battery_calibration_ppm | 0 | -100000..100000 |

Names, settings and keys are committed as one redundant profile. A settings
update preserves the key material and current round. Changing rotation period
starts a new interval from the update time without advancing/resetting the round.

After settings are committed, the current connection deadline is recalculated
from its original connection time. If the new deadline is already past, the
device sends the commit notification before disconnecting. Transmit power and
battery settings apply to the current session. Connectable advertising interval
and waiting-window length apply when the next advertising window starts,
because that advertising phase has already ended once a client is connected.
The reset-hold duration is sampled when the button press begins.

The 64-byte settings packet is versioned and protected by CRC32:

| Offset | Type | Field |
| --- | --- | --- |
| 0 | uint8 | Version = 1 |
| 1 | uint8 | bit 0 led_enabled; bits 7..1 reserved = 0 |
| 2 | int8 | tx_power_dbm |
| 3 | uint8 | Reserved = 0 |
| 4 | uint32 | advertising_interval_ms |
| 8 | uint32 | gatt_interval_ms |
| 12 | uint32 | rotation_minutes |
| 16 | uint16 | gatt_advertising_seconds |
| 18 | uint16 | connection_seconds |
| 20 | uint32 | battery_idle_seconds |
| 24 | uint16 | battery_gatt_seconds |
| 26 | uint16 | reset_hold_seconds |
| 28 | uint16 | battery_low_mv |
| 30 | uint16 | battery_recovery_mv |
| 32 | int32 | battery_calibration_ppm |
| 36..59 | 24 bytes | Reserved = 0 |
| 60 | uint32 | CRC32 of bytes 0..59 |

Key configuration uses the version-one 104-byte ATAG payload.
Committing a rotating key payload sets the initial rotation period from that
payload; later period-only changes should use 0007. A successful key
configuration reboots into broadcasting.

## Battery and telemetry

AIN4 = VBAT × 3/5; firmware multiplies the measured voltage by 5/3.
SAADC uses internal 0.6 V reference, gain 1/6, 12-bit resolution and 40 µs
acquisition on the 600 kΩ effective source. It calibrates, discards one scan,
averages eight scans of AIN4 and VDD, then disables/resets SAADC. The input
buffer and pulls on P0.28 are disabled.

Voltage is sampled at boot/GATT entry and at the configured periods. The
calibration multiplier is (1000000 + battery_calibration_ppm) / 1000000.
The low-voltage flag latches at or below the low threshold, clears at or above
recovery, and retains its prior value between thresholds. It is held in RAM.
These are indication thresholds; actual power cutoff/recovery remains the
battery protection circuit's function.

The Offline Finding status byte uses bits 7..6 and 3..0 for a descending
six-bit VBAT code. Bits 5..4 remain zero. Code 0 is 4200 mV or above, code 63
is 2400 mV or below; resolution is about 28.6 mV. This encoding range is fixed
independently of configurable low-voltage indication thresholds.

Telemetry is refreshed about once per second during GATT:

| Offset | Size | Value |
| --- | --- | --- |
| 0 | 1 | Version = 1 |
| 1 | 1 | Key mode: 0 unset, 1 fixed, 2 rotating |
| 2 | 1 | Phase: 0 idle, 1 Offline Finding, 2 GATT advertising, 3 connected |
| 3 | 1 | Flags: bit 0 button held; 1 low voltage; 2 encrypted; 3 nRESET; 4 LFXO; 5 DC/DC; 6 has LED; 7 LED enabled |
| 4 | 2 | Calibrated VBAT mV |
| 6 | 2 | VDD mV |
| 8 | 4 | Uptime seconds |
| 12 | 4 | Current key round |
| 16 | 4 | Active rotation interval seconds |
| 20 | 4 | Boot RESETREAS |
| 24 | 8 | FICR.DEVICEID, little-endian words |
| 32 | 2 | Advertising-window seconds remaining |
| 34 | 2 | Connection seconds remaining |
| 36 | 2 | Active low-voltage threshold mV |
| 38 | 2 | Active recovery threshold mV |

## Host commands

Use the existing virtual environment. Press P0.13 before connecting to an
idle device. When multiple devices advertise, select the address returned by scan.

    .venv/bin/python tools/gatt/atag_gatt.py scan
    .venv/bin/python tools/gatt/atag_gatt.py --address ADDRESS info --public
    .venv/bin/python tools/gatt/atag_gatt.py --address ADDRESS rename "我的标签"
    .venv/bin/python tools/gatt/atag_gatt.py --address ADDRESS settings
    .venv/bin/python tools/gatt/atag_gatt.py --address ADDRESS set-settings --set gatt_advertising_seconds=180
    .venv/bin/python tools/gatt/atag_gatt.py --address ADDRESS set-settings --set connection_seconds=300
    .venv/bin/python tools/gatt/atag_gatt.py --address ADDRESS identify --seconds 30
    .venv/bin/python tools/gatt/atag_gatt.py --address ADDRESS watch-buttons --seconds 60
    .venv/bin/python tools/gatt/atag_gatt.py --address ADDRESS set-settings --set led_enabled=true
    .venv/bin/python tools/gatt/atag_gatt.py --address ADDRESS find-led
    .venv/bin/python tools/gatt/atag_gatt.py --address ADDRESS stop-led

Identify waits for a physical press and prints that tag's name/serial.
Watch-buttons streams subsequent presses. Both work without pairing.
Set-settings accepts repeated --set FIELD=JSON_VALUE or --file settings.json,
merges changes with the current device settings, validates them, and waits for
the Flash commit result.

## Optional LED hardware

`has_led` is a read-only hardware capability, independent of the persisted
`led_enabled` permission (default false). Hardware identity lives in two UICR
customer words at 0x10001080, outside application OTA and factory reset.
The LED board descriptor is the eight bytes `41 54 47 48 01 01 1e 01`
(ATGH, version 1, LED flag, pin 30, active-low). Erased or unknown descriptors
mean no LED. Factory images need `prepare ... --has-led` only when the physical
active-low P0.30 LED exists. OTA images do not change this per-board identity.

On capable boards, P0.30 initializes high/off. Turning on `led_enabled` only
permits finding; it does not start a heartbeat or flash at boot. Control 3
flashes for at most 10 seconds (150 ms low/on, 350 ms high/off). Control 4,
disabling the setting, disconnecting, or starting OTA immediately cancels it.
Identification does not extend the connection deadline. There are no LED
timer wakeups when idle. On absent hardware P0.30 is never configured, enabling
the setting is rejected, and find requests return an unsupported-hardware error.
The existing button-counter identification works regardless of LED capability.

The web settings panel displays LED presence, disables the toggle/find action
on boards without an LED, and provides start/stop actions when available.
Public profile snapshot 000d exposes the same capability without pairing;
the Python `info --public` includes has_led/led_enabled/led_identifying.

Provision keys on a trusted host:

    cargo run --release --package atagctl -- generate-rotating test-artifacts/mytag mytag 15 512
    .venv/bin/python tools/gatt/atag_gatt.py --address ADDRESS configure test-artifacts/mytag/mytag.atag-config.bin
    .venv/bin/python tools/findmy/atag_findmy.py fetch test-artifacts/mytag/mytag_devices.json

Private key material stays on the host. The tag broadcasts identifiers; it
does not contain GPS or retrieve coordinates itself.

## Bluetooth OTA

The OTA protocol is ATAG-specific; use the Python client below. It is not the
Nordic Secure DFU protocol understood by Nordic's mobile DFU app. S112 and
the bootloader are installed through SWD; Bluetooth updates replace only the
application. See [OTA tools](../tools/ota/README.md).

Factory programming installs S112, the bootloader and the application together.
Build a signed application release, press P0.13 and upload:

    .venv/bin/python tools/ota/atag_ota.py build production/my-release --version 0.1.0
    .venv/bin/python tools/ota/atag_ota.py upload production/my-release/atag-0.1.0.atag-ota --address ADDRESS --report test-artifacts/ota-report.json

OTA does not require Bluetooth pairing. Firmware signatures authorize updates;
name/settings/key configuration writes retain their encryption requirements.
The host verifies the package, sends its SHA512 digest and signed BEGIN, then
sequential chunks and waits for each durable offset acknowledgement. BEGIN
verifies the signature over the digest before erasing any staging Flash.
FINISH recomputes the image digest and verifies Ed25519 over
SHA512 of the exact word-padded application, validates its vector table and
marks the update ready. The compiled-in public key is trusted; the signing
private key stays in `.ota/signing-key.pem` on the host. Preserve that private
key for future releases. A package's embedded public key does not replace the
device's trusted key. No signing private key or Find My decryption private key
is present in the firmware.

An interrupted upload leaves the running application intact; reconnect and
start the transfer again. After FINISH the bootloader swaps the two images
with a persistent progress log. A reset during swap/revert resumes safely.
The new application confirms the trial after radio/GATT, profile and ADC
initialization; a 30-second watchdog resets a hung/unconfirmed application so
the bootloader can restore the prior image. Confirmation covers startup health,
not every possible runtime defect. The app feeds the watchdog every two seconds
after successful initialization. A new trial opens a GATT window automatically
so the host can verify version, advertised name, profile fingerprint, key mode
and monotonic round. The public fingerprint covers the canonical name bytes,
all settings and the complete key configuration without exposing those keys.

BEGIN requires VBAT >= 3000 mV. During reception, each committed chunk renews
the connection's 30-second inactivity window, with a total 15-minute limit.
Stored connection settings are unchanged. Key rotation and battery maintenance
continue during transfer. Firmware, name/settings/key writes must be serialized;
do not change settings, provision keys or factory-reset during an OTA transfer.

Control is exactly 72 bytes: byte 0 protocol 1; byte 1 command (1 BEGIN,
2 FINISH, 3 ABORT, 4 DIGEST); bytes 2..3 zero. Send DIGEST first, with SHA512
in bytes 4..67 and zero bytes 68..71; wait for status flag bit 1.
BEGIN carries image length LE in bytes 4..7 and signature in bytes 8..71.
Bytes 4..71 must be zero for FINISH/ABORT. BEGIN length must be
512..163840 and divisible by four. Each data write contains an aligned uint32
offset and 4..112 bytes, divisible by four; offsets must be strictly sequential.
An ATT write response does not guarantee the data is committed: wait for 000c.

OTA status 000c: byte 0 version 1; byte 1 state (0 idle, 1 receiving, 2 ready);
byte 2 last error (0 none, 1 format, 2 state, 3 offset, 4 flash, 5 signature,
6 image/vector, 7 missing bootloader, 8 busy, 9 low battery); byte 3 flags:
bit 0 bootloader installed, bit 1 digest received; offsets 4/8/12 are uint32 received/total/slot capacity; offsets 16/18
are uint16 maximum chunk bytes/layout version (112/1). All numbers LE.

Profile snapshot 000d is 40 bytes: byte 0 version 1, byte 1 key mode,
byte 2 bit 0 has_led, byte 3 bit 0 LED enabled and bit 1 identifying (remaining
bits reserved), bytes 4..7 current round LE, bytes 8..39 SHA256 of
`ATAG-PROFILE-1 || name_length_u8 || name_utf8 || settings_64 || config_104`.
An unset config is 104 FF bytes. Rotation progress is reported separately
because legitimate rotations continue while an update is transferred.

## Build, storage and manufacturing

    cargo test --workspace
    .venv/bin/python -m unittest discover -s tools/gatt -v
    .venv/bin/python -m unittest discover -s tools/findmy -v
    .venv/bin/python -m unittest discover -s tools/manufacturing -v
    cargo build-nrf52832

S112 occupies flash below 0x19000. Application occupies 0x19000..0x41000
(160 KiB). OTA staging is 0x41000..0x6a000 (164 KiB), swap state is
0x6a000..0x6b000, and bootloader reservation is 0x70000..0x7c000.
UICR.NRFFW[0] at 0x10001014 points to 0x70000. MBR and S112 remain unchanged.
Two profile pages are at 0x7c000/0x7d000; two checkpoint pages are at
0x7e000/0x7f000. Profile format one uses 256-byte records. Other record versions are rejected.
It commits the CRC-protected body before the final commit word, keeping the
previous page valid during interrupted writes.

    .venv/bin/python tools/manufacturing/atag_batch.py prepare production/my-batch --count 5
    .venv/bin/python tools/manufacturing/atag_batch.py flash production/my-batch --unit unit-01

Factory images combine S112, the application, OTA bootloader, P0.21 reset configuration and a
different random-name profile with default settings and no keys.
The script verifies hashes, chip type/memory, firmware readback, advertising
name, serial, firmware version, battery voltage and live BLE notifications.
It records the physical chip ID before erasing and refuses to assign the same
board to a second unit. Backups and per-unit reports remain in the batch folder.
After a failed attempt, inspect its error and use --retry on that same board.

Each batch manifest records units as pending, flashing, failed or verified.
