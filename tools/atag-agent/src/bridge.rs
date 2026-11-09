//! User-agnostic v1 loopback bridge. Only transport configuration is retained.
use crate::{
    anisette::{AnisetteProvider, ClientProfile, local::WORKER_TIMEOUT},
    default_data_dir,
    error::ApiError,
    relay::{APPLE_AUTH_TIMEOUT, AppleRelay, AppleRequest, AppleResponse},
};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Request, State, rejection::JsonRejection},
    http::{HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::json;
use std::{net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::Semaphore;

pub struct ApiConfig {
    pub address: SocketAddr,
    pub allowed_origins: Vec<String>,
}

#[derive(Clone)]
pub struct Bridge {
    config: Arc<ApiConfig>,
    workers: Arc<Semaphore>,
    directory: Arc<PathBuf>,
    relay: AppleRelay,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AnisetteRequest {
    #[serde(default)]
    source: String,
    uid: String,
    device_id: String,
    #[serde(default)]
    client_profile: ClientProfile,
}
impl Bridge {
    pub fn new(config: ApiConfig) -> Result<Self, ApiError> {
        let directory = default_data_dir().ok_or_else(ApiError::internal)?;
        Self::with_directory(config, directory)
    }
    pub fn with_directory(config: ApiConfig, directory: PathBuf) -> Result<Self, ApiError> {
        if !config.address.ip().is_loopback() {
            return Err(ApiError::invalid("只允许 loopback 地址。"));
        }
        for origin in &config.allowed_origins {
            let url =
                reqwest::Url::parse(origin).map_err(|_| ApiError::invalid("Origin 无效。"))?;
            if !matches!(url.scheme(), "http" | "https")
                || url.origin().ascii_serialization() != *origin
            {
                return Err(ApiError::invalid(
                    "Origin 必须精确匹配，不能包含路径或通配符。",
                ));
            }
        }
        Ok(Self {
            config: Arc::new(config),
            workers: Arc::new(Semaphore::new(2)),
            directory: Arc::new(directory),
            relay: AppleRelay::new()?,
        })
    }
    pub fn router(&self) -> Router {
        Router::new().route("/v1/health",get(||async{Json(json!({"service":"atag-agent","protocolVersion":1,"agentVersion":env!("CARGO_PKG_VERSION"),"capabilities":{"anisette":true,"appleRelay":true},"storage":"none"}))}))
            .route("/v1/anisette",post(anisette))
            .route("/v1/apple/request",post(forward))
            .fallback(||async{ApiError::not_found()})
            .layer(DefaultBodyLimit::max(64*1024))
            .layer(middleware::from_fn_with_state(self.clone(),security)).with_state(self.clone())
    }
}
async fn anisette(
    State(bridge): State<Bridge>,
    input: Result<Json<AnisetteRequest>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let Json(request) = input.map_err(|_| ApiError::invalid("Anisette 请求格式无效。"))?;
    for value in [&request.uid, &request.device_id] {
        if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
            return Err(ApiError::invalid("客户端标识无效。"));
        }
    }
    let _permit = bridge.workers.try_acquire().map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "UPSTREAM_UNAVAILABLE",
            "本地桥接正忙。",
            true,
        )
    })?;
    let provider = AnisetteProvider::for_directory(&request.source, &bridge.directory)?;
    let value = provider
        .headers(&request.uid, &request.device_id, request.client_profile)
        .await
        .inspect_err(|error| {
            eprintln!(
                "atag-agent: Anisette failed (HTTP {}, {})",
                error.0.as_u16(),
                error.1.code
            );
        })?;
    let mut headers = std::collections::BTreeMap::new();
    for (name, value) in &value.headers {
        headers.insert(
            name.as_str().to_owned(),
            value.to_str().map_err(|_| ApiError::internal())?.to_owned(),
        );
    }
    Ok(Json(
        json!({"headers":headers,"clientInfo":value.client_info,"userAgent":value.user_agent}),
    ))
}
async fn forward(
    State(bridge): State<Bridge>,
    input: Result<Json<AppleRequest>, JsonRejection>,
) -> Result<Json<AppleResponse>, ApiError> {
    let Json(request) = input.map_err(|_| ApiError::invalid("Apple 转发请求格式无效。"))?;
    request.validate()?;
    let _permit = bridge.workers.try_acquire().map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "UPSTREAM_UNAVAILABLE",
            "本地桥接正忙。",
            true,
        )
    })?;
    Ok(Json(bridge.relay.forward(request).await?))
}
async fn security(State(bridge): State<Bridge>, request: Request, next: Next) -> Response {
    let origin = request.headers().get(header::ORIGIN).cloned();
    let allowed = origin.as_ref().is_some_and(|o| {
        bridge
            .config
            .allowed_origins
            .iter()
            .any(|s| o.as_bytes() == s.as_bytes())
    });
    let mut response = match check(&bridge, &request, allowed) {
        Err(error) => error.into_response(),
        Ok(()) if request.method() == Method::OPTIONS => {
            let mut response = StatusCode::NO_CONTENT.into_response();
            let h = response.headers_mut();
            h.insert(
                header::ACCESS_CONTROL_ALLOW_METHODS,
                HeaderValue::from_static("GET, POST, OPTIONS"),
            );
            h.insert(
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                HeaderValue::from_static("Content-Type, Accept"),
            );
            if request
                .headers()
                .get("access-control-request-private-network")
                .is_some_and(|v| v == "true")
            {
                h.insert(
                    "access-control-allow-private-network",
                    HeaderValue::from_static("true"),
                );
            }
            response
        }
        Ok(()) => {
            // The outer deadline must allow each provider to finish (or report
            // its own timeout). Local provisioning can download its runtime.
            let (limit, operation) = match request.uri().path() {
                "/v1/anisette" => (
                    WORKER_TIMEOUT + Duration::from_secs(5),
                    "本地机器认证（Anisette）",
                ),
                "/v1/apple/request" => (
                    APPLE_AUTH_TIMEOUT + Duration::from_secs(5),
                    "Apple 请求转发",
                ),
                _ => (Duration::from_secs(50), "本地桥接请求"),
            };
            tokio::time::timeout(limit, next.run(request))
                .await
                .unwrap_or_else(|_| {
                    eprintln!(
                        "atag-agent: {operation} exceeded HTTP deadline ({}s)",
                        limit.as_secs()
                    );
                    ApiError::timeout_for(operation).into_response()
                })
        }
    };
    let h = response.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        header::VARY,
        HeaderValue::from_static(
            "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
        ),
    );
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    if allowed {
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.unwrap());
    }
    response
}
fn check(bridge: &Bridge, request: &Request<Body>, allowed: bool) -> Result<(), ApiError> {
    let denied = || {
        ApiError::new(
            StatusCode::FORBIDDEN,
            "UNAUTHORIZED",
            "请求来源或主机不被允许。",
            false,
        )
    };
    let headers = request.headers();
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .ok_or_else(denied)?;
    if headers.get_all(header::HOST).iter().count() != 1
        || (host != bridge.config.address.to_string()
            && host != format!("localhost:{}", bridge.config.address.port()))
    {
        return Err(denied());
    }
    if headers.get_all(header::ORIGIN).iter().count() > 1
        || (headers.contains_key(header::ORIGIN) && !allowed)
    {
        return Err(denied());
    }
    if request.method() == Method::OPTIONS {
        if !allowed {
            return Err(denied());
        }
        let method = headers
            .get(header::ACCESS_CONTROL_REQUEST_METHOD)
            .and_then(|s| s.to_str().ok())
            .unwrap_or("");
        if !matches!(method, "GET" | "POST") {
            return Err(ApiError::invalid("预检方法无效。"));
        }
        if let Some(requested) = headers.get(header::ACCESS_CONTROL_REQUEST_HEADERS) {
            if requested.to_str().map_or(true, |s| {
                s.split(',').any(|h| {
                    !matches!(
                        h.trim().to_ascii_lowercase().as_str(),
                        "content-type" | "accept"
                    )
                })
            }) {
                return Err(ApiError::invalid("预检头无效。"));
            }
        }
        return Ok(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use tower::ServiceExt;

    fn test_bridge(directory: &std::path::Path) -> Bridge {
        Bridge::with_directory(
            ApiConfig {
                address: "127.0.0.1:18432".parse().unwrap(),
                allowed_origins: vec!["https://tags.example.test".into()],
            },
            directory.to_path_buf(),
        )
        .unwrap()
    }

    fn request(path: &str) -> Request {
        Request::post(path)
            .header(header::HOST, "127.0.0.1:18432")
            .header(header::ORIGIN, "https://tags.example.test")
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn slow_initialization_and_apple_replies_survive_the_old_outer_deadline() {
        let directory = tempfile::tempdir().unwrap();
        let bridge = test_bridge(directory.path());
        for (path, seconds) in [("/v1/anisette", 60), ("/v1/apple/request", 61)] {
            let app = Router::new()
                .route(
                    path,
                    post(move || async move {
                        tokio::time::sleep(Duration::from_secs(seconds)).await;
                        StatusCode::OK
                    }),
                )
                .layer(middleware::from_fn_with_state(bridge.clone(), security));
            let response = app.oneshot(request(path)).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(
                response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
                "https://tags.example.test"
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_requests_still_expire_with_cors_and_a_stage_specific_error() {
        let directory = tempfile::tempdir().unwrap();
        let bridge = test_bridge(directory.path());
        for (path, seconds, stage) in [
            ("/v1/anisette", 245, "Anisette"),
            ("/v1/apple/request", 65, "Apple"),
        ] {
            let app = Router::new()
                .route(path, post(std::future::pending::<StatusCode>))
                .layer(middleware::from_fn_with_state(bridge.clone(), security));
            let started = tokio::time::Instant::now();
            let response = app.oneshot(request(path)).await.unwrap();
            assert_eq!(started.elapsed(), Duration::from_secs(seconds), "{path}");
            assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(
                response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
                "https://tags.example.test"
            );
            let body: serde_json::Value =
                serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap())
                    .unwrap();
            assert_eq!(body["error"]["code"], "TIMEOUT");
            assert!(body["error"]["message"].as_str().unwrap().contains(stage));
        }
    }
}
