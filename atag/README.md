# atag

`atag` is a small `no_std`, allocation-free Rust library for the hardware side
of reverse-engineered Find My / AirTag-compatible Offline Finding broadcasts.

It provides:

- P-224 rolling advertisement-key derivation using only a master public key;
- resumable symmetric-key/counter state for embedded persistence;
- the six-byte random-static BLE address derived from each key;
- the complete 31-byte legacy BLE advertising-data buffer;
- helpers for a 2.4–4.2 V, six-bit battery-voltage status encoding which keeps
  status bits 5..4 available for the Offline Finding device type.

The voltage format maps 64 levels over 1800 mV (about 28.6 mV per step),
descending from full voltage to undervoltage.

## Inputs kept by the device

Provision each device with:

1. the 57-byte uncompressed SEC1 P-224 master public key (`04 || X || Y`);
2. the 32-byte symmetric rolling-key seed (`SKN_0`);
3. a persisted rotation counter, initially zero.

The master private key is not required on the hardware. Keep it on the report
retrieval/decryption side.

## Example

```rust
use atag::{BleAdvertisement, RollingKeyGenerator};

# fn example(master_public_key: &[u8], symmetric_seed: [u8; 32]) -> Result<(), atag::Error> {
let mut keys = RollingKeyGenerator::new(master_public_key, symmetric_seed)?;

// Rotation zero is the non-broadcast SKN_0 bootstrap state. Derive and persist
// rotation one before advertising for the first time.
let first = keys.advance()?;
let initial_radio_input = BleAdvertisement::separated(first.advertisement_key());
# let first_checkpoint = keys.checkpoint();

// Call once at each configured rotation interval.
let rotation = keys.advance()?;
let radio_input = BleAdvertisement::separated(rotation.advertisement_key());

let address: &[u8; 6] = radio_input.random_static_address();
let raw_advertising_data: &[u8; 31] = radio_input.advertising_data();

// Persist each checkpoint atomically before beginning to advertise its key,
// then configure the BLE controller with `address` and `raw_advertising_data`.
# let _ = (first_checkpoint, initial_radio_input, address, raw_advertising_data);
# Ok(())
# }
```

Some BLE controller APIs use least-significant-byte-first address arrays; if so,
reverse the six address bytes only at the radio-driver boundary. APIs which ask
for manufacturer data rather than a raw advertising-data buffer can use
`BleAdvertisement::manufacturer_data()`.

## Derivation

For each rotation:

```text
SKN_i       = X9.63-SHA256(SKN_(i-1), "update", 32 bytes)
u_i || v_i = X9.63-SHA256(SKN_i, "diversify", 72 bytes)
u_i, v_i   = (integer mod (q - 1)) + 1
P_i         = u_i * P_0 + v_i * G
```

The advertised 28-byte key is the x-coordinate of `P_i`. It is split between
the random-static address and Apple manufacturer data in the same layout used
by OpenHaystack firmware.

This is an independent implementation of a reverse-engineered protocol, not an
Apple-certified Find My Network Accessory implementation. Test interoperability
and regulatory/radio behavior on the target platform before deployment.
