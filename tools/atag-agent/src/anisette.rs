//! Shared local/remote Anisette boundary. Workers and remote providers receive
//! no Apple account credentials or accessory private keys.
pub mod local;
mod mac_coreadi;
mod mid_service;
mod remote_v3;
use crate::{error::ApiError, now};
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{
    Client, Url,
    header::{HeaderMap, HeaderName, HeaderValue},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

#[derive(Clone, Copy, Default, Deserialize, Serialize, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum ClientProfile {
    #[default]
    Auto,
    Macos,
    Windows,
}

impl ClientProfile {
    pub(crate) fn fallback(self) -> (&'static str, &'static str) {
        match self {
            Self::Windows => (
                "<PC> <Windows;6.2(0,0);9200> <com.apple.AuthKit/1 (com.apple.iTunes/12.12.4.1)>",
                "akd/1.0 CFNetwork/808.1.4",
            ),
            _ => (
                "<MacBookPro18,3> <macOS;26.6;25F84> <com.apple.AuthKit/1 (com.apple.akd/1.0)>",
                "akd/1.0 CFNetwork/808.1.4",
            ),
        }
    }
}

#[derive(Clone)]
pub struct AnisetteProvider {
    client: Client,
    source: Source,
}
#[derive(Clone)]
enum Source {
    Remote(Url),
    SideStore(remote_v3::Provider),
    MacCoreAdi(mac_coreadi::Provider),
    Local(local::LocalProvider),
}
pub(crate) struct AnisetteHeaders {
    pub headers: HeaderMap,
    pub client_info: String,
    pub user_agent: String,
}

impl AnisetteProvider {
    pub fn new(input: &str) -> Result<Self, ApiError> {
        if matches!(
            input,
            "" | "mac-coreadi" | "local" | "portable" | "sidestore"
        ) {
            let directory = dirs::data_local_dir()
                .ok_or_else(ApiError::internal)?
                .join("atag-agent");
            return Self::for_directory(input, &directory);
        }
        let url = Url::parse(input).map_err(|_| ApiError::invalid("Anisette 地址无效。"))?;
        let local = matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        );
        if !(url.scheme() == "https" || url.scheme() == "http" && local)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(ApiError::invalid(
                "Anisette 需要 HTTPS 或 loopback HTTP，不能包含内嵌凭据或片段。",
            ));
        }
        Ok(Self {
            client: http_client()?,
            source: Source::Remote(url),
        })
    }

    /// The default uses emulated macOS CoreADI. Explicit `local` keeps the
    /// historical backend for accounts already bound to it.
    /// `sidestore` uses the official v3 service; a URL uses the v1 JSON API.
    pub fn for_directory(input: &str, directory: &std::path::Path) -> Result<Self, ApiError> {
        if matches!(input, "" | "mac-coreadi") {
            Ok(Self {
                client: http_client()?,
                source: Source::MacCoreAdi(mac_coreadi::Provider::new(directory)),
            })
        } else if input == "sidestore" {
            Ok(Self {
                client: http_client()?,
                source: Source::SideStore(remote_v3::Provider::new(directory)),
            })
        } else if matches!(input, "local" | "portable") {
            Ok(Self {
                client: http_client()?,
                source: Source::Local(local::LocalProvider::new(directory, input == "portable")),
            })
        } else {
            Self::new(input)
        }
    }
    pub async fn initialize(&self) -> Result<(), ApiError> {
        if let Source::MacCoreAdi(provider) = &self.source {
            return provider.initialize().await;
        }
        self.headers("initialization", "initialization", ClientProfile::Auto)
            .await
            .map(|_| ())
    }

    pub(crate) async fn headers(
        &self,
        uid: &str,
        device_id: &str,
        profile: ClientProfile,
    ) -> Result<AnisetteHeaders, ApiError> {
        let (value, is_local) = match &self.source {
            Source::Local(provider) => (serde_json::to_value(provider.headers().await?)?, true),
            Source::MacCoreAdi(provider) => {
                return normalize(
                    serde_json::to_value(provider.headers().await?)?,
                    true,
                    uid,
                    device_id,
                    ClientProfile::Auto,
                );
            }
            Source::SideStore(provider) => {
                // The client profile is part of the v3 provisioned machine.
                return normalize(
                    provider.headers().await?,
                    true,
                    uid,
                    device_id,
                    ClientProfile::Auto,
                );
            }
            Source::Remote(url) => {
                let response = self
                    .client
                    .get(url.clone())
                    .send()
                    .await
                    .map_err(network_error)?;
                if !response.status().is_success() {
                    return Err(unavailable());
                }
                (
                    serde_json::from_slice::<Value>(&bounded_body(response, 64 * 1024).await?)
                        .map_err(|_| unavailable())?,
                    false,
                )
            }
        };
        normalize(value, is_local, uid, device_id, profile)
    }
}

pub fn install_mac_coreadi(
    directory: &std::path::Path,
    library: &std::path::Path,
    machine: Option<&std::path::Path>,
) -> Result<(), ApiError> {
    mac_coreadi::install(directory, library, machine)
}

fn normalize(
    value: Value,
    is_local: bool,
    uid: &str,
    device_id: &str,
    profile: ClientProfile,
) -> Result<AnisetteHeaders, ApiError> {
    let mut headers = HeaderMap::new();
    for name in ["X-Apple-I-MD", "X-Apple-I-MD-M"] {
        insert(
            &mut headers,
            name,
            text(&value, name).ok_or_else(unavailable)?,
        )?;
    }
    let routing = value
        .get("X-Apple-I-MD-RINFO")
        .and_then(|v| {
            v.as_str()
                .map(str::to_owned)
                .or_else(|| v.as_u64().map(|n| n.to_string()))
        })
        .unwrap_or_else(|| "17106176".into());
    if routing.is_empty() || routing.len() > 20 || !routing.bytes().all(|b| b.is_ascii_digit()) {
        return Err(unavailable());
    }
    for (name, default) in [
        ("X-Apple-I-Client-Time", now()),
        ("X-Apple-I-TimeZone", "UTC".into()),
        ("X-Apple-Locale", "en_US".into()),
        ("loc", "en_US".into()),
        ("X-Apple-I-MD-LU", STANDARD.encode(uid)),
        ("X-Mme-Device-Id", device_id.to_uppercase()),
        ("X-Apple-I-MD-RINFO", routing),
        ("X-Apple-I-SRL-NO", "0".into()),
    ] {
        // Machine-bound local metadata must match the ADI device which made
        // the OTP. Remote providers retain their historical identity policy.
        let value = if is_local
            && matches!(
                name,
                "X-Apple-I-MD-LU" | "X-Mme-Device-Id" | "X-Apple-I-SRL-NO"
            ) {
            text(&value, name).ok_or_else(unavailable)?.to_owned()
        } else {
            default
        };
        insert(&mut headers, name, &value)?;
    }
    // Only client identity metadata is adopted. Arbitrary provider headers
    // (including Authorization, cookies and Host) are never forwarded.
    let (fallback, agent) = profile.fallback();
    let client_info = if matches!(profile, ClientProfile::Auto) {
        text(&value, "X-Mme-Client-Info")
            .or_else(|| text(&value, "client_info"))
            .unwrap_or(fallback)
    } else {
        fallback
    };
    let user_agent = if matches!(profile, ClientProfile::Auto) {
        text(&value, "User-Agent")
            .or_else(|| text(&value, "user_agent"))
            .unwrap_or(agent)
    } else {
        agent
    };
    HeaderValue::from_str(client_info).map_err(|_| unavailable())?;
    HeaderValue::from_str(user_agent).map_err(|_| unavailable())?;
    Ok(AnisetteHeaders {
        headers,
        client_info: client_info.into(),
        user_agent: user_agent.into(),
    })
}

fn text<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 1024)
}
fn unavailable() -> ApiError {
    ApiError::new(
        axum::http::StatusCode::BAD_GATEWAY,
        "UPSTREAM_UNAVAILABLE",
        "Anisette 服务不可用或返回的 JSON 缺少必要字段。",
        true,
    )
}
pub(crate) fn insert(headers: &mut HeaderMap, name: &str, value: &str) -> Result<(), ApiError> {
    headers.insert(
        HeaderName::from_bytes(name.as_bytes()).map_err(|_| ApiError::internal())?,
        HeaderValue::from_str(value).map_err(|_| unavailable())?,
    );
    Ok(())
}
pub(crate) fn http_client() -> Result<Client, ApiError> {
    Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| ApiError::internal())
}
/// GrandSlam chains to Apple's private PKI, which webpki-roots omits. Only
/// fixed Apple endpoints use this additional root; remote providers do not.
pub(crate) fn apple_http_client() -> Result<Client, ApiError> {
    let root =
        reqwest::Certificate::from_der(include_bytes!("anisette/AppleIncRootCertificate.cer"))
            .map_err(|_| ApiError::internal())?;
    Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .add_root_certificate(root)
        // GrandSlam can accept init, then stall complete on a reused socket.
        // Use fresh HTTP/1.1 connections instead of replaying auth requests.
        .http1_only()
        .pool_max_idle_per_host(0)
        .build()
        .map_err(|_| ApiError::internal())
}
pub(crate) fn network_error(error: reqwest::Error) -> ApiError {
    if error.is_timeout() {
        ApiError::timeout()
    } else {
        ApiError::new(
            axum::http::StatusCode::BAD_GATEWAY,
            "UPSTREAM_UNAVAILABLE",
            "无法访问 Apple 或 Anisette 服务，请稍后重试。",
            true,
        )
    }
}
pub(crate) async fn bounded_body(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, ApiError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if bytes.len() + chunk.len() > limit {
            return Err(ApiError::upstream());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn apple_pki_root_matches_the_reviewed_official_certificate() {
        use sha2::{Digest, Sha256};
        assert_eq!(
            crate::hex(&Sha256::digest(include_bytes!(
                "anisette/AppleIncRootCertificate.cer"
            ))),
            "b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024"
        );
        assert!(apple_http_client().is_ok());
    }
    #[test]
    fn local_headers_keep_the_adi_machine_identity_and_filter_untrusted_headers() {
        let raw = serde_json::json!({"X-Apple-I-MD":"otp","X-Apple-I-MD-M":"mid","X-Apple-I-MD-LU":"machine-user","X-Mme-Device-Id":"machine-device","X-Apple-I-SRL-NO":"machine-serial","X-Mme-Client-Info":"actual-client","Authorization":"never-forward"});
        let local = normalize(
            raw.clone(),
            true,
            "account-user",
            "account-device",
            ClientProfile::Auto,
        )
        .unwrap();
        assert_eq!(local.headers["X-Apple-I-MD-LU"], "machine-user");
        assert_eq!(local.headers["X-Mme-Device-Id"], "machine-device");
        assert_eq!(local.headers["X-Apple-I-SRL-NO"], "machine-serial");
        assert_eq!(local.client_info, "actual-client");
        assert!(!local.headers.contains_key("authorization"));
        let remote = normalize(
            raw,
            false,
            "account-user",
            "account-device",
            ClientProfile::Auto,
        )
        .unwrap();
        assert_eq!(
            remote.headers["X-Apple-I-MD-LU"],
            STANDARD.encode("account-user")
        );
        assert_eq!(remote.headers["X-Mme-Device-Id"], "ACCOUNT-DEVICE");
    }
    #[test]
    fn local_and_remote_sources_are_validated_without_network() {
        let root = tempfile::tempdir().unwrap();
        for source in ["local", "portable"] {
            assert!(matches!(
                AnisetteProvider::for_directory(source, root.path())
                    .unwrap()
                    .source,
                Source::Local(_)
            ));
        }
        for source in ["", "mac-coreadi"] {
            assert!(matches!(
                AnisetteProvider::for_directory(source, root.path())
                    .unwrap()
                    .source,
                Source::MacCoreAdi(_)
            ));
        }
        assert!(matches!(
            AnisetteProvider::for_directory("sidestore", root.path())
                .unwrap()
                .source,
            Source::SideStore(_)
        ));
        assert!(matches!(
            AnisetteProvider::for_directory("http://127.0.0.1:6969", root.path())
                .unwrap()
                .source,
            Source::Remote(_)
        ));
        for source in [
            "file:///private/data",
            "http://provider.example",
            "https://user:password@provider.example",
        ] {
            assert!(AnisetteProvider::for_directory(source, root.path()).is_err());
        }
    }
}
