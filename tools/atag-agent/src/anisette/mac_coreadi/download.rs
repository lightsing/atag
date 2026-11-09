//! Extract the pinned CoreADI runtime from Apple's iTunes download.
use super::{local, verify_library};
use crate::{
    anisette::{bounded_body, http_client},
    error::ApiError,
    hex,
};
use flate2::read::GzDecoder;
use reqwest::{StatusCode, header};
use sha2::{Digest, Sha256};
use std::{io::Read, time::Duration};

const INSTALLER: &str = concat!(
    "https://secure-appldnld.apple.com/itunes12/",
    "041-56365-20210413-79A5AC6D-6B0A-46EC-B399-5A381183E3BE/iTunes12.8.3.dmg"
);
// iTunes 12.8.3 DMG SHA-256:
// dd08b9967db3e5847955fa168ce880303abf5f36de12abb2061e7ef1a25be214
// CoreADI.pkg/Payload is contiguous in the DMG's uncompressed UDIF blocks.
// Within the gzipped cpio, the offsets select the x86_64 slice of
// System/Library/PrivateFrameworks/CoreADI.framework/Versions/A/CoreADI.
const INSTALLER_SIZE: u64 = 291_523_996;
const PAYLOAD_OFFSET: u64 = 184_678_769;
const PAYLOAD_SIZE: usize = 3_471_595;
const PAYLOAD_HASH: &str = "8a6c068c95036326eb2d2885fa60912ed0f7229d0939ae92934a70a3bb6cf025";
const CPIO_SIZE: usize = 5_105_664;
const SLICE_OFFSET: usize = 3_428_561;
const SLICE_SIZE: usize = 1_676_560;

pub(super) async fn fetch() -> Result<Vec<u8>, ApiError> {
    let end = PAYLOAD_OFFSET + PAYLOAD_SIZE as u64 - 1;
    let span = format!("{PAYLOAD_OFFSET}-{end}");
    let response = http_client()?
        .get(INSTALLER)
        .header(header::RANGE, format!("bytes={span}"))
        .header(header::ACCEPT_ENCODING, "identity")
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                ApiError::timeout_for("CoreADI 运行库下载")
            } else {
                local::failure("无法从 Apple 下载 CoreADI 运行库，请检查网络后重试。")
            }
        })?;
    let expected = format!("bytes {span}/{INSTALLER_SIZE}");
    if response.status() != StatusCode::PARTIAL_CONTENT
        || response
            .headers()
            .get(header::CONTENT_RANGE)
            .is_none_or(|value| value != expected.as_str())
    {
        return Err(local::failure(
            "Apple 未返回所需的 CoreADI 下载分段，请稍后重试。",
        ));
    }
    let payload = bounded_body(response, PAYLOAD_SIZE).await?;
    let invalid = || local::failure("Apple 下载的 CoreADI 分段校验失败，请稍后重试。");
    if payload.len() != PAYLOAD_SIZE || hex(&Sha256::digest(&payload)) != PAYLOAD_HASH {
        return Err(invalid());
    }
    let mut cpio = Vec::with_capacity(CPIO_SIZE);
    GzDecoder::new(payload.as_slice())
        .take(CPIO_SIZE as u64 + 1)
        .read_to_end(&mut cpio)
        .map_err(|_| invalid())?;
    if cpio.len() != CPIO_SIZE {
        return Err(invalid());
    }
    let library = cpio[SLICE_OFFSET..SLICE_OFFSET + SLICE_SIZE].to_vec();
    verify_library(&library)?;
    Ok(library)
}
