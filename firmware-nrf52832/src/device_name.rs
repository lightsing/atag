//! Validated UTF-8 names that fit a complete legacy scan-response name field.

/// Two AD framing bytes leave 29 bytes in a 31-byte scan response.
pub const MAX_NAME_BYTES: usize = 29;

/// A validated, allocation-free display name.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DeviceName {
    bytes: [u8; MAX_NAME_BYTES],
    len: u8,
}

/// Invalid display-name input.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NameError {
    Empty,
    TooLong,
    InvalidUtf8,
    ControlCharacter,
}

impl DeviceName {
    /// Accepts 1..=29 UTF-8 bytes, without control characters.
    pub fn new(name: &[u8]) -> Result<Self, NameError> {
        if name.is_empty() || name.iter().all(|byte| *byte == b' ') {
            return Err(NameError::Empty);
        }
        if name.len() > MAX_NAME_BYTES {
            return Err(NameError::TooLong);
        }
        let text = core::str::from_utf8(name).map_err(|_| NameError::InvalidUtf8)?;
        if text.chars().any(char::is_control) {
            return Err(NameError::ControlCharacter);
        }
        let mut bytes = [0; MAX_NAME_BYTES];
        bytes[..name.len()].copy_from_slice(name);
        Ok(Self {
            bytes,
            len: name.len() as u8,
        })
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes[..usize::from(self.len)]
    }

    /// Builds an AD structure containing the complete local name.
    pub fn scan_response(&self) -> ([u8; 31], usize) {
        let mut response = [0; 31];
        response[0] = self.len + 1;
        response[1] = 0x09;
        response[2..2 + usize::from(self.len)].copy_from_slice(self.as_bytes());
        (response, usize::from(self.len) + 2)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_are_utf8_bytes_and_invalid_names_are_rejected() {
        assert_eq!(DeviceName::new(b""), Err(NameError::Empty));
        assert_eq!(DeviceName::new(b"   "), Err(NameError::Empty));
        assert_eq!(DeviceName::new(&[b'a'; 30]), Err(NameError::TooLong));
        assert_eq!(DeviceName::new(&[0xff]), Err(NameError::InvalidUtf8));
        assert_eq!(
            DeviceName::new(b"tag\0name"),
            Err(NameError::ControlCharacter)
        );
        assert!(DeviceName::new("我的标签".as_bytes()).is_ok());
        assert!(DeviceName::new(&[b'a'; 29]).is_ok());
    }

    #[test]
    fn complete_name_fits_exactly_in_scan_response() {
        let name = DeviceName::new(&[b'x'; 29]).unwrap();
        let (packet, len) = name.scan_response();
        assert_eq!(len, 31);
        assert_eq!(&packet[..2], &[30, 9]);
        assert_eq!(&packet[2..], name.as_bytes());
    }
}
