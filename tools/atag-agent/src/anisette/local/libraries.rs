use crate::private_files::{prepare_private_directory, protect, read_bounded};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    time::Duration,
};

const APK_URL: &str = "https://apps.mzstatic.com/content/android-apple-music-apk/applemusic.apk";
const LIMIT: usize = 32 * 1024 * 1024;
const NAMES: [&str; 2] = ["libstoreservicescore.so", "libCoreADI.so"];
#[cfg(target_arch = "aarch64")]
const ABI: &str = "arm64-v8a";
#[cfg(target_arch = "x86_64")]
const ABI: &str = "x86_64";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u8,
    abi: String,
    sha256: [String; 2],
}
fn digest(bytes: &[u8]) -> String {
    crate::hex(&Sha256::digest(bytes))
}
fn elf(bytes: &[u8]) -> Result<()> {
    let machine = if cfg!(target_arch = "aarch64") {
        183u16
    } else {
        62
    };
    if bytes.len() < 64
        || &bytes[..7] != b"\x7fELF\x02\x01\x01"
        || bytes[16..18] != 3u16.to_le_bytes()
        || bytes[18..20] != machine.to_le_bytes()
    {
        bail!("unsupported ELF library");
    }
    Ok(())
}
fn extract(reader: impl Read + Seek) -> Result<[Vec<u8>; 2]> {
    let mut archive = zip::ZipArchive::new(reader)?;
    let mut result = [Vec::new(), Vec::new()];
    for (name, bytes) in NAMES.iter().zip(&mut result) {
        // No archive paths are ever written to disk; only these two exact entries.
        let entry = archive.by_name(&format!("lib/{ABI}/{name}"))?;
        if entry.size() > LIMIT as u64 {
            bail!("library too large");
        }
        entry.take(LIMIT as u64 + 1).read_to_end(bytes)?;
        if bytes.len() > LIMIT {
            bail!("library too large");
        }
        elf(bytes)?;
    }
    Ok(result)
}

struct Part {
    bytes: Vec<u8>,
    start: u64,
    total: u64,
    etag: String,
}
async fn range(
    client: &reqwest::Client,
    spec: &str,
    limit: usize,
    etag: Option<&str>,
) -> Result<Part> {
    let mut call = client
        .get(APK_URL)
        .header("Range", spec)
        .header("Accept-Encoding", "identity");
    if let Some(etag) = etag {
        call = call.header("If-Range", etag);
    }
    let response = call.send().await?;
    if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        bail!("Apple download requires a consistent range response");
    }
    let actual_etag = response
        .headers()
        .get("etag")
        .context("missing APK ETag")?
        .to_str()?
        .to_owned();
    if actual_etag.len() > 256 || etag.is_some_and(|expected| expected != actual_etag) {
        bail!("APK changed during download");
    }
    let content_range = response
        .headers()
        .get("content-range")
        .context("missing Content-Range")?
        .to_str()?;
    let (span, total) = content_range
        .strip_prefix("bytes ")
        .and_then(|s| s.split_once('/'))
        .context("invalid Content-Range")?;
    let (start, end) = span.split_once('-').context("invalid Content-Range")?;
    let (start, end, total) = (
        start.parse::<u64>()?,
        end.parse::<u64>()?,
        total.parse::<u64>()?,
    );
    if end < start || end >= total || total > 256 * 1024 * 1024 || end - start + 1 > limit as u64 {
        bail!("APK range outside limits");
    }
    let bytes = crate::anisette::bounded_body(response, limit).await?;
    if bytes.len() as u64 != end - start + 1 {
        bail!("truncated APK range");
    }
    Ok(Part {
        bytes,
        start,
        total,
        etag: actual_etag,
    })
}
fn u16_at(bytes: &[u8], offset: usize) -> Result<u16> {
    Ok(u16::from_le_bytes(
        bytes
            .get(offset..offset + 2)
            .context("truncated ZIP")?
            .try_into()?,
    ))
}
fn u32_at(bytes: &[u8], offset: usize) -> Result<u32> {
    Ok(u32::from_le_bytes(
        bytes
            .get(offset..offset + 4)
            .context("truncated ZIP")?
            .try_into()?,
    ))
}
fn central_location(tail: &[u8], start: u64, total: u64) -> Result<(u64, usize)> {
    let at = (0..tail.len().saturating_sub(21))
        .rev()
        .find(|at| {
            tail.get(*at..*at + 4) == Some(b"PK\x05\x06")
                && u16_at(tail, *at + 20).is_ok_and(|n| *at + 22 + usize::from(n) == tail.len())
        })
        .context("missing ZIP end record")?;
    let size = u32_at(tail, at + 12)? as usize;
    let offset = u64::from(u32_at(tail, at + 16)?);
    if u16_at(tail, at + 4)? != 0
        || u16_at(tail, at + 6)? != 0
        || u16_at(tail, at + 8)? != u16_at(tail, at + 10)?
        || size > 8 * 1024 * 1024
        || size == 0
        || offset + size as u64 > start + at as u64
        || start + tail.len() as u64 != total
    {
        bail!("unsupported ZIP directory");
    }
    Ok((offset, size))
}
fn selected_entries(directory: &[u8]) -> Result<[(u64, u64); 2]> {
    let mut found = [None, None];
    let mut at = 0;
    while at < directory.len() {
        if directory.get(at..at + 4) != Some(b"PK\x01\x02") {
            bail!("invalid central directory");
        }
        let name_length = usize::from(u16_at(directory, at + 28)?);
        let next = at
            + 46
            + name_length
            + usize::from(u16_at(directory, at + 30)?)
            + usize::from(u16_at(directory, at + 32)?);
        let name = directory
            .get(at + 46..at + 46 + name_length)
            .context("truncated ZIP filename")?;
        if next > directory.len() {
            bail!("truncated central directory");
        }
        for (index, expected) in NAMES.iter().enumerate() {
            if name == format!("lib/{ABI}/{expected}").as_bytes() {
                let compressed = u64::from(u32_at(directory, at + 20)?);
                let expanded = u64::from(u32_at(directory, at + 24)?);
                if found[index].is_some()
                    || compressed == 0
                    || compressed > LIMIT as u64
                    || expanded > LIMIT as u64
                    || u16_at(directory, at + 34)? != 0
                    || u16_at(directory, at + 8)? & 1 != 0
                {
                    bail!("unsupported ADI ZIP member");
                }
                found[index] = Some((u64::from(u32_at(directory, at + 42)?), compressed));
            }
        }
        at = next;
    }
    Ok([
        found[0].context("Apple APK has no storeservices library for this architecture")?,
        found[1].context("Apple APK has no CoreADI library for this architecture")?,
    ])
}
async fn exact_range(
    client: &reqwest::Client,
    start: u64,
    length: usize,
    tail: &Part,
) -> Result<Vec<u8>> {
    let end = start
        .checked_add(length as u64)
        .filter(|end| *end <= tail.total)
        .context("invalid ZIP range")?;
    if length == 0 {
        bail!("empty ZIP range");
    }
    let part = range(
        client,
        &format!("bytes={start}-{}", end - 1),
        length,
        Some(&tail.etag),
    )
    .await?;
    if part.start != start || part.total != tail.total || part.bytes.len() != length {
        bail!("unexpected APK range");
    }
    Ok(part.bytes)
}
async fn download(client: &reqwest::Client, root: &Path) -> Result<[Vec<u8>; 2]> {
    let tail = range(client, "bytes=-65557", 65557, None).await?;
    if tail.start + tail.bytes.len() as u64 != tail.total {
        bail!("unexpected APK suffix");
    }
    let (offset, length) = central_location(&tail.bytes, tail.start, tail.total)?;
    let directory = exact_range(client, offset, length, &tail).await?;
    let entries = selected_entries(&directory)?;
    // A private sparse archive lets the standard ZIP parser validate CRC and
    // decompression without downloading or extracting unrelated APK entries.
    let mut apk = tempfile::tempfile_in(root)?;
    apk.set_len(tail.total)?;
    apk.seek(SeekFrom::Start(tail.start))?;
    apk.write_all(&tail.bytes)?;
    apk.seek(SeekFrom::Start(offset))?;
    apk.write_all(&directory)?;
    for (offset, compressed) in entries {
        let header = exact_range(client, offset, 30, &tail).await?;
        if &header[..4] != b"PK\x03\x04" {
            bail!("invalid ZIP local header");
        }
        let length = 30
            + usize::from(u16_at(&header, 26)?)
            + usize::from(u16_at(&header, 28)?)
            + compressed as usize;
        if length > LIMIT + 128 * 1024 {
            bail!("ZIP local member too large");
        }
        let data = exact_range(client, offset, length, &tail).await?;
        apk.seek(SeekFrom::Start(offset))?;
        apk.write_all(&data)?;
    }
    apk.seek(SeekFrom::Start(0))?;
    extract(apk)
}
pub(super) fn save(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().context("parent")?)?;
    protect(temp.path(), false)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|e| e.error)?;
    Ok(())
}
pub(super) async fn load(root: &Path) -> Result<[Vec<u8>; 2]> {
    let directory = root.join("libraries");
    prepare_private_directory(&directory)?;
    let manifest = directory.join("manifest.json");
    if manifest.exists() {
        let manifest: Manifest = serde_json::from_slice(&read_bounded(&manifest, 4096)?)?;
        if manifest.version != 1 || manifest.abi != ABI {
            bail!("library architecture mismatch; run anisette init --repair");
        }
        let mut result = [Vec::new(), Vec::new()];
        for ((name, expected), bytes) in NAMES.iter().zip(&manifest.sha256).zip(&mut result) {
            *bytes = read_bounded(&directory.join(name), LIMIT as u64)?;
            if digest(bytes) != *expected {
                bail!("library cache changed; run anisette init --repair");
            }
            elf(bytes)?;
        }
        return Ok(result);
    }
    if NAMES.iter().any(|name| directory.join(name).exists()) {
        bail!("incomplete library cache; run anisette init --repair");
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let result = download(&client, root).await?;
    for (name, bytes) in NAMES.iter().zip(&result) {
        save(&directory.join(name), bytes)?;
    }
    save(
        &manifest,
        &serde_json::to_vec(&Manifest {
            version: 1,
            abi: ABI.into(),
            sha256: result.each_ref().map(|b| digest(b)),
        })?,
    )?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    fn fixture() -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        let mut bytes = vec![0; 64];
        bytes[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
        bytes[16..18].copy_from_slice(&3u16.to_le_bytes());
        bytes[18..20].copy_from_slice(
            &(if cfg!(target_arch = "aarch64") {
                183u16
            } else {
                62
            })
            .to_le_bytes(),
        );
        for name in NAMES {
            zip.start_file(format!("lib/{ABI}/{name}"), options)
                .unwrap();
            zip.write_all(&bytes).unwrap();
        }
        zip.start_file("../../not-extracted", options).unwrap();
        zip.write_all(b"unrelated").unwrap();
        zip.finish().unwrap().into_inner()
    }
    #[test]
    fn parses_range_directory_and_extracts_only_expected_members() {
        let apk = fixture();
        let (offset, length) = central_location(&apk, 0, apk.len() as u64).unwrap();
        let entries = selected_entries(&apk[offset as usize..offset as usize + length]).unwrap();
        assert_eq!(entries[0].0, 0);
        assert!(entries[1].0 > 0);
        assert!(extract(Cursor::new(&apk)).is_ok());
        let mut truncated = apk.clone();
        truncated.pop();
        assert!(central_location(&truncated, 0, truncated.len() as u64).is_err());
        let mut corrupt = apk;
        let at = 30 + usize::from(u16_at(&corrupt, 26).unwrap());
        corrupt[at + 50] ^= 1;
        assert!(extract(Cursor::new(corrupt)).is_err());
    }
    #[tokio::test]
    async fn detects_modified_cached_library_before_loading() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("libraries");
        prepare_private_directory(&directory).unwrap();
        let bytes = extract(Cursor::new(fixture())).unwrap();
        for (name, bytes) in NAMES.iter().zip(&bytes) {
            save(&directory.join(name), bytes).unwrap();
        }
        save(
            &directory.join("manifest.json"),
            &serde_json::to_vec(&Manifest {
                version: 1,
                abi: ABI.into(),
                sha256: bytes.each_ref().map(|b| digest(b)),
            })
            .unwrap(),
        )
        .unwrap();
        assert!(load(root.path()).await.is_ok());
        std::fs::write(directory.join(NAMES[1]), b"changed").unwrap();
        assert!(
            load(root.path())
                .await
                .unwrap_err()
                .to_string()
                .contains("cache changed")
        );
    }
    #[test]
    fn rejects_wrong_architecture_and_non_libraries() {
        assert!(elf(b"not an ELF").is_err());
        let mut bytes = vec![0; 64];
        bytes[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
        bytes[16..18].copy_from_slice(&3u16.to_le_bytes());
        bytes[18..20].copy_from_slice(
            &(if cfg!(target_arch = "aarch64") {
                62u16
            } else {
                183
            })
            .to_le_bytes(),
        );
        assert!(elf(&bytes).is_err());
    }
    #[tokio::test]
    async fn rejects_incomplete_cache_without_network() {
        let root = tempfile::tempdir().unwrap();
        let cache = root.path().join("libraries");
        std::fs::create_dir(&cache).unwrap();
        std::fs::write(cache.join(NAMES[0]), b"bad").unwrap();
        assert!(
            load(root.path())
                .await
                .unwrap_err()
                .to_string()
                .contains("incomplete")
        );
    }
}
