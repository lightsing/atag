use super::*;
extern crate std;
use embedded_storage::nor_flash::{ErrorType, NorFlashError, NorFlashErrorKind};
use futures::executor::block_on;
use std::{cell::RefCell, rc::Rc, vec, vec::Vec};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Failure;
impl NorFlashError for Failure {
    fn kind(&self) -> NorFlashErrorKind {
        NorFlashErrorKind::Other
    }
}

#[derive(Clone)]
struct Memory {
    bytes: Vec<u8>,
    cut: Option<usize>,
    operations: usize,
}
#[derive(Clone)]
struct Flash(Rc<RefCell<Memory>>);
impl Flash {
    fn new() -> Self {
        let mut bytes = vec![0xff; 0x80000];
        bytes[ACTIVE_START as usize..DFU_START as usize].fill(0x31);
        bytes[BOOT_START as usize..].fill(0xa5); // bootloader + nonempty profile/key/checkpoint canaries
        Self(Rc::new(RefCell::new(Memory {
            bytes,
            cut: None,
            operations: 0,
        })))
    }
    fn copy(&self) -> Self {
        Self(Rc::new(RefCell::new(self.0.borrow().clone())))
    }
    fn read_inner(&self, offset: u32, data: &mut [u8]) -> Result<(), Failure> {
        let memory = self.0.borrow();
        let slice = memory
            .bytes
            .get(offset as usize..offset as usize + data.len())
            .ok_or(Failure)?;
        data.copy_from_slice(slice);
        Ok(())
    }
    fn mutate(&self, from: usize, to: usize, data: Option<&[u8]>) -> Result<(), Failure> {
        assert!(from >= ACTIVE_START as usize && to <= STATE_START as usize + 4096);
        let mut memory = self.0.borrow_mut();
        memory.operations += 1;
        let failing = memory.cut == Some(0);
        if let Some(cut) = memory.cut.as_mut() {
            *cut = cut.saturating_sub(1);
        }
        // A reset can interrupt a page erase or a multiword write. Progress
        // words are atomic; larger writes can leave a partially changed page.
        let end = if failing {
            from + (to - from) / 8 * 4
        } else {
            to
        };
        if let Some(data) = data {
            for (old, new) in memory.bytes[from..end].iter_mut().zip(data) {
                assert_eq!(*old & *new, *new);
                *old = *new;
            }
        } else {
            memory.bytes[from..end].fill(0xff);
        }
        if failing { Err(Failure) } else { Ok(()) }
    }
    fn persistent(&self) -> Vec<u8> {
        self.0.borrow().bytes[0x7c000..].to_vec()
    }
    fn active(&self) -> Vec<u8> {
        self.0.borrow().bytes[ACTIVE_START as usize..DFU_START as usize].to_vec()
    }
}
impl ErrorType for Flash {
    type Error = Failure;
}
impl embedded_storage::nor_flash::ReadNorFlash for Flash {
    const READ_SIZE: usize = 1;
    fn read(&mut self, o: u32, b: &mut [u8]) -> Result<(), Failure> {
        self.read_inner(o, b)
    }
    fn capacity(&self) -> usize {
        0x80000
    }
}
impl embedded_storage::nor_flash::NorFlash for Flash {
    const WRITE_SIZE: usize = 4;
    const ERASE_SIZE: usize = 4096;
    fn write(&mut self, o: u32, b: &[u8]) -> Result<(), Failure> {
        self.mutate(o as usize, o as usize + b.len(), Some(b))
    }
    fn erase(&mut self, f: u32, t: u32) -> Result<(), Failure> {
        self.mutate(f as usize, t as usize, None)
    }
}
impl embedded_storage_async::nor_flash::ReadNorFlash for Flash {
    const READ_SIZE: usize = 1;
    async fn read(&mut self, o: u32, b: &mut [u8]) -> Result<(), Failure> {
        self.read_inner(o, b)
    }
    fn capacity(&self) -> usize {
        0x80000
    }
}
impl NorFlash for Flash {
    const WRITE_SIZE: usize = 4;
    const ERASE_SIZE: usize = 4096;
    async fn write(&mut self, o: u32, b: &[u8]) -> Result<(), Failure> {
        self.mutate(o as usize, o as usize + b.len(), Some(b))
    }
    async fn erase(&mut self, f: u32, t: u32) -> Result<(), Failure> {
        self.mutate(f as usize, t as usize, None)
    }
}

fn image() -> Vec<u8> {
    let mut image = vec![0x72; 8192];
    image[..4].copy_from_slice(&0x20010000u32.to_le_bytes());
    image[4..8].copy_from_slice(&(ACTIVE_START + 513).to_le_bytes());
    image
}
fn commands(image: &[u8]) -> ([u8; 72], [u8; 32]) {
    let key = salty::Keypair::from(&[42; 32]);
    let mut wire = [0; 72];
    wire[0] = 1;
    wire[1] = 1;
    wire[4..8].copy_from_slice(&(image.len() as u32).to_le_bytes());
    wire[8..].copy_from_slice(
        &key.sign(&salty::Sha512::new().updated(image).finalize())
            .to_bytes(),
    );
    (wire, key.public.to_bytes())
}
fn finish() -> [u8; 72] {
    let mut wire = [0; 72];
    wire[0] = 1;
    wire[1] = 2;
    wire
}
async fn stage(
    flash: &mut Flash,
    session: &mut OtaSession,
    image: &[u8],
    begin: &[u8; 72],
    key: &[u8; 32],
) {
    let mut digest = [0; 72];
    digest[0] = 1;
    digest[1] = 4;
    digest[4..68].copy_from_slice(&salty::Sha512::new().updated(image).finalize());
    assert_eq!(session.control(flash, &digest, key, 4000).await, Ok(false));
    assert_eq!(session.control(flash, begin, key, 4000).await, Ok(false));
    for (number, chunk) in image.chunks(CHUNK_SIZE).enumerate() {
        let mut data = ((number * CHUNK_SIZE) as u32).to_le_bytes().to_vec();
        data.extend_from_slice(chunk);
        session.data(flash, &data).await.unwrap();
    }
}
fn boot(flash: &Flash) -> Result<embassy_boot::State, embassy_boot::BootError> {
    use embassy_embedded_hal::flash::partition::BlockingPartition;
    use embassy_sync::blocking_mutex::Mutex;
    let flash = Mutex::<NoopRawMutex, _>::new(RefCell::new(flash.clone()));
    let config = embassy_boot::BootLoaderConfig {
        active: BlockingPartition::new(&flash, ACTIVE_START, ACTIVE_SIZE),
        dfu: BlockingPartition::new(&flash, DFU_START, DFU_SIZE),
        state: BlockingPartition::new(&flash, STATE_START, 4096),
    };
    embassy_boot::BootLoader::new(config).prepare_boot(&mut AlignedBuffer([0; 4096]).0)
}

#[test]
fn rejects_bad_targets_order_and_unsigned_image_without_touching_active_or_configuration() {
    block_on(async {
        let mut flash = Flash::new();
        let old = flash.active();
        let persistent = flash.persistent();
        let image = image();
        let (begin, key) = commands(&image);
        assert_eq!(
            OtaSession::new(false)
                .control(&mut flash, &begin, &key, 4000)
                .await,
            Err(OtaError::NoBootloader)
        );
        let mut session = OtaSession::new(true);
        assert_eq!(
            session.control(&mut flash, &begin, &key, 2900).await,
            Err(OtaError::LowBattery)
        );
        let mut large = begin;
        large[4..8].copy_from_slice(&(ACTIVE_SIZE + 4).to_le_bytes());
        assert_eq!(
            session.control(&mut flash, &large, &key, 4000).await,
            Err(OtaError::Image)
        );
        assert_eq!(
            session.data(&mut flash, &[0; 8]).await,
            Err(OtaError::State)
        );
        let mut digest = [0; 72];
        digest[0] = 1;
        digest[1] = 4;
        digest[4..68].copy_from_slice(&salty::Sha512::new().updated(&image).finalize());
        session
            .control(&mut flash, &digest, &key, 4000)
            .await
            .unwrap();
        let mut invalid = begin;
        invalid[8] ^= 1;
        let operations = flash.0.borrow().operations;
        assert_eq!(
            session.control(&mut flash, &invalid, &key, 4000).await,
            Err(OtaError::Signature)
        );
        assert_eq!(
            flash.0.borrow().operations,
            operations,
            "unsigned BEGIN must not erase staging"
        );
        stage(&mut flash, &mut session, &image, &begin, &key).await;
        assert_eq!(
            session.data(&mut flash, &[0; 8]).await,
            Err(OtaError::Offset)
        );
        flash.0.borrow_mut().bytes[DFU_START as usize + 128] ^= 1;
        assert_eq!(
            session.control(&mut flash, &finish(), &key, 4000).await,
            Err(OtaError::Signature)
        );
        boot(&flash).unwrap();
        assert_eq!(flash.active(), old);
        assert_eq!(flash.persistent(), persistent);
    });
}

#[test]
fn confirmed_update_and_unconfirmed_rollback_preserve_all_user_pages() {
    block_on(async {
        let mut flash = Flash::new();
        let old = flash.active();
        let persistent = flash.persistent();
        let image = image();
        let (begin, key) = commands(&image);
        let mut session = OtaSession::new(true);
        stage(&mut flash, &mut session, &image, &begin, &key).await;
        assert_eq!(
            session.control(&mut flash, &finish(), &key, 4000).await,
            Ok(true)
        );
        let rollback = flash.copy();
        boot(&flash).unwrap();
        assert_eq!(&flash.active()[..image.len()], image);
        assert_eq!(confirm_boot(&mut flash).await, Ok(true));
        boot(&flash).unwrap();
        assert_eq!(&flash.active()[..image.len()], image);
        assert_eq!(flash.persistent(), persistent);
        boot(&rollback).unwrap();
        boot(&rollback).unwrap();
        assert_eq!(rollback.active(), old);
        assert_eq!(rollback.persistent(), persistent);
    });
}

#[test]
fn every_swap_and_revert_flash_boundary_survives_power_loss() {
    block_on(async {
        let mut staged = Flash::new();
        let old = staged.active();
        let persistent = staged.persistent();
        let image = image();
        let (begin, key) = commands(&image);
        let mut session = OtaSession::new(true);
        stage(&mut staged, &mut session, &image, &begin, &key).await;
        session
            .control(&mut staged, &finish(), &key, 4000)
            .await
            .unwrap();
        let swapped = staged.copy();
        boot(&swapped).unwrap();
        let new = swapped.active();
        for baseline in [&staged, &swapped] {
            let complete = baseline.copy();
            let before = complete.0.borrow().operations;
            boot(&complete).unwrap();
            let operations = complete.0.borrow().operations - before;
            assert!(operations > 100);
            for cut in 0..operations {
                let interrupted = baseline.copy();
                interrupted.0.borrow_mut().cut = Some(cut);
                assert!(boot(&interrupted).is_err());
                interrupted.0.borrow_mut().cut = None;
                boot(&interrupted).unwrap();
                assert!(
                    interrupted.active() == old || interrupted.active() == new,
                    "cut {cut}"
                );
                assert_eq!(interrupted.persistent(), persistent, "cut {cut}");
                assert_eq!(
                    &interrupted.0.borrow().bytes[BOOT_START as usize..0x7c000],
                    &staged.0.borrow().bytes[BOOT_START as usize..0x7c000]
                );
            }
        }
    });
}
