//! Power-loss-tolerant rolling-key checkpoint storage.

use atag::{Checkpoint, SYMMETRIC_KEY_LEN};
use embedded_storage_async::nor_flash::NorFlash;

/// First of two flash pages reserved by `memory.x` for checkpoints.
pub const JOURNAL_START: u32 = 0x0007_e000;
/// nRF52832 flash erase-page size.
pub const PAGE_SIZE: u32 = 4096;
const PAGE_COUNT: usize = 2;
const BODY_LEN: usize = 52;
const RECORD_LEN: usize = 56;
const RECORDS_PER_PAGE: usize = PAGE_SIZE as usize / RECORD_LEN;
const MAGIC: u32 = u32::from_le_bytes(*b"ATGJ");
const FORMAT_VERSION: u32 = 1;
const COMMIT_MARKER: u32 = 0x4154_4147;

/// Journal access error.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error<E> {
    /// The underlying flash operation failed.
    Flash(E),
}

/// A two-page append-only checkpoint journal.
///
/// Records are committed with a separate final word. When the active page is
/// full, the older page is erased before the next record is written. At least
/// one previously committed checkpoint therefore survives a reset during an
/// erase or write.
pub struct CheckpointJournal<F> {
    flash: F,
    provisioning_id: u32,
}

impl<F> CheckpointJournal<F>
where
    F: NorFlash,
{
    /// Wraps the SoftDevice flash driver for one provisioned key set.
    pub const fn new(flash: F, provisioning_id: u32) -> Self {
        Self {
            flash,
            provisioning_id,
        }
    }

    /// Loads the highest valid rotation for the current provisioning ID.
    pub async fn load(&mut self) -> Result<Option<Checkpoint>, Error<F::Error>> {
        Ok(self.scan().await?.latest.map(|record| record.checkpoint))
    }

    /// Atomically appends a checkpoint before its key is advertised.
    pub async fn persist(&mut self, checkpoint: Checkpoint) -> Result<(), Error<F::Error>> {
        let scan = self.scan().await?;
        let target = if let Some(latest) = scan.latest {
            if let Some(slot) = self.find_erased(latest.page, latest.slot + 1).await? {
                Location {
                    page: latest.page,
                    slot,
                }
            } else {
                let page = 1 - latest.page;
                self.erase_page(page).await?;
                Location { page, slot: 0 }
            }
        } else if let Some(slot) = self.find_erased(0, 0).await? {
            Location { page: 0, slot }
        } else {
            self.erase_page(0).await?;
            Location { page: 0, slot: 0 }
        };

        self.write_record(target, checkpoint).await
    }

    /// Returns the wrapped flash driver.
    pub fn into_inner(self) -> F {
        self.flash
    }

    async fn scan(&mut self) -> Result<Scan, Error<F::Error>> {
        let mut scan = Scan { latest: None };
        let mut bytes = [0_u8; RECORD_LEN];

        for page in 0..PAGE_COUNT {
            for slot in 0..RECORDS_PER_PAGE {
                self.flash
                    .read(record_address(page, slot), &mut bytes)
                    .await
                    .map_err(Error::Flash)?;
                let Some(checkpoint) = decode_record(&bytes, self.provisioning_id) else {
                    continue;
                };
                let candidate = LocatedCheckpoint {
                    page,
                    slot,
                    checkpoint,
                };
                let replace = scan.latest.is_none_or(|latest| {
                    (
                        candidate.checkpoint.rotation(),
                        candidate.page,
                        candidate.slot,
                    ) > (latest.checkpoint.rotation(), latest.page, latest.slot)
                });
                if replace {
                    scan.latest = Some(candidate);
                }
            }
        }
        Ok(scan)
    }

    async fn find_erased(
        &mut self,
        page: usize,
        first_slot: usize,
    ) -> Result<Option<usize>, Error<F::Error>> {
        let mut bytes = [0_u8; RECORD_LEN];
        for slot in first_slot..RECORDS_PER_PAGE {
            self.flash
                .read(record_address(page, slot), &mut bytes)
                .await
                .map_err(Error::Flash)?;
            if bytes.iter().all(|byte| *byte == 0xff) {
                return Ok(Some(slot));
            }
        }
        Ok(None)
    }

    async fn erase_page(&mut self, page: usize) -> Result<(), Error<F::Error>> {
        let start = page_address(page);
        self.flash
            .erase(start, start + PAGE_SIZE)
            .await
            .map_err(Error::Flash)
    }

    async fn write_record(
        &mut self,
        location: Location,
        checkpoint: Checkpoint,
    ) -> Result<(), Error<F::Error>> {
        let address = record_address(location.page, location.slot);
        let body = AlignedBody(encode_body(checkpoint, self.provisioning_id));
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
}

#[repr(C, align(4))]
struct AlignedBody([u8; BODY_LEN]);

#[repr(C, align(4))]
struct AlignedWord([u8; 4]);

#[derive(Clone, Copy)]
struct Location {
    page: usize,
    slot: usize,
}

#[derive(Clone, Copy)]
struct LocatedCheckpoint {
    page: usize,
    slot: usize,
    checkpoint: Checkpoint,
}

struct Scan {
    latest: Option<LocatedCheckpoint>,
}

const fn page_address(page: usize) -> u32 {
    JOURNAL_START + page as u32 * PAGE_SIZE
}

const fn record_address(page: usize, slot: usize) -> u32 {
    page_address(page) + (slot * RECORD_LEN) as u32
}

fn encode_body(checkpoint: Checkpoint, provisioning_id: u32) -> [u8; BODY_LEN] {
    let mut body = [0xff; BODY_LEN];
    body[0..4].copy_from_slice(&MAGIC.to_le_bytes());
    body[4..8].copy_from_slice(&FORMAT_VERSION.to_le_bytes());
    body[8..12].copy_from_slice(&provisioning_id.to_le_bytes());
    body[12..16].copy_from_slice(&checkpoint.rotation().to_le_bytes());
    body[16..48].copy_from_slice(checkpoint.symmetric_key());
    let crc = crc32(&body[..48]);
    body[48..52].copy_from_slice(&crc.to_le_bytes());
    body
}

fn decode_record(bytes: &[u8; RECORD_LEN], provisioning_id: u32) -> Option<Checkpoint> {
    if read_u32(&bytes[52..56]) != COMMIT_MARKER
        || read_u32(&bytes[0..4]) != MAGIC
        || read_u32(&bytes[4..8]) != FORMAT_VERSION
        || read_u32(&bytes[8..12]) != provisioning_id
        || read_u32(&bytes[48..52]) != crc32(&bytes[..48])
    {
        return None;
    }

    let rotation = read_u32(&bytes[12..16]);
    let mut symmetric_key = [0; SYMMETRIC_KEY_LEN];
    symmetric_key.copy_from_slice(&bytes[16..48]);
    Some(Checkpoint::new(rotation, symmetric_key))
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().expect("four-byte field"))
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffff_u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = 0_u32.wrapping_sub(crc & 1);
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    extern crate std;

    use embedded_storage_async::nor_flash::{
        ErrorType, NorFlash, NorFlashError, NorFlashErrorKind, ReadNorFlash,
    };
    use futures::executor::block_on;
    use std::vec;
    use std::vec::Vec;

    use super::*;

    const KEY_ID: u32 = 0x1234_5678;

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
                (JOURNAL_START + PAGE_COUNT as u32 * PAGE_SIZE) as usize
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

    #[test]
    fn rejects_uncommitted_corrupt_and_foreign_records() {
        let checkpoint = Checkpoint::new(7, [0x5a; SYMMETRIC_KEY_LEN]);
        let body = encode_body(checkpoint, KEY_ID);
        let mut record = [0xff; RECORD_LEN];
        record[..BODY_LEN].copy_from_slice(&body);
        assert_eq!(decode_record(&record, KEY_ID), None);

        record[52..56].copy_from_slice(&COMMIT_MARKER.to_le_bytes());
        assert_eq!(decode_record(&record, KEY_ID), Some(checkpoint));
        assert_eq!(decode_record(&record, KEY_ID + 1), None);

        record[20] ^= 1;
        assert_eq!(decode_record(&record, KEY_ID), None);
    }

    #[test]
    fn persists_across_page_rotation() {
        block_on(async {
            let mut journal = CheckpointJournal::new(RamFlash::new(), KEY_ID);
            assert_eq!(journal.load().await, Ok(None));

            for rotation in 1..=(RECORDS_PER_PAGE as u32 + 5) {
                let checkpoint = Checkpoint::new(rotation, [rotation as u8; SYMMETRIC_KEY_LEN]);
                journal
                    .persist(checkpoint)
                    .await
                    .expect("persist checkpoint");
            }

            let expected = Checkpoint::new(
                RECORDS_PER_PAGE as u32 + 5,
                [(RECORDS_PER_PAGE as u32 + 5) as u8; SYMMETRIC_KEY_LEN],
            );
            assert_eq!(journal.load().await, Ok(Some(expected)));

            let flash = journal.into_inner();
            let mut resumed = CheckpointJournal::new(flash, KEY_ID);
            assert_eq!(resumed.load().await, Ok(Some(expected)));
        });
    }
}
