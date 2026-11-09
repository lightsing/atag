//! Fixed-destination Apple HTTP relay. No login state, password processing, SRP,
//! challenge store, token exchange logic or response interpretation lives here.
use crate::{
    anisette::{apple_http_client, bounded_body, network_error},
    error::ApiError,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{
    Client, Method,
    header::{HeaderMap, HeaderName, HeaderValue},
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, time::Duration};

pub(crate) const APPLE_AUTH_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppleEndpoint {
    Gsa,
    Mobileme,
    Methods,
    SmsRequest,
    SmsSubmit,
    TrustedRequest,
    TrustedSubmit,
    Findmy,
}
impl AppleEndpoint {
    fn target(self) -> (&'static str, Method) {
        match self {
            Self::Gsa => ("https://gsa.apple.com/grandslam/GsService2", Method::POST),
            Self::Mobileme => (
                "https://setup.icloud.com/setup/iosbuddy/loginDelegates",
                Method::POST,
            ),
            Self::Methods => ("https://gsa.apple.com/auth", Method::GET),
            Self::SmsRequest => ("https://gsa.apple.com/auth/verify/phone", Method::PUT),
            Self::SmsSubmit => (
                "https://gsa.apple.com/auth/verify/phone/securitycode",
                Method::POST,
            ),
            Self::TrustedRequest => (
                "https://gsa.apple.com/auth/verify/trusteddevice",
                Method::GET,
            ),
            Self::TrustedSubmit => (
                "https://gsa.apple.com/grandslam/GsService2/validate",
                Method::GET,
            ),
            Self::Findmy => (
                "https://gateway.icloud.com/findmyservice/v2/fetch",
                Method::POST,
            ),
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppleRequest {
    pub endpoint: AppleEndpoint,
    pub method: String,
    pub headers: BTreeMap<String, String>,
    pub body_base64: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppleResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body_base64: String,
}
impl AppleRequest {
    pub fn validate(&self) -> Result<(Method, HeaderMap, Vec<u8>), ApiError> {
        let expected = self.endpoint.target().1;
        if self.method != expected.as_str() || self.headers.len() > 64 {
            return Err(ApiError::invalid("Apple 转发方法或请求头无效。"));
        }
        let mut headers = HeaderMap::new();
        for (name, value) in &self.headers {
            let lower = name.to_ascii_lowercase();
            let allowed = matches!(
                lower.as_str(),
                "authorization"
                    | "user-agent"
                    | "accept"
                    | "accept-language"
                    | "loc"
                    | "content-type"
                    | "x-mme-client-info"
                    | "x-mme-device-id"
                    | "security-code"
            ) || lower.starts_with("x-apple-");
            if !allowed || name.len() > 100 || value.len() > 8192 {
                return Err(ApiError::invalid("Apple 转发请求头不被允许。"));
            }
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| ApiError::invalid("请求头无效。"))?;
            let value =
                HeaderValue::from_str(value).map_err(|_| ApiError::invalid("请求头无效。"))?;
            if headers.insert(name, value).is_some() {
                return Err(ApiError::invalid("请求头重复。"));
            }
        }
        let body = match &self.body_base64 {
            Some(encoded) if encoded.len() <= 65536 => STANDARD
                .decode(encoded)
                .map_err(|_| ApiError::invalid("请求内容编码无效。"))?,
            Some(_) => return Err(ApiError::invalid("请求过大。")),
            None => Vec::new(),
        };
        if expected == Method::GET && !body.is_empty()
            || expected != Method::GET && self.body_base64.is_none()
        {
            return Err(ApiError::invalid("请求内容与方法不匹配。"));
        }
        Ok((expected, headers, body))
    }
}
#[derive(Clone)]
pub struct AppleRelay {
    client: Client,
}
impl AppleRelay {
    pub fn new() -> Result<Self, ApiError> {
        Ok(Self {
            client: apple_http_client()?,
        })
    }
    pub async fn forward(&self, request: AppleRequest) -> Result<AppleResponse, ApiError> {
        let url = request.endpoint.target().0;
        self.send(url, request).await
    }
    async fn send(&self, url: &str, request: AppleRequest) -> Result<AppleResponse, ApiError> {
        let (method, headers, body) = request.validate()?;
        let upstream = self.client.request(method, url).headers(headers).body(body);
        // All authentication steps, including method discovery and delegate
        // authorization, share a budget below the bridge/browser deadlines.
        // Do not replay password proofs or verification requests on timeout.
        let upstream = if matches!(request.endpoint, AppleEndpoint::Findmy) {
            upstream
        } else {
            upstream.timeout(APPLE_AUTH_TIMEOUT)
        };
        let response = upstream.send().await.map_err(|error| {
            let stage = if error.is_connect() {
                "connecting"
            } else {
                "waiting for response headers"
            };
            relay_failure(request.endpoint, stage, network_error(error))
        })?;
        let status = response.status().as_u16();
        if !response.status().is_success() {
            // Endpoint names and status codes are public transport metadata.
            // Never log account headers, request bodies or Apple response bodies.
            eprintln!(
                "atag-agent: Apple {:?} returned HTTP {status}",
                request.endpoint
            );
        }
        let headers = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(|v| BTreeMap::from([("content-type".into(), v.into())]))
            .unwrap_or_default();
        let bytes = bounded_body(response, 8 * 1024 * 1024)
            .await
            .map_err(|error| relay_failure(request.endpoint, "reading response body", error))?;
        Ok(AppleResponse {
            status,
            headers,
            body_base64: STANDARD.encode(bytes),
        })
    }
}

fn relay_failure(endpoint: AppleEndpoint, stage: &str, error: ApiError) -> ApiError {
    eprintln!(
        "atag-agent: Apple {endpoint:?} failed while {stage} (HTTP {}, {})",
        error.0.as_u16(),
        error.1.code
    );
    error
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Bytes, routing::post};

    #[tokio::test]
    async fn apple_requests_do_not_reuse_stalled_keepalive_connections() {
        use axum::extract::ConnectInfo;
        use std::{
            collections::HashSet,
            net::SocketAddr,
            sync::{Arc, Mutex},
        };

        let connections = Arc::new(Mutex::new(HashSet::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let app = Router::new().route(
            "/",
            post({
                let connections = connections.clone();
                move |ConnectInfo(peer): ConnectInfo<SocketAddr>, body: Bytes| {
                    let connections = connections.clone();
                    async move {
                        let fresh = connections.lock().unwrap().insert(peer);
                        // Reproduce an Apple edge that advertises keep-alive but
                        // never answers a subsequent request on the same socket.
                        if !fresh {
                            std::future::pending::<()>().await;
                        }
                        body
                    }
                }
            }),
        );
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        let relay = AppleRelay::new().unwrap();
        let result = tokio::time::timeout(Duration::from_secs(2), async {
            for body in ["opaque-init", "opaque-complete"] {
                let response = relay
                    .send(
                        &url,
                        AppleRequest {
                            endpoint: AppleEndpoint::Gsa,
                            method: "POST".into(),
                            headers: BTreeMap::new(),
                            body_base64: Some(STANDARD.encode(body)),
                        },
                    )
                    .await?;
                assert_eq!(response.status, 200);
                assert_eq!(
                    STANDARD.decode(response.body_base64).unwrap(),
                    body.as_bytes()
                );
            }
            Ok::<_, ApiError>(())
        })
        .await;
        server.abort();
        result
            .expect("the second Apple request reused a stalled connection")
            .unwrap();
        assert_eq!(connections.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn authentication_waits_for_slow_apple_responses_without_resubmitting() {
        for (endpoint, seconds) in [
            (AppleEndpoint::Gsa, 45),
            (AppleEndpoint::Methods, 30),
            (AppleEndpoint::Mobileme, 30),
        ] {
            let received = std::sync::Arc::new(tokio::sync::Notify::new());
            let release = std::sync::Arc::new(tokio::sync::Notify::new());
            let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/", listener.local_addr().unwrap());
            let app = Router::new().route(
                "/",
                axum::routing::any({
                    let received = received.clone();
                    let release = release.clone();
                    let calls = calls.clone();
                    move || {
                        let received = received.clone();
                        let release = release.clone();
                        let calls = calls.clone();
                        async move {
                            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            received.notify_one();
                            release.notified().await;
                            "synthetic-response"
                        }
                    }
                }),
            );
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let pending = tokio::spawn(async move {
                let method = endpoint.target().1;
                AppleRelay::new()
                    .unwrap()
                    .send(
                        &url,
                        AppleRequest {
                            endpoint,
                            method: method.to_string(),
                            headers: BTreeMap::new(),
                            body_base64: (method != Method::GET).then(String::new),
                        },
                    )
                    .await
            });
            received.notified().await;
            tokio::time::pause();
            tokio::time::advance(Duration::from_secs(seconds)).await;
            tokio::task::yield_now().await;
            tokio::time::resume();
            release.notify_one();
            let response = pending.await.unwrap();
            server.abort();
            assert_eq!(response.unwrap().status, 200, "{endpoint:?}");
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        }
    }
    #[test]
    fn endpoints_and_methods_are_fixed_and_extra_fields_are_rejected() {
        let input =
            serde_json::json!({"endpoint":"gsa","method":"POST","headers":{},"bodyBase64":""});
        let request: AppleRequest = serde_json::from_value(input.clone()).unwrap();
        request.validate().unwrap();
        let findmy: AppleRequest = serde_json::from_value(serde_json::json!({
            "endpoint":"findmy","method":"POST","headers":{},"bodyBase64":""
        }))
        .unwrap();
        findmy.validate().unwrap();
        assert_eq!(
            findmy.endpoint.target(),
            (
                "https://gateway.icloud.com/findmyservice/v2/fetch",
                Method::POST
            )
        );
        let mut arbitrary = input.clone();
        arbitrary["url"] = serde_json::json!("http://127.0.0.1:1");
        assert!(serde_json::from_value::<AppleRequest>(arbitrary).is_err());
        let mut password = input.clone();
        password["password"] = serde_json::json!("forbidden");
        assert!(serde_json::from_value::<AppleRequest>(password).is_err());
        let mut invalid = input.clone();
        invalid["headers"] = serde_json::json!({"Host":"attacker.example"});
        assert!(
            serde_json::from_value::<AppleRequest>(invalid)
                .unwrap()
                .validate()
                .is_err()
        );
        let mut invalid = input;
        invalid["method"] = serde_json::json!("DELETE");
        assert!(
            serde_json::from_value::<AppleRequest>(invalid)
                .unwrap()
                .validate()
                .is_err()
        );
    }
    #[tokio::test]
    async fn relay_is_a_byte_transport_and_does_not_interpret_apple_errors_or_forward_cookies() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().route(
            "/",
            post(|headers: axum::http::HeaderMap, body: Bytes| async move {
                assert_eq!(headers["x-apple-identity-token"], "synthetic");
                assert_eq!(headers["loc"], "en_US");
                assert_eq!(&body[..], b"opaque-request");
                (
                    axum::http::StatusCode::UNAUTHORIZED,
                    [
                        ("content-type", "text/x-xml-plist"),
                        ("set-cookie", "must-not-forward=secret"),
                    ],
                    "opaque-response",
                )
            }),
        );
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let response = AppleRelay::new()
            .unwrap()
            .send(
                &format!("http://{address}/"),
                AppleRequest {
                    endpoint: AppleEndpoint::Gsa,
                    method: "POST".into(),
                    headers: BTreeMap::from([
                        ("x-apple-identity-token".into(), "synthetic".into()),
                        ("loc".into(), "en_US".into()),
                    ]),
                    body_base64: Some(STANDARD.encode("opaque-request")),
                },
            )
            .await
            .unwrap();
        assert_eq!(response.status, 401);
        assert_eq!(
            STANDARD.decode(response.body_base64).unwrap(),
            b"opaque-response"
        );
        assert_eq!(response.headers.len(), 1);
        task.abort();
    }
}
