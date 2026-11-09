//! Apple Android ADI ABI. Libraries never receive Apple account credentials.
use super::{Headers, elf::Library, libraries, shim};
use crate::{
    anisette::{apple_http_client, bounded_body},
    private_files::{prepare_private_directory, protect, read_bounded},
};
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use plist::{Dictionary, Value};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{
    ffi::{CString, c_char},
    io::Cursor,
    path::Path,
};

type Load = adi_type!(fn(*const c_char) -> i32);
type Identifier = adi_type!(fn(*const u8, u32) -> i32);
type Start = adi_type!(fn(i64, *const u8, u32, *mut *const u8, *mut u32, *mut u32) -> i32);
type End = adi_type!(fn(u32, *const u8, u32, *const u8, u32) -> i32);
type Destroy = adi_type!(fn(u32) -> i32);
type Status = adi_type!(fn(i64) -> i32);
type Dispose = adi_type!(fn(*const u8) -> i32);
type Otp = adi_type!(fn(i64, *mut *const u8, *mut u32, *mut *const u8, *mut u32) -> i32);
struct Driver {
    start: Start,
    end: End,
    destroy: Destroy,
    status: Status,
    dispose: Dispose,
    otp: Otp,
}
fn check(code: i32) -> Result<()> {
    if code != 0 {
        bail!("ADI operation failed ({code})");
    }
    Ok(())
}
impl Driver {
    fn load(bytes: [Vec<u8>; 2], root: &Path, identity: &Identity) -> Result<Self> {
        shim::set_root(root);
        let services = Box::leak(Box::new(Library::load(&bytes[0], &shim::resolve)?));
        shim::register("libstoreservicescore.so", services);
        let core = Box::leak(Box::new(Library::load(&bytes[1], &shim::resolve)?));
        shim::register("libCoreADI.so", core);
        macro_rules! symbol {
            ($name:literal,$typ:ty) => {
                unsafe {
                    std::mem::transmute::<usize, $typ>(
                        services.symbol($name).context("missing ADI entry point")?,
                    )
                }
            };
        }
        let load = symbol!("kq56gsgHG6", Load);
        let identifier = symbol!("Sph98paBcz", Identifier);
        let path = symbol!("nf92ngaK92", Load);
        let state = root.join("provisioning");
        prepare_private_directory(&state)?;
        let library_path = CString::new(root.join("libraries").to_str().context("path encoding")?)?;
        let state_path = CString::new(state.to_str().context("path encoding")?)?;
        unsafe {
            check(load(library_path.as_ptr()))?;
            check(identifier(identity.adi.as_ptr(), identity.adi.len() as u32))?;
            check(path(state_path.as_ptr()))?;
        }
        Ok(Self {
            start: symbol!("rsegvyrt87", Start),
            end: symbol!("uv5t6nhkui", End),
            destroy: symbol!("fy34trz2st", Destroy),
            status: symbol!("aslgmuibau", Status),
            dispose: symbol!("jk24uiwqrg", Dispose),
            otp: symbol!("qi864985u0", Otp),
        })
    }
    fn buffer(&self, pointer: *const u8, length: u64) -> Result<Vec<u8>> {
        if pointer.is_null() || length == 0 || length > 1024 * 1024 {
            bail!("invalid ADI buffer");
        }
        let bytes = unsafe { std::slice::from_raw_parts(pointer, length as usize) }.to_vec();
        unsafe {
            check((self.dispose)(pointer))?;
        }
        Ok(bytes)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    device: String,
    local_user: String,
    adi: String,
}
impl Identity {
    fn load(root: &Path) -> Result<Self> {
        let path = root.join("identity.json");
        if path.exists() {
            let value: Self = serde_json::from_slice(&read_bounded(&path, 4096)?)?;
            if value.device.len() != 36
                || value.local_user.len() != 64
                || value.adi.len() != 16
                || !value
                    .local_user
                    .bytes()
                    .chain(value.adi.bytes())
                    .all(|b| b.is_ascii_hexdigit())
            {
                bail!("invalid machine identity");
            }
            return Ok(value);
        }
        let mut random = [0; 56];
        OsRng.try_fill_bytes(&mut random).context("random source")?;
        random[6] = (random[6] & 0x0f) | 0x40;
        random[8] = (random[8] & 0x3f) | 0x80;
        let hex = crate::hex(&random[..16]);
        let value = Self {
            device: format!(
                "{}-{}-{}-{}-{}",
                &hex[..8],
                &hex[8..12],
                &hex[12..16],
                &hex[16..20],
                &hex[20..]
            )
            .to_uppercase(),
            local_user: crate::hex(&random[16..48]).to_uppercase(),
            adi: crate::hex(&random[48..]),
        };
        libraries::save(&path, &serde_json::to_vec(&value)?)?;
        Ok(value)
    }
    fn headers(&self) -> Headers {
        Headers::from([
            ("X-Mme-Device-Id".into(), self.device.clone()),
            ("X-Apple-I-MD-LU".into(), self.local_user.clone()),
            (
                "X-Mme-Client-Info".into(),
                // AuthKit wire profile, independent of the ADI library's ELF ABI.
                "<MacBookPro13,2> <macOS;13.1;22C65> <com.apple.AuthKit/1 (com.apple.akd/1.0)>"
                    .into(),
            ),
            (
                "User-Agent".into(),
                "akd/1.0 CFNetwork/1404.0.5 Darwin/22.3.0".into(),
            ),
            ("X-Apple-I-SRL-NO".into(), "0".into()),
            ("X-Apple-I-MD-RINFO".into(), "17106176".into()),
        ])
    }
}
fn dictionary(value: &Value) -> Result<&Dictionary> {
    value.as_dictionary().context("expected plist dictionary")
}
fn data(value: &Value, key: &str) -> Result<Vec<u8>> {
    let item = dictionary(value)?
        .get(key)
        .context("missing provisioning field")?;
    let bytes = match item {
        Value::Data(bytes) => bytes.clone(),
        Value::String(s) => STANDARD.decode(s)?,
        _ => bail!("invalid provisioning field"),
    };
    if bytes.is_empty() || bytes.len() > 1024 * 1024 {
        bail!("provisioning field too large");
    }
    Ok(bytes)
}
fn endpoint(value: &Value, key: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(
        dictionary(value)?
            .get(key)
            .and_then(Value::as_string)
            .context("missing provisioning URL")?,
    )?;
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("gsa.apple.com" | "gsas.apple.com"))
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        bail!("untrusted provisioning URL");
    }
    Ok(url)
}
async fn response(response: reqwest::Response) -> Result<Value> {
    let value = Value::from_reader(Cursor::new(
        bounded_body(response.error_for_status()?, 2 * 1024 * 1024).await?,
    ))?;
    Ok(value)
}
async fn post(
    client: &reqwest::Client,
    url: reqwest::Url,
    headers: &Headers,
    request: Dictionary,
) -> Result<Value> {
    let mut body = Dictionary::new();
    body.insert("Header".into(), Value::Dictionary(Dictionary::new()));
    body.insert("Request".into(), Value::Dictionary(request));
    let mut xml = Vec::new();
    Value::Dictionary(body).to_writer_xml(&mut xml)?;
    let mut call = client
        .post(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("X-Apple-Client-App-Name", "Setup")
        .header("X-Apple-I-Client-Time", crate::now())
        .body(xml);
    for (k, v) in headers {
        call = call.header(k, v);
    }
    let value = response(call.send().await.context("机器注册网络请求失败")?)
        .await
        .context("机器注册响应的 HTTP 状态或 plist 无效")?;
    let result = dictionary(&value)?
        .get("Response")
        .context("missing provisioning response")?;
    if let Some(status) = dictionary(result)?.get("Status") {
        let code = dictionary(status)?
            .get("ec")
            .and_then(Value::as_signed_integer)
            .context("missing provisioning status")?;
        if code != 0 {
            bail!("Apple declined machine provisioning ({code})");
        }
    }
    Ok(result.clone())
}
struct Session<'a> {
    driver: &'a Driver,
    id: u32,
    finished: bool,
}
impl Drop for Session<'_> {
    fn drop(&mut self) {
        if !self.finished {
            unsafe {
                (self.driver.destroy)(self.id);
            }
        }
    }
}
async fn provision(driver: &Driver, headers: &Headers) -> Result<()> {
    let client = apple_http_client()?;
    let mut call = client
        .get("https://gsa.apple.com/grandslam/GsService2/lookup")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("X-Apple-Client-App-Name", "Setup");
    for (k, v) in headers {
        call = call.header(k, v);
    }
    let lookup = response(call.send().await.context("Apple lookup 网络请求失败")?)
        .await
        .context("Apple lookup 的 HTTP 状态或 plist 无效")?;
    let urls = dictionary(&lookup)?
        .get("urls")
        .context("missing URL bag")?;
    let start_url = endpoint(urls, "midStartProvisioning")?;
    let finish_url = endpoint(urls, "midFinishProvisioning")?;
    let spim = data(
        &post(&client, start_url, headers, Dictionary::new()).await?,
        "spim",
    )?;
    // Reserve 64 bits: ADI builds differ in the width of these output lengths.
    let (mut pointer, mut length, mut id) = (std::ptr::null(), 0u64, 0);
    unsafe {
        check((driver.start)(
            -2,
            spim.as_ptr(),
            spim.len() as u32,
            &mut pointer,
            (&mut length as *mut u64).cast(),
            &mut id,
        ))?;
    }
    let mut session = Session {
        driver,
        id,
        finished: false,
    };
    let cpim = driver.buffer(pointer, length)?;
    let mut request = Dictionary::new();
    request.insert("cpim".into(), Value::String(STANDARD.encode(cpim)));
    let finish = post(&client, finish_url, headers, request).await?;
    let ptm = data(&finish, "ptm")?;
    let tk = data(&finish, "tk")?;
    unsafe {
        check((driver.end)(
            id,
            ptm.as_ptr(),
            ptm.len() as u32,
            tk.as_ptr(),
            tk.len() as u32,
        ))?;
    }
    session.finished = true;
    Ok(())
}
async fn generate(root: &Path) -> Result<Headers> {
    let bytes = libraries::load(root)
        .await
        .context("Apple 运行库下载或缓存校验失败；可运行 anisette init --repair 重试")?;
    let identity = Identity::load(root).context("本地机器身份文件无效或不可读")?;
    let driver = Driver::load(bytes, root, &identity)
        .context("此 Apple 运行库的 ELF / ADI ABI 无法在当前平台加载")?;
    let mut headers = identity.headers();
    match unsafe { (driver.status)(-2) } {
        0 => (),
        -45061 => provision(&driver, &headers).await?,
        code => check(code).context("Apple ADI 无法读取本机注册状态")?,
    }
    let (mut mid, mut mid_length, mut otp, mut otp_length) =
        (std::ptr::null(), 0u64, std::ptr::null(), 0u64);
    unsafe {
        check((driver.otp)(
            -2,
            &mut mid,
            (&mut mid_length as *mut u64).cast(),
            &mut otp,
            (&mut otp_length as *mut u64).cast(),
        ))
        .context("Apple ADI 无法生成一次性认证头")?;
    }
    headers.insert(
        "X-Apple-I-MD-M".into(),
        STANDARD.encode(
            driver
                .buffer(mid, mid_length)
                .context("ADI machine ID 无效")?,
        ),
    );
    headers.insert(
        "X-Apple-I-MD".into(),
        STANDARD.encode(driver.buffer(otp, otp_length).context("ADI OTP 无效")?),
    );
    for entry in std::fs::read_dir(root.join("provisioning")).context("无法保护 ADI 注册文件")?
    {
        let path = entry.context("无法保护 ADI 注册文件")?.path();
        protect(&path, path.is_dir()).context("无法保护 ADI 注册文件")?;
    }
    Ok(headers)
}
pub(super) async fn headers(root: &Path) -> Result<Headers, String> {
    // Errors deliberately omit response bodies, machine identifiers and OTP values.
    generate(root)
        .await
        .map_err(|error| format!("本地 Anisette：{error}。"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_provisioning_hosts_and_payloads() {
        let mut d = Dictionary::new();
        for url in [
            "http://gsa.apple.com/x",
            "https://gsa.apple.com.evil/x",
            "https://evil.test/x",
            "https://user@gsa.apple.com/x",
        ] {
            d.insert("url".into(), url.into());
            assert!(endpoint(&Value::Dictionary(d.clone()), "url").is_err());
        }
        d.insert("url".into(), "https://gsa.apple.com/x".into());
        assert!(endpoint(&Value::Dictionary(d), "url").is_ok());
        let mut d = Dictionary::new();
        d.insert("spim".into(), "%%".into());
        assert!(data(&Value::Dictionary(d), "spim").is_err());
    }
    #[test]
    fn machine_identity_is_stable() {
        let root = tempfile::tempdir().unwrap();
        let a = Identity::load(root.path()).unwrap();
        let b = Identity::load(root.path()).unwrap();
        assert_eq!(a.adi, b.adi);
        assert_eq!(a.device, b.device);
        assert_eq!(a.local_user, b.local_user);
        let headers = b.headers();
        assert!(headers["X-Mme-Client-Info"].contains("com.apple.akd/"));
        assert!(!headers["X-Mme-Client-Info"].contains("Xcode"));
    }
}
