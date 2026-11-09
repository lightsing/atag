//! Power-loss-tolerant storage for the active GATT configuration.

use crate::{
    device_name::DeviceName,
    settings::{Settings, crc32},
};
use atag::{PROVISIONING_WIRE_LEN, ProvisioningConfig};
use embedded_storage_async::nor_flash::NorFlash;

/// First of two flash pages reserved for provisioning records.
pub const PROVISIONING_START: u32 = 0x0007_c000;
/// nRF52832 flash erase-page size.
pub const PAGE_SIZE: u32 = 4096;
const PAGE_COUNT: usize = 2;
const BODY_LEN: usize = 252;
/// Size of one complete, committed provisioning record.
pub const RECORD_LEN: usize = 256;
const MAGIC: u32 = u32::from_le_bytes(*b"ATGC");
const FORMAT_VERSION: u32 = 1;
const STATE_CONFIGURED: u32 = 1;
const STATE_RESET: u32 = 2;
const COMMIT_MARKER: u32 = 0x4154_4147;

/// Configuration, display name and non-secret settings committed atomically.
#[derive(Clone, Copy, Default)]
pub struct DeviceProfile {
    pub config: Option<ProvisioningConfig>,
    pub name: Option<DeviceName>,
    pub settings: Settings,
}

/// Persistent-configuration access error.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error<E> {
    /// The underlying flash operation failed.
    Flash(E),
    /// The monotonic record sequence was exhausted.
    SequenceExhausted,
    InvalidSettings,
}

/// A redundant two-page provisioning store.
///
/// A complete new record is committed on the page opposite the current one.
/// The previous record remains valid until the final commit word is written,
/// so a reset during erase or write cannot resurrect a partially written
/// configuration.
pub struct ProvisioningStore<F> {
    flash: F,
}

impl<F> ProvisioningStore<F>
where
    F: NorFlash,
{
    /// Wraps a flash driver.
    pub const fn new(flash: F) -> Self {
        Self { flash }
    }

    /// Loads the latest committed state. A reset tombstone returns `None`.
    pub async fn load(&mut self) -> Result<Option<ProvisioningConfig>, Error<F::Error>> {
        Ok(self.load_profile().await?.config)
    }

    pub async fn load_profile(&mut self) -> Result<DeviceProfile, Error<F::Error>> {
        Ok(self
            .scan()
            .await?
            .map_or_else(DeviceProfile::default, |record| record.profile))
    }

    /// Atomically replaces the active configuration.
    pub async fn persist(&mut self, config: ProvisioningConfig) -> Result<(), Error<F::Error>> {
        let mut profile = self.load_profile().await?;
        profile.config = Some(config);
        if let ProvisioningConfig::Rotating {
            rotation_interval_minutes,
            ..
        } = config
        {
            profile.settings.rotation_minutes = rotation_interval_minutes;
        }
        self.persist_profile(profile).await
    }

    pub async fn persist_profile(&mut self, profile: DeviceProfile) -> Result<(), Error<F::Error>> {
        profile
            .settings
            .validate()
            .map_err(|_| Error::InvalidSettings)?;
        self.append(profile).await
    }

    /// Atomically records factory-reset state.
    pub async fn reset(&mut self) -> Result<(), Error<F::Error>> {
        self.append(DeviceProfile::default()).await
    }

    /// Returns the wrapped flash driver.
    pub fn into_inner(self) -> F {
        self.flash
    }

    async fn append(&mut self, profile: DeviceProfile) -> Result<(), Error<F::Error>> {
        let latest = self.scan().await?;
        let sequence = latest
            .map_or(Some(0), |record| record.sequence.checked_add(1))
            .ok_or(Error::SequenceExhausted)?;
        let page = latest.map_or(0, |record| 1 - record.page);
        let address = page_address(page);

        self.flash
            .erase(address, address + PAGE_SIZE)
            .await
            .map_err(Error::Flash)?;

        let body = AlignedBody(encode_profile_body(sequence, profile));
        self.flash
            .write(address, &body.0)
            .await
            .map_err(Error::Flash)?;

        let commit = AlignedWord(COMMIT_MARKER.to_le_bytes());
        self.flash
            .write(address + BODY_LEN as u32, &commit.0)
            .await
            .map_err(Error::Flash)
    }

    async fn scan(&mut self) -> Result<Option<Record>, Error<F::Error>> {
        let mut latest: Option<Record> = None;
        let mut bytes = [0_u8; RECORD_LEN];

        for page in 0..PAGE_COUNT {
            self.flash
                .read(page_address(page), &mut bytes)
                .await
                .map_err(Error::Flash)?;
            let Some(mut record) = decode_record(&bytes) else {
                continue;
            };
            record.page = page;
            if latest.is_none_or(|current| {
                (record.sequence, record.page) > (current.sequence, current.page)
            }) {
                latest = Some(record);
            }
        }
        Ok(latest)
    }
}

#[repr(C, align(4))]
struct AlignedBody([u8; BODY_LEN]);

#[repr(C, align(4))]
struct AlignedWord([u8; 4]);

#[derive(Clone, Copy)]
struct Record {
    page: usize,
    sequence: u32,
    profile: DeviceProfile,
}

const fn page_address(page: usize) -> u32 {
    PROVISIONING_START + page as u32 * PAGE_SIZE
}

fn encode_body(sequence: u32, config: Option<ProvisioningConfig>) -> [u8; BODY_LEN] {
    let mut profile = DeviceProfile {
        config,
        ..Default::default()
    };
    if let Some(ProvisioningConfig::Rotating {
        rotation_interval_minutes,
        ..
    }) = config
    {
        profile.settings.rotation_minutes = rotation_interval_minutes;
    }
    encode_profile_body(sequence, profile)
}

fn encode_profile_body(sequence: u32, profile: DeviceProfile) -> [u8; BODY_LEN] {
    let mut body = [0xff; BODY_LEN];
    body[0..4].copy_from_slice(&MAGIC.to_le_bytes());
    body[4..8].copy_from_slice(&FORMAT_VERSION.to_le_bytes());
    body[8..12].copy_from_slice(&sequence.to_le_bytes());
    let state = if profile.config.is_some() {
        STATE_CONFIGURED
    } else {
        STATE_RESET
    };
    body[12..16].copy_from_slice(&state.to_le_bytes());
    if let Some(config) = profile.config {
        body[16..16 + PROVISIONING_WIRE_LEN].copy_from_slice(&config.encode());
    }
    if let Some(name) = profile.name {
        body[120..152].fill(0);
        body[120] = name.as_bytes().len() as u8;
        body[121..121 + name.as_bytes().len()].copy_from_slice(name.as_bytes());
    }
    body[152..216].copy_from_slice(&profile.settings.encode());
    let crc = crc32(&body[..248]);
    body[248..252].copy_from_slice(&crc.to_le_bytes());
    body
}

/// Encodes a complete committed record for factory programming or recovery.
///
/// Normal runtime updates should use [`ProvisioningStore::persist`]. This
/// helper exists so a manufacturing tool can program an otherwise erased page
/// with exactly the same on-flash format.
pub fn encode_committed_record(
    sequence: u32,
    config: Option<ProvisioningConfig>,
) -> [u8; RECORD_LEN] {
    let mut record = [0xff; RECORD_LEN];
    record[..BODY_LEN].copy_from_slice(&encode_body(sequence, config));
    record[BODY_LEN..].copy_from_slice(&COMMIT_MARKER.to_le_bytes());
    record
}

/// Encodes a complete version-one manufacturing profile.
pub fn encode_profile_record(sequence: u32, profile: DeviceProfile) -> [u8; RECORD_LEN] {
    let mut record = [0xff; RECORD_LEN];
    record[..BODY_LEN].copy_from_slice(&encode_profile_body(sequence, profile));
    record[BODY_LEN..].copy_from_slice(&COMMIT_MARKER.to_le_bytes());
    record
}

fn decode_record(bytes: &[u8; RECORD_LEN]) -> Option<Record> {
    if read_u32(&bytes[0..4]) != MAGIC {
        return None;
    }
    if read_u32(&bytes[4..8]) != FORMAT_VERSION
        || read_u32(&bytes[248..252]) != crc32(&bytes[..248])
        || read_u32(&bytes[252..256]) != COMMIT_MARKER
    {
        return None;
    }

    let config = match read_u32(&bytes[12..16]) {
        STATE_CONFIGURED => {
            let wire: &[u8; PROVISIONING_WIRE_LEN] =
                bytes[16..16 + PROVISIONING_WIRE_LEN].try_into().ok()?;
            Some(ProvisioningConfig::decode(wire).ok()?)
        }
        STATE_RESET => {
            if bytes[16..120].iter().any(|byte| *byte != 0xff) {
                return None;
            }
            None
        }
        _ => return None,
    };

    let mut profile = DeviceProfile {
        config,
        ..Default::default()
    };
    profile.settings = Settings::decode(bytes[152..216].try_into().ok()?).ok()?;
    let field = &bytes[120..152];
    if field.iter().any(|byte| *byte != 0xff) {
        let len = usize::from(field[0]);
        if len == 0 || len > 29 || field[1 + len..].iter().any(|byte| *byte != 0) {
            return None;
        }
        profile.name = Some(DeviceName::new(&field[1..1 + len]).ok()?);
    }
    Some(Record {
        page: 0,
        sequence: read_u32(&bytes[8..12]),
        profile,
    })
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().expect("four-byte field"))
}

#[cfg(test)]
mod tests {
    extern crate std;

    use atag::{AdvertisementKey, MASTER_PUBLIC_KEY_UNCOMPRESSED_LEN};
    use embedded_storage_async::nor_flash::{
        ErrorType, NorFlash, NorFlashError, NorFlashErrorKind, ReadNorFlash,
    };
    use futures::executor::block_on;
    use std::{vec, vec::Vec};

    use super::*;

    const GENERATOR_UNCOMPRESSED: [u8; MASTER_PUBLIC_KEY_UNCOMPRESSED_LEN] = [
        0x04, 0xb7, 0x0e, 0x0c, 0xbd, 0x6b, 0xb4, 0xbf, 0x7f, 0x32, 0x13, 0x90, 0xb9, 0x4a, 0x03,
        0xc1, 0xd3, 0x56, 0xc2, 0x11, 0x22, 0x34, 0x32, 0x80, 0xd6, 0x11, 0x5c, 0x1d, 0x21, 0xbd,
        0x37, 0x63, 0x88, 0xb5, 0xf7, 0x23, 0xfb, 0x4c, 0x22, 0xdf, 0xe6, 0xcd, 0x43, 0x75, 0xa0,
        0x5a, 0x07, 0x47, 0x64, 0x44, 0xd5, 0x81, 0x99, 0x85, 0x00, 0x7e, 0x34,
    ];

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    struct RamError;

    impl NorFlashError for RamError {
        fn kind(&self) -> NorFlashErrorKind {
            NorFlashErrorKind::Other
        }
    }

    struct RamFlash(Vec<u8>);

    impl RamFlash {
        fn new() -> Self {
            Self(vec![
                0xff;
                (PROVISIONING_START + PAGE_COUNT as u32 * PAGE_SIZE)
                    as usize
            ])
        }
    }

    impl ErrorType for RamFlash {
        type Error = RamError;
    }

    impl ReadNorFlash for RamFlash {
        const READ_SIZE: usize = 1;

        async fn read(&mut self, offset: u32, bytes: &mut [u8]) -> Result<(), Self::Error> {
            bytes.copy_from_slice(&self.0[offset as usize..offset as usize + bytes.len()]);
            Ok(())
        }

        fn capacity(&self) -> usize {
            self.0.len()
        }
    }

    impl NorFlash for RamFlash {
        const WRITE_SIZE: usize = 4;
        const ERASE_SIZE: usize = PAGE_SIZE as usize;

        async fn write(&mut self, offset: u32, bytes: &[u8]) -> Result<(), Self::Error> {
            if offset as usize % Self::WRITE_SIZE != 0 || bytes.len() % Self::WRITE_SIZE != 0 {
                return Err(RamError);
            }
            for (stored, new) in self.0[offset as usize..offset as usize + bytes.len()]
                .iter_mut()
                .zip(bytes)
            {
                if *stored & *new != *new {
                    return Err(RamError);
                }
                *stored = *new;
            }
            Ok(())
        }

        async fn erase(&mut self, from: u32, to: u32) -> Result<(), Self::Error> {
            self.0[from as usize..to as usize].fill(0xff);
            Ok(())
        }
    }

    fn fixed_config() -> ProvisioningConfig {
        let mut x = [0; 28];
        x.copy_from_slice(&GENERATOR_UNCOMPRESSED[1..29]);
        ProvisioningConfig::Fixed {
            advertisement_key: AdvertisementKey::from_bytes(x),
        }
    }

    fn rotating_config() -> ProvisioningConfig {
        ProvisioningConfig::Rotating {
            master_public_key: GENERATOR_UNCOMPRESSED,
            symmetric_seed: [0x42; 32],
            rotation_interval_minutes: 15,
        }
    }

    #[test]
    fn persists_replaces_and_resets() {
        block_on(async {
            let mut store = ProvisioningStore::new(RamFlash::new());
            assert_eq!(store.load().await, Ok(None));

            store.persist(fixed_config()).await.expect("persist fixed");
            assert_eq!(store.load().await, Ok(Some(fixed_config())));

            store
                .persist(rotating_config())
                .await
                .expect("persist rotating");
            assert_eq!(store.load().await, Ok(Some(rotating_config())));

            store.reset().await.expect("persist reset tombstone");
            assert_eq!(store.load().await, Ok(None));
        });
    }

    #[test]
    fn uncommitted_new_page_preserves_old_page() {
        block_on(async {
            let mut store = ProvisioningStore::new(RamFlash::new());
            store.persist(fixed_config()).await.expect("persist fixed");

            let mut flash = store.into_inner();
            let body = AlignedBody(encode_body(1, Some(rotating_config())));
            flash
                .write(page_address(1), &body.0)
                .await
                .expect("write incomplete replacement");

            let mut resumed = ProvisioningStore::new(flash);
            assert_eq!(resumed.load().await, Ok(Some(fixed_config())));
        });
    }

    #[test]
    fn corrupt_record_is_rejected() {
        let body = encode_body(7, Some(fixed_config()));
        assert_eq!(&body[4..8], &1_u32.to_le_bytes());
        let mut record = [0xff; RECORD_LEN];
        record[..BODY_LEN].copy_from_slice(&body);
        assert!(decode_record(&record).is_none());
        record[BODY_LEN..].copy_from_slice(&COMMIT_MARKER.to_le_bytes());
        assert!(decode_record(&record).is_some());
        record[20] ^= 1;
        assert!(decode_record(&record).is_none());
    }

    #[test]
    fn manufacturing_record_decodes_as_committed() {
        let bytes = encode_committed_record(9, Some(rotating_config()));
        let decoded = decode_record(&bytes).expect("committed record");
        assert_eq!(decoded.sequence, 9);
        assert_eq!(decoded.profile.config, Some(rotating_config()));
    }

    #[test]
    fn name_and_settings_survive_key_changes_and_factory_reset_is_atomic() {
        block_on(async {
            let mut store = ProvisioningStore::new(RamFlash::new());
            let mut profile = DeviceProfile::default();
            profile.name = Some(DeviceName::new("我的标签".as_bytes()).unwrap());
            profile.settings.advertising_interval_ms = 3000;
            profile.settings.led_enabled = true;
            store.persist_profile(profile).await.unwrap();
            store.persist(rotating_config()).await.unwrap();
            let loaded = store.load_profile().await.unwrap();
            assert_eq!(loaded.name, profile.name);
            assert_eq!(loaded.settings.advertising_interval_ms, 3000);
            assert!(loaded.settings.led_enabled);
            let mut changed = loaded;
            changed.settings.rotation_minutes = 30;
            store.persist_profile(changed).await.unwrap();
            assert_eq!(store.load().await.unwrap(), loaded.config);
            assert_eq!(
                store
                    .load_profile()
                    .await
                    .unwrap()
                    .settings
                    .rotation_minutes,
                30
            );
            store.reset().await.unwrap();
            let reset = store.load_profile().await.unwrap();
            assert!(reset.name.is_none());
            assert!(reset.config.is_none());
            assert_eq!(reset.settings, Settings::default());
        });
    }

    #[test]
    fn rejects_other_record_versions_even_with_valid_checksum() {
        for version in [0_u32, 2, 3, u32::MAX] {
            let mut record = encode_committed_record(9, Some(rotating_config()));
            record[4..8].copy_from_slice(&version.to_le_bytes());
            let crc = crc32(&record[..248]);
            record[248..252].copy_from_slice(&crc.to_le_bytes());
            assert!(decode_record(&record).is_none());
        }
    }
}
