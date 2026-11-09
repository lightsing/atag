# ATAG manufacturing

Factory firmware is 0.1.0, S112 7.3.0, LDO, external 32.768 kHz crystal,
no UART. Each unit starts with a different random name and no
Find My key configuration. Initialize keys through GATT after manufacturing.
Factory images include the Embassy OTA bootloader. Flashing a factory image
backs up and erases the entire device before programming.

Prepare a new batch from the workspace root:

    .venv/bin/python tools/manufacturing/atag_batch.py prepare production/my-batch --count 5

Default hardware has no LED. Only for a physical board with an active-low P0.30 LED, append `--has-led`: this writes its UICR
hardware descriptor. The application is the same for both boards. LED use is
still disabled by default and can be enabled later through GATT settings.
Hardware presence cannot be enabled through GATT and survives OTA/factory reset.

The output contains one merged Intel HEX image per unit, shared firmware,
256-byte initial profiles, random-name labels, SHA256 hashes and a manifest.
Every merged image includes S112, the application, OTA bootloader/UICR pointer, P0.21 nRESET UICR words,
and its unique name with default settings. The application starts at 0x19000.

Connect one powered nRF52832/512 KiB/64 KiB board through SWD, then run:

    .venv/bin/python tools/manufacturing/atag_batch.py flash production/my-batch --unit unit-01

Change the physical board before selecting unit-02, and repeat through unit-05.
Omitting --unit selects the next pending entry. The same chip ID cannot consume
two batch entries. A failed entry remains assigned to its original board;
inspect its error, then use --unit unit-XX --retry on that same physical board.

The process backs up Flash/UICR, erases the chip, programs and verifies the
complete image, then verifies the advertised name, serial, version, battery
voltage and live BLE notifications. No pairing prompt is required for these
public acceptance reads. Do not start another Bluetooth client during flashing
and acceptance, since a connected tag no longer advertises its setup window.

Results:

- manifest.json: pending/flashing/failed/verified status and physical chip IDs.
- labels.csv: initial display names and matching image paths.
- backups/: original Flash/UICR, retained with private permissions.
- reports/: per-unit acceptance results.

Names can later change through GATT. The immutable chip serial is the identity
used for inventory and button identification. A normal P0.21 reset preserves
the name/settings. Factory reset clears the profile and creates a new random
name on boot. Press P0.13 to reopen GATT after the default 60-second setup
window or a connection ends; default connection lifetime is 120 seconds.

See [the firmware protocol](../../firmware-nrf52832/README.md) for settings,
pairing, rename and button-event commands. Check each unit’s manifest status to confirm physical acceptance.
