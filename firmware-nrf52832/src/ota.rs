//! Signed, staged application updates. Never writes the profile/checkpoint pages.
use embassy_boot::{AlignedBuffer, FirmwareState, FirmwareUpdater, FirmwareUpdaterConfig};
use embassy_embedded_hal::flash::partition::Partition;
use embassy_sync::{blocking_mutex::raw::NoopRawMutex, mutex::Mutex};
use embedded_storage_async::nor_flash::{NorFlash, ReadNorFlash};

pub const ACTIVE_START: u32 = 0x19000;
pub const ACTIVE_SIZE: u32 = 0x28000;
pub const DFU_START: u32 = 0x41000;
pub const DFU_SIZE: u32 = ACTIVE_SIZE + 4096;
pub const STATE_START: u32 = 0x6a000;
pub const BOOT_START: u32 = 0x70000;
pub const CONTROL_LEN: usize = 72;
pub const CHUNK_SIZE: usize = 112;
pub const DATA_LEN: usize = 4 + CHUNK_SIZE;
pub const STATUS_LEN: usize = 20;
pub const LAYOUT: u16 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum OtaError {
    Format = 1,
    State = 2,
    Offset = 3,
    Flash = 4,
    Signature = 5,
    Image = 6,
    NoBootloader = 7,
    Busy = 8,
    LowBattery = 9,
}

pub struct OtaSession {
    installed: bool,
    state: u8,
    error: u8,
    received: u32,
    length: u32,
    signature: [u8; 64],
    digest: Option<[u8; 64]>,
}

impl OtaSession {
    pub const fn new(installed: bool) -> Self {
        Self {
            installed,
            state: 0,
            error: 0,
            received: 0,
            length: 0,
            signature: [0; 64],
            digest: None,
        }
    }

    pub fn receiving(&self) -> bool {
        self.state == 1
    }

    pub fn reject(&mut self, error: OtaError) {
        self.error = error as u8;
    }

    pub fn status(&self) -> [u8; STATUS_LEN] {
        let mut status = [0; STATUS_LEN];
        status[..4].copy_from_slice(&[
            1,
            self.state,
            self.error,
            u8::from(self.installed) | (u8::from(self.digest.is_some()) << 1),
        ]);
        status[4..8].copy_from_slice(&self.received.to_le_bytes());
        status[8..12].copy_from_slice(&self.length.to_le_bytes());
        status[12..16].copy_from_slice(&ACTIVE_SIZE.to_le_bytes());
        status[16..18].copy_from_slice(&(CHUNK_SIZE as u16).to_le_bytes());
        status[18..20].copy_from_slice(&LAYOUT.to_le_bytes());
        status
    }

    /// Returns true only after a verified update has been durably scheduled.
    pub async fn control<F: NorFlash>(
        &mut self,
        flash: &mut F,
        wire: &[u8; CONTROL_LEN],
        public_key: &[u8; 32],
        battery_mv: u16,
    ) -> Result<bool, OtaError> {
        if !self.installed {
            return Err(OtaError::NoBootloader);
        }
        if wire[0] != 1 || wire[2..4] != [0, 0] {
            return Err(OtaError::Format);
        }
        match wire[1] {
            1 => {
                if self.receiving() || self.state == 2 {
                    return Err(OtaError::State);
                }
                let length = u32::from_le_bytes(wire[4..8].try_into().unwrap());
                if !(512..=ACTIVE_SIZE).contains(&length) || length % 4 != 0 {
                    return Err(OtaError::Image);
                }
                if battery_mv < 3000 {
                    return Err(OtaError::LowBattery);
                }
                let digest = self.digest.ok_or(OtaError::State)?;
                let public =
                    salty::PublicKey::try_from(public_key).map_err(|_| OtaError::Signature)?;
                let signature: &[u8; 64] = wire[8..72].try_into().unwrap();
                let signature =
                    salty::Signature::try_from(signature).map_err(|_| OtaError::Signature)?;
                public
                    .verify(&digest, &signature)
                    .map_err(|_| OtaError::Signature)?;
                let mutex = Mutex::<NoopRawMutex, _>::new(flash);
                let config = FirmwareUpdaterConfig {
                    dfu: Partition::new(&mutex, DFU_START, DFU_SIZE),
                    state: Partition::new(&mutex, STATE_START, 4096),
                };
                let mut aligned = AlignedBuffer([0; 4]);
                let mut updater = FirmwareUpdater::new(config, &mut aligned.0);
                updater
                    .prepare_update()
                    .await
                    .map_err(|_| OtaError::Flash)?;
                self.signature.copy_from_slice(&wire[8..72]);
                self.length = length;
                self.received = 0;
                self.state = 1;
                self.error = 0;
                Ok(false)
            }
            2 => {
                if wire[4..].iter().any(|b| *b != 0) {
                    return Err(OtaError::Format);
                }
                if !self.receiving() || self.received != self.length {
                    return Err(OtaError::State);
                }
                let mutex = Mutex::<NoopRawMutex, _>::new(flash);
                let mut dfu = Partition::new(&mutex, DFU_START, DFU_SIZE);
                let mut vector = [0; 8];
                dfu.read(0, &mut vector)
                    .await
                    .map_err(|_| OtaError::Flash)?;
                if !valid_vector(&vector, self.length) {
                    return Err(OtaError::Image);
                }
                let config = FirmwareUpdaterConfig {
                    dfu,
                    state: Partition::new(&mutex, STATE_START, 4096),
                };
                let mut aligned = AlignedBuffer([0; 4]);
                let mut updater = FirmwareUpdater::new(config, &mut aligned.0);
                if updater
                    .verify_and_mark_updated(public_key, &self.signature, self.length)
                    .await
                    .is_err()
                {
                    // An invalid image must not be retried as if it were accepted.
                    self.state = 0;
                    return Err(OtaError::Signature);
                }
                self.state = 2;
                self.error = 0;
                Ok(true)
            }
            3 => {
                if self.state == 2 {
                    return Err(OtaError::State);
                }
                if wire[4..].iter().any(|b| *b != 0) {
                    return Err(OtaError::Format);
                }
                *self = Self::new(self.installed);
                Ok(false)
            }
            4 => {
                if self.receiving() || self.state == 2 {
                    return Err(OtaError::State);
                }
                if wire[68..72] != [0; 4] {
                    return Err(OtaError::Format);
                }
                self.digest = Some(wire[4..68].try_into().unwrap());
                self.error = 0;
                Ok(false)
            }
            _ => Err(OtaError::Format),
        }
    }

    pub async fn data<F: NorFlash>(&mut self, flash: &mut F, wire: &[u8]) -> Result<(), OtaError> {
        if !self.receiving() {
            return Err(OtaError::State);
        }
        if wire.len() <= 4 || wire.len() > DATA_LEN || wire.len() % 4 != 0 {
            return Err(OtaError::Format);
        }
        let offset = u32::from_le_bytes(wire[..4].try_into().unwrap());
        let data = &wire[4..];
        if offset != self.received
            || offset
                .checked_add(data.len() as u32)
                .is_none_or(|end| end > self.length)
        {
            return Err(OtaError::Offset);
        }
        let mutex = Mutex::<NoopRawMutex, _>::new(flash);
        let mut dfu = Partition::new(&mutex, DFU_START, DFU_SIZE);
        // SoftDevice requires aligned source pointers; GATT bytes need not be aligned.
        let mut aligned = AlignedBuffer([0xff; CHUNK_SIZE]);
        aligned.0[..data.len()].copy_from_slice(data);
        dfu.write(offset, &aligned.0[..data.len()])
            .await
            .map_err(|_| OtaError::Flash)?;
        self.received += data.len() as u32;
        self.error = 0;
        Ok(())
    }
}

pub fn valid_vector(vector: &[u8; 8], length: u32) -> bool {
    let sp = u32::from_le_bytes(vector[..4].try_into().unwrap());
    let pc = u32::from_le_bytes(vector[4..].try_into().unwrap());
    (0x20004000..=0x20010000).contains(&sp)
        && sp % 8 == 0
        && pc & 1 == 1
        && pc >= ACTIVE_START
        && pc < ACTIVE_START.saturating_add(length)
}

/// Confirm after the application has initialized radio, storage and sampling.
pub async fn confirm_boot<F: NorFlash>(flash: &mut F) -> Result<bool, OtaError> {
    let mutex = Mutex::<NoopRawMutex, _>::new(flash);
    let state = Partition::new(&mutex, STATE_START, 4096);
    let mut aligned = AlignedBuffer([0; 4]);
    let mut state = FirmwareState::new(state, &mut aligned.0);
    let trial = state.get_state().await.map_err(|_| OtaError::Flash)? == embassy_boot::State::Swap;
    state.mark_booted().await.map_err(|_| OtaError::Flash)?;
    Ok(trial)
}

#[cfg(test)]
mod tests;
