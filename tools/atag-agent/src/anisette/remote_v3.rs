//! SideStore's v3 protocol: a separate machine identity, with no Apple account data.
//! Protocol reference: SideStore/apple-private-apis, omnisette/remote_anisette_v3.rs.
use super::{apple_http_client, bounded_body, http_client, local, network_error};
use crate::{error::ApiError, hex, now, private_files};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
use rand_core::{OsRng, RngCore};
use reqwest::{Client, RequestBuilder, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{Cursor, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio_tungstenite::{
    WebSocketStream, connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};

const SERVER: &str = "https://new.ani.sidestore.io";
const LOOKUP: &str = "https://gsa.apple.com/grandslam/GsService2/lookup";
const LIMIT: usize = 64 * 1024;
const SIDESTORE_LEGACY_CLIENT: &str =
    "<MacBookPro13,3> <Mac OS X;10.12.6;16G29> <com.apple.AuthKit/1 (com.apple.akd/1.0)>";
const FIND_MY_CLIENT: &str =
    "<MacBookPro13,2> <macOS;13.1;22C65> <com.apple.AuthKit/1 (com.apple.akd/1.0)>";
const FIND_MY_USER_AGENT: &str = "akd/1.0 CFNetwork/1404.0.5 Darwin/22.2.0";

#[derive(Clone)]
pub(super) struct Provider {
    directory: PathBuf,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Machine {
    identifier: [u8; 16],
    adi_pb: Option<String>,
}

impl Machine {
    fn new() -> Self {
        let mut identifier = [0; 16];
        OsRng.fill_bytes(&mut identifier);
        Self {
            identifier,
            adi_pb: None,
        }
    }
    fn md_lu(&self) -> String {
        hex(&Sha256::digest(self.identifier))
    }
    fn device_id(&self) -> String {
        let id = hex(&self.identifier);
        format!(
            "{}-{}-{}-{}-{}",
            &id[..8],
            &id[8..12],
            &id[12..16],
            &id[16..20],
            &id[20..]
        )
    }
    fn load(path: &Path) -> Result<Self, ApiError> {
        match std::fs::symlink_metadata(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::new()),
            Err(e) => Err(e.into()),
            Ok(_) => {
                let machine: Self =
                    serde_json::from_slice(&private_files::read_bounded(path, LIMIT as u64)?)
                        .map_err(|_| ApiError::invalid("SideStore 机器缓存损坏。"))?;
                if let Some(blob) = &machine.adi_pb {
                    validate_blob(blob)?;
                }
                private_files::protect(path, false)?;
                Ok(machine)
            }
        }
    }
    fn save(&self, path: &Path) -> Result<(), ApiError> {
        let mut file =
            tempfile::NamedTempFile::new_in(path.parent().ok_or_else(ApiError::internal)?)?;
        private_files::protect(file.path(), false)?;
        serde_json::to_writer(&mut file, self)?;
        file.flush()?;
        file.as_file().sync_all()?;
        file.persist(path).map_err(|_| ApiError::internal())?;
        Ok(())
    }
}

#[derive(Deserialize)]
struct ClientInfo {
    client_info: String,
    user_agent: String,
}

impl ClientInfo {
    fn for_find_my(self) -> Self {
        if self.client_info == SIDESTORE_LEGACY_CLIENT {
            // The official node's Sierra profile predates offline Find My.
            // Keep the v3 Mac ADI machine and use the platform tuple exercised
            // by sacca97/os-findmy-e (tools/machoadi/provider.py).
            Self {
                client_info: FIND_MY_CLIENT.into(),
                user_agent: FIND_MY_USER_AGENT.into(),
            }
        } else {
            self
        }
    }
    fn apple_request(&self, machine: &Machine, request: RequestBuilder) -> RequestBuilder {
        request
            .header("X-Mme-Client-Info", &self.client_info)
            .header("User-Agent", &self.user_agent)
            .header("Content-Type", "text/x-xml-plist")
            .header("X-Apple-I-MD-LU", machine.md_lu())
            .header("X-Mme-Device-Id", machine.device_id())
            .header("X-Apple-I-Client-Time", now())
            .header("X-Apple-I-TimeZone", "UTC")
            .header("X-Apple-Locale", "en_US")
    }
}

impl Provider {
    pub(super) fn new(directory: &Path) -> Self {
        Self {
            directory: directory.join("anisette").join("sidestore-v3"),
        }
    }
    pub(super) async fn headers(&self) -> Result<Value, ApiError> {
        tokio::time::timeout(Duration::from_secs(40), self.generate())
            .await
            .map_err(|_| failure("SideStore 机器认证请求超时，请重试。"))?
    }
    async fn generate(&self) -> Result<Value, ApiError> {
        private_files::prepare_private_directory(&self.directory)?;
        let _lock = local::lock(&self.directory, false)?;
        let path = self.directory.join("machine.json");
        let mut machine = Machine::load(&path)?;
        // Commit the identity before provisioning so a cancelled request keeps it.
        machine.save(&path)?;
        let client = http_client()?;
        let metadata = serde_json::from_slice::<ClientInfo>(
            &response_bytes(client.get(format!("{SERVER}/v3/client_info"))).await?,
        )
        .map_err(|_| failure("SideStore 客户端资料无效。"))?
        .for_find_my();
        for text in [&metadata.client_info, &metadata.user_agent] {
            if text.is_empty()
                || text.len() > 1024
                || reqwest::header::HeaderValue::from_str(text).is_err()
            {
                return Err(failure("SideStore 客户端资料无效。"));
            }
        }
        if machine.adi_pb.is_none() {
            provision(&metadata, &mut machine).await?;
            machine.save(&path)?;
        }
        let mut result = get_headers(&client, &machine).await?;
        // The server's ADI machine may have expired. Retry provisioning once,
        // retaining the identifier, and do not hide unrelated provider errors.
        if result.get("result").and_then(Value::as_str) == Some("GetHeadersError")
            && result
                .get("message")
                .and_then(Value::as_str)
                .is_some_and(|m| m.contains("-45061"))
        {
            machine.adi_pb = None;
            machine.save(&path)?;
            provision(&metadata, &mut machine).await?;
            machine.save(&path)?;
            result = get_headers(&client, &machine).await?;
        }
        if result.get("result").and_then(Value::as_str) != Some("Headers") {
            return Err(failure("SideStore 未能生成机器认证数据，请稍后重试。"));
        }
        // Only these protocol fields cross the boundary. Never forward extra headers.
        Ok(json!({
            "X-Apple-I-MD": result.get("X-Apple-I-MD"),
            "X-Apple-I-MD-M": result.get("X-Apple-I-MD-M"),
            "X-Apple-I-MD-RINFO": result.get("X-Apple-I-MD-RINFO"),
            "X-Apple-I-MD-LU": machine.md_lu(),
            "X-Mme-Device-Id": machine.device_id(),
            "X-Apple-I-SRL-NO": "0",
            "client_info": metadata.client_info,
            "user_agent": metadata.user_agent,
        }))
    }
}

async fn get_headers(client: &Client, machine: &Machine) -> Result<Value, ApiError> {
    serde_json::from_slice(
        &response_bytes(client.post(format!("{SERVER}/v3/get_headers")).json(
            &json!({"identifier": STANDARD.encode(machine.identifier), "adi_pb": machine.adi_pb}),
        ))
        .await?,
    )
    .map_err(|_| failure("SideStore 返回了无效的机器认证数据。"))
}

async fn response_bytes(request: RequestBuilder) -> Result<Vec<u8>, ApiError> {
    let response = request.send().await.map_err(network_error)?;
    if !response.status().is_success() {
        eprintln!(
            "atag-agent: Anisette v3 upstream returned HTTP {}",
            response.status().as_u16()
        );
        return Err(failure("SideStore 或 Apple 机器注册服务暂不可用。"));
    }
    bounded_body(response, LIMIT).await
}

fn failure(message: &str) -> ApiError {
    local::failure(message)
}
fn validate_blob(blob: &str) -> Result<(), ApiError> {
    if blob.is_empty() || blob.len() > 48 * 1024 || STANDARD.decode(blob).is_err() {
        return Err(failure("SideStore 返回了无效的机器注册数据。"));
    }
    Ok(())
}

// Lookup URLs are Apple responses, not instructions from the Anisette server.
// Nevertheless constrain them before sending any provisioning material.
fn apple_url(url: &str) -> Result<Url, ApiError> {
    let url = Url::parse(url).map_err(|_| failure("Apple 机器注册地址无效。"))?;
    if url.scheme() != "https"
        || url.host_str() != Some("gsa.apple.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return Err(failure("Apple 机器注册地址不受支持。"));
    }
    Ok(url)
}
fn plist_field<'a>(value: &'a plist::Value, name: &str) -> Result<&'a str, ApiError> {
    value
        .as_dictionary()
        .and_then(|d| d.get(name))
        .and_then(plist::Value::as_string)
        .ok_or_else(|| failure("Apple 机器注册响应缺少必要字段。"))
}
async fn apple_plist(request: RequestBuilder) -> Result<plist::Value, ApiError> {
    plist::Value::from_reader(Cursor::new(response_bytes(request).await?))
        .map_err(|_| failure("Apple 机器注册响应无效。"))
}
async fn apple_provision(
    client: &Client,
    info: &ClientInfo,
    machine: &Machine,
    url: Url,
    request: Value,
) -> Result<plist::Value, ApiError> {
    let mut body = Vec::new();
    plist::to_writer_xml(&mut body, &json!({"Header": {}, "Request": request}))
        .map_err(|_| ApiError::internal())?;
    let response = apple_plist(info.apple_request(machine, client.post(url)).body(body)).await?;
    response
        .as_dictionary()
        .and_then(|d| d.get("Response"))
        .cloned()
        .ok_or_else(|| failure("Apple 机器注册响应缺少必要字段。"))
}

#[derive(Deserialize)]
#[serde(tag = "result")]
enum ProvisionStep {
    GiveIdentifier,
    GiveStartProvisioningData,
    GiveEndProvisioningData { cpim: String },
    ProvisioningSuccess { adi_pb: String },
}

async fn provision(info: &ClientInfo, machine: &mut Machine) -> Result<(), ApiError> {
    let client = apple_http_client()?;
    let lookup = apple_plist(info.apple_request(machine, client.get(LOOKUP))).await?;
    let urls = lookup
        .as_dictionary()
        .and_then(|d| d.get("urls"))
        .ok_or_else(|| failure("Apple 机器注册目录无效。"))?;
    let start = apple_url(plist_field(urls, "midStartProvisioning")?)?;
    let finish = apple_url(plist_field(urls, "midFinishProvisioning")?)?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(LIMIT))
        .max_frame_size(Some(LIMIT));
    let (ws, _) = connect_async_with_config(
        format!(
            "{}/v3/provisioning_session",
            SERVER.replace("https:", "wss:")
        ),
        Some(config),
        false,
    )
    .await
    .map_err(|_| failure("无法连接 SideStore 机器注册服务。"))?;
    provision_session(ws, &client, info, machine, start, finish).await
}

async fn provision_session<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    mut ws: WebSocketStream<S>,
    client: &Client,
    info: &ClientInfo,
    machine: &mut Machine,
    start: Url,
    finish: Url,
) -> Result<(), ApiError> {
    let mut expected = 0;
    while let Some(message) = ws.next().await {
        let message = message.map_err(|_| failure("SideStore 机器注册连接中断。"))?;
        let Message::Text(text) = message else {
            if message.is_ping() || message.is_pong() {
                continue;
            }
            break;
        };
        let step: ProvisionStep =
            serde_json::from_str(&text).map_err(|_| failure("SideStore 机器注册响应无效。"))?;
        let reply = match (expected, step) {
            (0, ProvisionStep::GiveIdentifier) => {
                json!({"identifier": STANDARD.encode(machine.identifier)})
            }
            (1, ProvisionStep::GiveStartProvisioningData) => {
                let response =
                    apple_provision(client, info, machine, start.clone(), json!({})).await?;
                json!({"spim": plist_field(&response, "spim")?})
            }
            (2, ProvisionStep::GiveEndProvisioningData { cpim }) => {
                validate_blob(&cpim)?;
                let response =
                    apple_provision(client, info, machine, finish.clone(), json!({"cpim": cpim}))
                        .await?;
                json!({"ptm": plist_field(&response, "ptm")?, "tk": plist_field(&response, "tk")?})
            }
            (3, ProvisionStep::ProvisioningSuccess { adi_pb }) => {
                validate_blob(&adi_pb)?;
                machine.adi_pb = Some(adi_pb);
                let _ = ws.close(None).await;
                return Ok(());
            }
            _ => return Err(failure("SideStore 机器注册步骤异常。")),
        };
        ws.send(Message::Text(reply.to_string().into()))
            .await
            .map_err(|_| failure("SideStore 机器注册连接中断。"))?;
        expected += 1;
    }
    Err(failure("SideStore 机器注册未完成，请重试。"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_official_sierra_profile_uses_a_consistent_find_my_platform() {
        let legacy = ClientInfo {
            client_info: SIDESTORE_LEGACY_CLIENT.into(),
            user_agent: "akd/1.0 CFNetwork/811.5.4 Darwin/16.7.0".into(),
        }
        .for_find_my();
        assert_eq!(legacy.client_info, FIND_MY_CLIENT);
        assert_eq!(legacy.user_agent, FIND_MY_USER_AGENT);
        let other = ClientInfo {
            client_info: "server-supplied-client".into(),
            user_agent: "server-supplied-agent".into(),
        }
        .for_find_my();
        assert_eq!(other.client_info, "server-supplied-client");
        assert_eq!(other.user_agent, "server-supplied-agent");
    }
    #[tokio::test]
    async fn v3_provisioning_relays_machine_material_and_requires_all_steps() {
        use axum::{
            Router,
            body::Bytes,
            http::{HeaderMap, Uri},
            routing::post,
        };
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        use tokio_tungstenite::tungstenite::protocol::Role;
        let calls = Arc::new(AtomicUsize::new(0));
        let recorded = calls.clone();
        let app = Router::new().fallback(post(move |uri: Uri, headers: HeaderMap, body: Bytes| {
            let calls = recorded.clone();
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                assert_eq!(headers["x-mme-device-id"], "00000000-0000-0000-0000-000000000000");
                assert!(!headers.contains_key("authorization"));
                let parsed: Value = plist::from_bytes(&body).unwrap();
                let response = match uri.path() {
                    "/start" => {
                        assert_eq!(parsed, json!({"Header": {}, "Request": {}}));
                        json!({"spim": STANDARD.encode(b"synthetic-spim")})
                    }
                    "/finish" => {
                        assert_eq!(parsed, json!({"Header": {}, "Request": {"cpim": STANDARD.encode(b"synthetic-cpim")}}));
                        json!({"ptm": "synthetic-ptm", "tk": "synthetic-tk"})
                    }
                    _ => panic!("unexpected Apple provisioning request"),
                };
                let mut body = Vec::new();
                plist::to_writer_xml(&mut body, &json!({"Response": response})).unwrap();
                body
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let http = tokio::spawn(async { axum::serve(listener, app).await.unwrap() });
        let metadata = ClientInfo {
            client_info: "synthetic-client".into(),
            user_agent: "synthetic-agent".into(),
        };
        for outcome in ["success", "early-close", "out-of-order"] {
            let (a, b) = tokio::io::duplex(LIMIT);
            let ws = WebSocketStream::from_raw_socket(a, Role::Client, None).await;
            let mut peer = WebSocketStream::from_raw_socket(b, Role::Server, None).await;
            let remote = tokio::spawn(async move {
                if outcome == "out-of-order" {
                    peer.send(Message::Text(json!({"result":"ProvisioningSuccess", "adi_pb":STANDARD.encode(b"synthetic-blob")}).to_string().into())).await.unwrap();
                    return;
                }
                for (request, reply) in [
                    (
                        json!({"result":"GiveIdentifier"}),
                        json!({"identifier":STANDARD.encode([0;16])}),
                    ),
                    (
                        json!({"result":"GiveStartProvisioningData"}),
                        json!({"spim":STANDARD.encode(b"synthetic-spim")}),
                    ),
                    (
                        json!({"result":"GiveEndProvisioningData", "cpim":STANDARD.encode(b"synthetic-cpim")}),
                        json!({"ptm":"synthetic-ptm", "tk":"synthetic-tk"}),
                    ),
                ] {
                    peer.send(Message::Text(request.to_string().into()))
                        .await
                        .unwrap();
                    let actual: Value = serde_json::from_str(
                        peer.next().await.unwrap().unwrap().to_text().unwrap(),
                    )
                    .unwrap();
                    assert_eq!(actual, reply);
                }
                if outcome == "success" {
                    peer.send(Message::Text(json!({"result":"ProvisioningSuccess", "adi_pb":STANDARD.encode(b"synthetic-blob")}).to_string().into())).await.unwrap();
                } else {
                    peer.close(None).await.unwrap();
                }
            });
            let mut machine = Machine {
                identifier: [0; 16],
                adi_pb: None,
            };
            let result = provision_session(
                ws,
                &http_client().unwrap(),
                &metadata,
                &mut machine,
                Url::parse(&format!("{base}/start")).unwrap(),
                Url::parse(&format!("{base}/finish")).unwrap(),
            )
            .await;
            assert_eq!(result.is_ok(), outcome == "success");
            assert_eq!(machine.adi_pb.is_some(), outcome == "success");
            remote.await.unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        http.abort();
    }
    #[test]
    fn machine_identity_is_stable_private_and_not_an_account() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("machine.json");
        let mut machine = Machine {
            identifier: [0; 16],
            adi_pb: Some(STANDARD.encode(b"synthetic-blob")),
        };
        assert_eq!(
            machine.md_lu(),
            "374708fff7719dd5979ec875d56cd2286f6d3cf7ec317a3b25632aab28ec37bb"
        );
        assert_eq!(machine.device_id(), "00000000-0000-0000-0000-000000000000");
        machine.save(&path).unwrap();
        let loaded = Machine::load(&path).unwrap();
        assert_eq!(loaded.identifier, machine.identifier);
        assert_eq!(loaded.adi_pb, machine.adi_pb);
        machine.adi_pb = None;
        machine.save(&path).unwrap();
        assert!(Machine::load(&path).unwrap().adi_pb.is_none());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::write(&path, br#"{"identifier":[0],"adi_pb":null}"#).unwrap();
        assert!(Machine::load(&path).is_err());
    }
    #[test]
    fn provisioning_material_is_bounded_and_apple_destinations_are_fixed() {
        assert!(
            apple_url("https://gsa.apple.com/grandslam/MidService/startMachineProvisioning")
                .is_ok()
        );
        for url in [
            "http://gsa.apple.com/start",
            "https://gsa.apple.com.evil.test/start",
            "https://user@gsa.apple.com/start",
            "https://127.0.0.1/start",
            "https://gsa.apple.com:8443/start",
        ] {
            assert!(apple_url(url).is_err());
        }
        for blob in ["", "not base64", &"A".repeat(LIMIT)] {
            assert!(validate_blob(blob).is_err());
        }
    }
}
