use core::fmt;

use p224::{
    FieldBytes, ProjectivePoint, PublicKey, Scalar, SecretKey,
    elliptic_curve::{ff::PrimeField, sec1::ToEncodedPoint},
};
use sha2::{Digest, Sha256};

/// Length of a Find My advertisement key (the P-224 x-coordinate).
pub const ADVERTISEMENT_KEY_LEN: usize = 28;

/// Length of the symmetric rolling-key seed.
pub const SYMMETRIC_KEY_LEN: usize = 32;

/// Length of an uncompressed SEC1-encoded P-224 master public key.
pub const MASTER_PUBLIC_KEY_UNCOMPRESSED_LEN: usize = 57;

const DIVERSIFIED_KEY_LEN: usize = 72;
const DIVERSIFIED_SCALAR_LEN: usize = 36;

// Order of the P-224 generator minus one, in big-endian form.
const ORDER_MINUS_ONE: [u8; ADVERTISEMENT_KEY_LEN] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x16, 0xa2,
    0xe0, 0xb8, 0xf0, 0x3e, 0x13, 0xdd, 0x29, 0x45, 0x5c, 0x5c, 0x2a, 0x3c,
];

/// Errors produced while setting up or advancing rolling-key state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    /// The master public key is not a valid non-identity P-224 SEC1 point.
    InvalidMasterPublicKey,
    /// The master private scalar is zero or outside the P-224 group order.
    InvalidMasterPrivateKey,
    /// The persisted rotation counter has reached `u32::MAX`.
    RotationCounterExhausted,
    /// Rotation zero contains only the bootstrap seed and is not broadcastable.
    RotationNotStarted,
    /// A derived point was the point at infinity and cannot be advertised.
    DerivedIdentity,
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidMasterPublicKey => formatter.write_str("invalid P-224 master public key"),
            Self::InvalidMasterPrivateKey => {
                formatter.write_str("invalid P-224 master private key")
            }
            Self::RotationCounterExhausted => formatter.write_str("rotation counter exhausted"),
            Self::RotationNotStarted => formatter.write_str("rotation has not started"),
            Self::DerivedIdentity => formatter.write_str("derived P-224 point is the identity"),
        }
    }
}

/// A 28-byte P-224 private scalar used to decrypt one location report stream.
///
/// This value is secret and must never be sent to the tag or logged.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct ReportPrivateKey([u8; ADVERTISEMENT_KEY_LEN]);

impl fmt::Debug for ReportPrivateKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ReportPrivateKey([REDACTED])")
    }
}

impl ReportPrivateKey {
    /// Returns the raw big-endian P-224 private scalar.
    pub const fn as_bytes(&self) -> &[u8; ADVERTISEMENT_KEY_LEN] {
        &self.0
    }

    /// Consumes the wrapper and returns the raw private scalar.
    pub const fn into_bytes(self) -> [u8; ADVERTISEMENT_KEY_LEN] {
        self.0
    }
}

/// A 28-byte Find My advertisement key.
///
/// This is the x-coordinate of a compressed P-224 public point, without its
/// SEC1 `0x02`/`0x03` prefix.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AdvertisementKey([u8; ADVERTISEMENT_KEY_LEN]);

impl AdvertisementKey {
    /// Wraps raw advertisement-key bytes.
    pub const fn from_bytes(bytes: [u8; ADVERTISEMENT_KEY_LEN]) -> Self {
        Self(bytes)
    }

    /// Returns the raw advertisement-key bytes.
    pub const fn as_bytes(&self) -> &[u8; ADVERTISEMENT_KEY_LEN] {
        &self.0
    }

    /// Consumes the wrapper and returns the raw bytes.
    pub const fn into_bytes(self) -> [u8; ADVERTISEMENT_KEY_LEN] {
        self.0
    }
}

/// Persistable rolling-key state.
///
/// The symmetric key is sensitive. Store checkpoints with the same protection
/// as the initial seed. `rotation` is zero for the initial seed; after one
/// successful advance it is one and `symmetric_key` is `SKN_1`.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct Checkpoint {
    rotation: u32,
    symmetric_key: [u8; SYMMETRIC_KEY_LEN],
}

impl fmt::Debug for Checkpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Checkpoint")
            .field("rotation", &self.rotation)
            .field("symmetric_key", &"[REDACTED]")
            .finish()
    }
}

impl Checkpoint {
    /// Creates persisted state from a rotation number and its corresponding
    /// symmetric key.
    pub const fn new(rotation: u32, symmetric_key: [u8; SYMMETRIC_KEY_LEN]) -> Self {
        Self {
            rotation,
            symmetric_key,
        }
    }

    /// Returns the number of completed rotations.
    pub const fn rotation(&self) -> u32 {
        self.rotation
    }

    /// Returns the symmetric key for this rotation.
    pub const fn symmetric_key(&self) -> &[u8; SYMMETRIC_KEY_LEN] {
        &self.symmetric_key
    }
}

/// Output of one successful rolling-key advance.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Rotation {
    number: u32,
    advertisement_key: AdvertisementKey,
}

impl Rotation {
    /// Returns the one-based rotation number.
    pub const fn number(&self) -> u32 {
        self.number
    }

    /// Returns the derived key to encode in the BLE advertisement.
    pub const fn advertisement_key(&self) -> AdvertisementKey {
        self.advertisement_key
    }
}

/// Stateful, allocation-free rolling advertisement-key generator.
///
/// The generator uses only the master *public* key. This follows the equivalent
/// public-point form of the protocol equation:
/// `P_i = u_i * P_0 + v_i * G`.
pub struct RollingKeyGenerator {
    master_public_key: ProjectivePoint,
    checkpoint: Checkpoint,
}

/// One private rolling-key result for report retrieval and decryption.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PrivateRotation {
    number: u32,
    private_key: ReportPrivateKey,
    advertisement_key: AdvertisementKey,
}

impl PrivateRotation {
    /// Returns the one-based rotation number.
    pub const fn number(&self) -> u32 {
        self.number
    }

    /// Returns the private scalar for this rotation.
    pub const fn private_key(&self) -> ReportPrivateKey {
        self.private_key
    }

    /// Returns the corresponding public x-coordinate advertised by the tag.
    pub const fn advertisement_key(&self) -> AdvertisementKey {
        self.advertisement_key
    }
}

/// Host-side rolling private-key generator.
///
/// Firmware should use [`RollingKeyGenerator`] and keep only the public master
/// key. This private counterpart exists for a trusted recovery machine to
/// query and decrypt reports for every advertised rotation.
pub struct RollingPrivateKeyGenerator {
    master_private_key: Scalar,
    checkpoint: Checkpoint,
}

impl RollingPrivateKeyGenerator {
    /// Creates a private generator at rotation zero.
    pub fn new(
        master_private_key: &[u8; ADVERTISEMENT_KEY_LEN],
        symmetric_key: [u8; SYMMETRIC_KEY_LEN],
    ) -> Result<Self, Error> {
        Self::resume(master_private_key, Checkpoint::new(0, symmetric_key))
    }

    /// Restores a private generator from a persisted checkpoint.
    pub fn resume(
        master_private_key: &[u8; ADVERTISEMENT_KEY_LEN],
        checkpoint: Checkpoint,
    ) -> Result<Self, Error> {
        let secret = SecretKey::from_slice(master_private_key)
            .map_err(|_| Error::InvalidMasterPrivateKey)?;
        Ok(Self {
            master_private_key: Scalar::from(&secret),
            checkpoint,
        })
    }

    /// Returns the private scalar represented by the current checkpoint.
    ///
    /// Rotation zero is the `SKN_0` bootstrap state and has no corresponding
    /// advertised key. Call [`Self::advance`] once to derive rotation one.
    pub fn current_private_key(&self) -> Result<ReportPrivateKey, Error> {
        if self.checkpoint.rotation == 0 {
            return Err(Error::RotationNotStarted);
        }
        let scalar =
            derive_private_scalar(self.master_private_key, &self.checkpoint.symmetric_key)?;
        Ok(report_private_key_from_scalar(scalar))
    }

    /// Returns the public advertisement key matching the current private key.
    pub fn current_advertisement_key(&self) -> Result<AdvertisementKey, Error> {
        if self.checkpoint.rotation == 0 {
            return Err(Error::RotationNotStarted);
        }
        let scalar =
            derive_private_scalar(self.master_private_key, &self.checkpoint.symmetric_key)?;
        advertisement_key_from_point(ProjectivePoint::GENERATOR * scalar)
    }

    /// Advances to the next private/public key pair.
    pub fn advance(&mut self) -> Result<PrivateRotation, Error> {
        let number = self
            .checkpoint
            .rotation
            .checked_add(1)
            .ok_or(Error::RotationCounterExhausted)?;
        let next_symmetric_key = update_key(&self.checkpoint.symmetric_key);
        let scalar = derive_private_scalar(self.master_private_key, &next_symmetric_key)?;
        let private_key = report_private_key_from_scalar(scalar);
        let advertisement_key = advertisement_key_from_point(ProjectivePoint::GENERATOR * scalar)?;

        self.checkpoint = Checkpoint::new(number, next_symmetric_key);
        Ok(PrivateRotation {
            number,
            private_key,
            advertisement_key,
        })
    }

    /// Returns the state matching the current private key.
    pub const fn checkpoint(&self) -> Checkpoint {
        self.checkpoint
    }
}

impl RollingKeyGenerator {
    /// Creates a generator at rotation zero.
    ///
    /// `master_public_key` accepts either a 57-byte uncompressed or a 29-byte
    /// compressed SEC1 P-224 public key. OpenHaystack hardware deployment uses
    /// the 57-byte form.
    pub fn new(
        master_public_key: &[u8],
        symmetric_key: [u8; SYMMETRIC_KEY_LEN],
    ) -> Result<Self, Error> {
        Self::resume(master_public_key, Checkpoint::new(0, symmetric_key))
    }

    /// Restores a generator from a persisted checkpoint.
    pub fn resume(master_public_key: &[u8], checkpoint: Checkpoint) -> Result<Self, Error> {
        let public_key = PublicKey::from_sec1_bytes(master_public_key)
            .map_err(|_| Error::InvalidMasterPublicKey)?;

        Ok(Self {
            master_public_key: public_key.to_projective(),
            checkpoint,
        })
    }

    /// Returns the master key's 28-byte advertisement representation.
    ///
    /// This returns the master public key before the first rotation.
    pub fn master_advertisement_key(&self) -> Result<AdvertisementKey, Error> {
        advertisement_key_from_point(self.master_public_key)
    }

    /// Derives the advertisement key represented by the current checkpoint.
    ///
    /// Rotation zero is the `SKN_0` bootstrap state and has no corresponding
    /// advertised key. Call [`Self::advance`] once to derive rotation one.
    /// Persisted rotations one and later can be resumed without advancing the
    /// rolling state a second time.
    pub fn current_advertisement_key(&self) -> Result<AdvertisementKey, Error> {
        if self.checkpoint.rotation == 0 {
            return Err(Error::RotationNotStarted);
        }
        derive_advertisement_key(self.master_public_key, &self.checkpoint.symmetric_key)
    }

    /// Derives the next rolling advertisement key and commits the new state.
    ///
    /// State changes only after the complete derivation succeeds, so callers
    /// may safely retry an error.
    pub fn advance(&mut self) -> Result<Rotation, Error> {
        let number = self
            .checkpoint
            .rotation
            .checked_add(1)
            .ok_or(Error::RotationCounterExhausted)?;
        let next_symmetric_key = update_key(&self.checkpoint.symmetric_key);
        let advertisement_key =
            derive_advertisement_key(self.master_public_key, &next_symmetric_key)?;

        self.checkpoint = Checkpoint::new(number, next_symmetric_key);

        Ok(Rotation {
            number,
            advertisement_key,
        })
    }

    /// Returns the state that should be persisted for restart recovery.
    pub const fn checkpoint(&self) -> Checkpoint {
        self.checkpoint
    }
}

fn update_key(symmetric_key: &[u8; SYMMETRIC_KEY_LEN]) -> [u8; SYMMETRIC_KEY_LEN] {
    kdf_block(symmetric_key, 1, b"update")
}

fn diversify(symmetric_key: &[u8; SYMMETRIC_KEY_LEN]) -> [u8; DIVERSIFIED_KEY_LEN] {
    let mut output = [0_u8; DIVERSIFIED_KEY_LEN];

    for counter in 1..=3 {
        let block = kdf_block(symmetric_key, counter, b"diversify");
        let start = (counter as usize - 1) * 32;
        let end = core::cmp::min(start + block.len(), output.len());
        output[start..end].copy_from_slice(&block[..end - start]);
    }

    output
}

fn kdf_block(input: &[u8], counter: u32, shared_info: &[u8]) -> [u8; 32] {
    let digest = Sha256::new()
        .chain_update(input)
        .chain_update(counter.to_be_bytes())
        .chain_update(shared_info)
        .finalize();
    let mut output = [0_u8; 32];
    output.copy_from_slice(&digest);
    output
}

fn derive_advertisement_key(
    master_public_key: ProjectivePoint,
    symmetric_key: &[u8; SYMMETRIC_KEY_LEN],
) -> Result<AdvertisementKey, Error> {
    let diversified = diversify(symmetric_key);

    let mut u_bytes = [0_u8; DIVERSIFIED_SCALAR_LEN];
    u_bytes.copy_from_slice(&diversified[..DIVERSIFIED_SCALAR_LEN]);
    let mut v_bytes = [0_u8; DIVERSIFIED_SCALAR_LEN];
    v_bytes.copy_from_slice(&diversified[DIVERSIFIED_SCALAR_LEN..]);

    let u = protocol_scalar(&u_bytes);
    let v = protocol_scalar(&v_bytes);
    let derived = master_public_key * u + ProjectivePoint::GENERATOR * v;

    advertisement_key_from_point(derived)
}

fn derive_private_scalar(
    master_private_key: Scalar,
    symmetric_key: &[u8; SYMMETRIC_KEY_LEN],
) -> Result<Scalar, Error> {
    let diversified = diversify(symmetric_key);

    let mut u_bytes = [0_u8; DIVERSIFIED_SCALAR_LEN];
    u_bytes.copy_from_slice(&diversified[..DIVERSIFIED_SCALAR_LEN]);
    let mut v_bytes = [0_u8; DIVERSIFIED_SCALAR_LEN];
    v_bytes.copy_from_slice(&diversified[DIVERSIFIED_SCALAR_LEN..]);

    let derived = master_private_key * protocol_scalar(&u_bytes) + protocol_scalar(&v_bytes);
    if bool::from(derived.is_zero()) {
        return Err(Error::DerivedIdentity);
    }
    Ok(derived)
}

fn report_private_key_from_scalar(scalar: Scalar) -> ReportPrivateKey {
    let encoded = scalar.to_repr();
    let mut bytes = [0_u8; ADVERTISEMENT_KEY_LEN];
    bytes.copy_from_slice(&encoded);
    ReportPrivateKey(bytes)
}

fn advertisement_key_from_point(point: ProjectivePoint) -> Result<AdvertisementKey, Error> {
    let public_key = PublicKey::try_from(point).map_err(|_| Error::DerivedIdentity)?;
    let encoded = public_key.to_encoded_point(true);
    let bytes = encoded.as_bytes();
    let mut advertisement_key = [0_u8; ADVERTISEMENT_KEY_LEN];
    advertisement_key.copy_from_slice(&bytes[1..]);
    Ok(AdvertisementKey::from_bytes(advertisement_key))
}

// Map a 36-byte KDF half to (value mod (q - 1)) + 1, as specified by the
// Offline Finding diversification algorithm. The fixed-size bitwise reduction
// avoids a heap-backed big integer dependency on embedded targets.
fn protocol_scalar(input: &[u8; DIVERSIFIED_SCALAR_LEN]) -> Scalar {
    // One extra leading byte holds the carry produced while shifting a value
    // which is already smaller than q - 1.
    let mut remainder = [0_u8; ADVERTISEMENT_KEY_LEN + 1];
    let mut modulus = [0_u8; ADVERTISEMENT_KEY_LEN + 1];
    modulus[1..].copy_from_slice(&ORDER_MINUS_ONE);

    for input_byte in input {
        for bit in (0..8).rev() {
            let mut carry = (input_byte >> bit) & 1;
            for byte in remainder.iter_mut().rev() {
                let next_carry = *byte >> 7;
                *byte = (*byte << 1) | carry;
                carry = next_carry;
            }

            // Compute remainder - modulus, then select it iff there was no
            // borrow. The control flow does not depend on the derived scalar.
            let mut difference = [0_u8; ADVERTISEMENT_KEY_LEN + 1];
            let mut borrow = 0_u16;
            for index in (0..remainder.len()).rev() {
                let left = remainder[index] as u16;
                let right = modulus[index] as u16 + borrow;
                difference[index] = left.wrapping_sub(right) as u8;
                borrow = (left < right) as u16;
            }
            let use_difference = 0_u8.wrapping_sub((borrow == 0) as u8);
            for index in 0..remainder.len() {
                remainder[index] =
                    (difference[index] & use_difference) | (remainder[index] & !use_difference);
            }
        }
    }

    let mut scalar_bytes = [0_u8; ADVERTISEMENT_KEY_LEN];
    scalar_bytes.copy_from_slice(&remainder[1..]);
    let mut carry = 1_u16;
    for byte in scalar_bytes.iter_mut().rev() {
        let sum = *byte as u16 + carry;
        *byte = sum as u8;
        carry = sum >> 8;
    }

    // The reduction above guarantees 1 <= scalar <= q - 1.
    Option::<Scalar>::from(Scalar::from_repr(FieldBytes::from(scalar_bytes)))
        .expect("protocol scalar is in the P-224 scalar field")
}

#[cfg(test)]
mod tests {
    use super::*;

    const GENERATOR_UNCOMPRESSED: [u8; MASTER_PUBLIC_KEY_UNCOMPRESSED_LEN] = [
        0x04, 0xb7, 0x0e, 0x0c, 0xbd, 0x6b, 0xb4, 0xbf, 0x7f, 0x32, 0x13, 0x90, 0xb9, 0x4a, 0x03,
        0xc1, 0xd3, 0x56, 0xc2, 0x11, 0x22, 0x34, 0x32, 0x80, 0xd6, 0x11, 0x5c, 0x1d, 0x21, 0xbd,
        0x37, 0x63, 0x88, 0xb5, 0xf7, 0x23, 0xfb, 0x4c, 0x22, 0xdf, 0xe6, 0xcd, 0x43, 0x75, 0xa0,
        0x5a, 0x07, 0x47, 0x64, 0x44, 0xd5, 0x81, 0x99, 0x85, 0x00, 0x7e, 0x34,
    ];

    const INITIAL_SEED: [u8; SYMMETRIC_KEY_LEN] = [
        0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
        0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d,
        0x1e, 0x1f,
    ];

    #[test]
    fn first_rotation_matches_independent_vector() {
        let mut generator = RollingKeyGenerator::new(&GENERATOR_UNCOMPRESSED, INITIAL_SEED)
            .expect("valid generator point");
        let rotation = generator.advance().expect("first rotation");

        assert_eq!(rotation.number(), 1);
        assert_eq!(
            generator.checkpoint().symmetric_key(),
            &[
                0x09, 0xa9, 0xc1, 0xf0, 0x72, 0xab, 0x2a, 0xa8, 0x5e, 0xeb, 0x2f, 0x10, 0xb0, 0x38,
                0xc2, 0xe1, 0xd2, 0xa3, 0x6f, 0x89, 0x0a, 0x51, 0xb3, 0x39, 0x42, 0x68, 0x80, 0x8e,
                0x63, 0x3b, 0xa7, 0x00,
            ]
        );
        assert_eq!(
            rotation.advertisement_key().as_bytes(),
            &[
                0x33, 0x5f, 0x9a, 0xaa, 0x89, 0x6b, 0x3a, 0x0c, 0xa8, 0x67, 0xff, 0xfb, 0x91, 0xcb,
                0x62, 0x65, 0x2f, 0x23, 0x25, 0x59, 0xc8, 0x14, 0x1f, 0x13, 0x82, 0xd9, 0x91, 0x2a,
            ]
        );

        let second = generator.advance().expect("second rotation");
        assert_eq!(second.number(), 2);
        assert_eq!(
            second.advertisement_key().as_bytes(),
            &[
                0x67, 0x5f, 0x96, 0xc4, 0xe5, 0xa6, 0xb5, 0xbf, 0xc2, 0x98, 0x8d, 0x03, 0xe1, 0x55,
                0x0a, 0xf0, 0x54, 0x53, 0x41, 0x2c, 0x64, 0xd7, 0x3f, 0xd3, 0x7e, 0xe3, 0xd4, 0xff,
            ]
        );
    }

    #[test]
    fn master_key_is_generator_x_coordinate() {
        let generator = RollingKeyGenerator::new(&GENERATOR_UNCOMPRESSED, INITIAL_SEED)
            .expect("valid generator point");
        assert_eq!(
            generator
                .master_advertisement_key()
                .expect("non-identity")
                .as_bytes(),
            &GENERATOR_UNCOMPRESSED[1..29]
        );
    }

    #[test]
    fn bootstrap_state_is_never_advertised() {
        let public = RollingKeyGenerator::new(&GENERATOR_UNCOMPRESSED, INITIAL_SEED)
            .expect("valid public key");
        assert_eq!(
            public.current_advertisement_key(),
            Err(Error::RotationNotStarted)
        );

        let mut master_private = [0_u8; ADVERTISEMENT_KEY_LEN];
        master_private[ADVERTISEMENT_KEY_LEN - 1] = 1;
        let private = RollingPrivateKeyGenerator::new(&master_private, INITIAL_SEED)
            .expect("valid private key");
        assert_eq!(
            private.current_private_key(),
            Err(Error::RotationNotStarted)
        );
        assert_eq!(
            private.current_advertisement_key(),
            Err(Error::RotationNotStarted)
        );
    }

    #[test]
    fn checkpoint_resume_produces_same_next_key() {
        let mut uninterrupted =
            RollingKeyGenerator::new(&GENERATOR_UNCOMPRESSED, INITIAL_SEED).expect("valid key");
        uninterrupted.advance().expect("rotation one");

        let mut resumed =
            RollingKeyGenerator::resume(&GENERATOR_UNCOMPRESSED, uninterrupted.checkpoint())
                .expect("valid checkpoint");

        assert_eq!(
            uninterrupted.advance().expect("uninterrupted rotation"),
            resumed.advance().expect("resumed rotation")
        );
        assert_eq!(uninterrupted.checkpoint(), resumed.checkpoint());
    }

    #[test]
    fn checkpoint_resume_recovers_current_key() {
        let mut generator =
            RollingKeyGenerator::new(&GENERATOR_UNCOMPRESSED, INITIAL_SEED).expect("valid key");
        let first = generator.advance().expect("rotation one");
        let resumed = RollingKeyGenerator::resume(&GENERATOR_UNCOMPRESSED, generator.checkpoint())
            .expect("valid checkpoint");

        assert_eq!(
            resumed.current_advertisement_key().expect("current key"),
            first.advertisement_key()
        );
    }

    #[test]
    fn rejects_invalid_public_key() {
        assert_eq!(
            RollingKeyGenerator::new(&[0_u8; 57], INITIAL_SEED).err(),
            Some(Error::InvalidMasterPublicKey)
        );
    }

    #[test]
    fn counter_overflow_does_not_change_state() {
        let checkpoint = Checkpoint::new(u32::MAX, INITIAL_SEED);
        let mut generator =
            RollingKeyGenerator::resume(&GENERATOR_UNCOMPRESSED, checkpoint).expect("valid key");

        assert_eq!(generator.advance(), Err(Error::RotationCounterExhausted));
        assert_eq!(generator.checkpoint(), checkpoint);
    }

    #[test]
    fn scalar_reduction_matches_protocol_intermediates() {
        let updated = update_key(&INITIAL_SEED);
        let diversified = diversify(&updated);
        let mut u_input = [0_u8; 36];
        u_input.copy_from_slice(&diversified[..36]);
        let mut v_input = [0_u8; 36];
        v_input.copy_from_slice(&diversified[36..]);

        assert_eq!(
            protocol_scalar(&u_input).to_repr(),
            FieldBytes::from([
                0x06, 0x96, 0xfa, 0xbf, 0xfa, 0xcf, 0xbe, 0xfb, 0x10, 0x09, 0x14, 0x84, 0x32, 0x21,
                0xc1, 0x1e, 0xe1, 0x39, 0xed, 0x4b, 0x22, 0xcc, 0x10, 0x84, 0x92, 0x6b, 0x07, 0x10,
            ])
        );
        assert_eq!(
            protocol_scalar(&v_input).to_repr(),
            FieldBytes::from([
                0x14, 0x5c, 0x03, 0x47, 0x5c, 0xd2, 0xab, 0xc4, 0xd0, 0x08, 0x5e, 0xf3, 0x29, 0x41,
                0x88, 0x23, 0x77, 0x84, 0xb5, 0xba, 0x62, 0x78, 0x60, 0x1d, 0x82, 0x31, 0x50, 0x27,
            ])
        );
    }

    #[test]
    fn private_and_public_generators_match_every_rotation() {
        let mut master_private = [0_u8; ADVERTISEMENT_KEY_LEN];
        master_private[ADVERTISEMENT_KEY_LEN - 1] = 1;
        let mut private = RollingPrivateKeyGenerator::new(&master_private, INITIAL_SEED)
            .expect("valid private key");
        let mut public = RollingKeyGenerator::new(&GENERATOR_UNCOMPRESSED, INITIAL_SEED)
            .expect("valid public key");

        for expected_number in 1..=8 {
            let private_rotation = private.advance().expect("private rotation");
            let public_rotation = public.advance().expect("public rotation");
            assert_eq!(private_rotation.number(), expected_number);
            assert_eq!(public_rotation.number(), expected_number);
            assert_eq!(
                private_rotation.advertisement_key(),
                public_rotation.advertisement_key()
            );
            assert_eq!(
                private
                    .current_advertisement_key()
                    .expect("private public x"),
                public.current_advertisement_key().expect("public x")
            );
            assert_eq!(private.checkpoint(), public.checkpoint());
        }
    }

    #[test]
    fn rejects_invalid_private_key() {
        assert_eq!(
            RollingPrivateKeyGenerator::new(&[0_u8; ADVERTISEMENT_KEY_LEN], INITIAL_SEED).err(),
            Some(Error::InvalidMasterPrivateKey)
        );
    }
}
