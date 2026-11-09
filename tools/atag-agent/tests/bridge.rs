use atag_agent::bridge::{ApiConfig, Bridge};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::json;
use tower::ServiceExt;
fn bridge() -> Bridge {
    Bridge::new(ApiConfig {
        address: "127.0.0.1:18432".parse().unwrap(),
        allowed_origins: vec!["https://tags.example.test".into()],
    })
    .unwrap()
}
async fn call(
    path: &str,
    origin: &str,
    body: Option<serde_json::Value>,
) -> axum::response::Response {
    let request = Request::builder()
        .uri(path)
        .header("Host", "127.0.0.1:18432")
        .header("Origin", origin);
    let request = if let Some(body) = body {
        request
            .method("POST")
            .header("Content-Type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    } else {
        request.body(Body::empty()).unwrap()
    };
    bridge().router().oneshot(request).await.unwrap()
}
#[tokio::test]
async fn omitted_anisette_source_uses_coreadi_without_falling_back_to_another_machine() {
    let directory = tempfile::tempdir().unwrap();
    let bridge = Bridge::with_directory(
        ApiConfig {
            address: "127.0.0.1:18432".parse().unwrap(),
            allowed_origins: vec!["https://tags.example.test".into()],
        },
        directory.path().to_path_buf(),
    )
    .unwrap();
    let response = bridge
        .router()
        .oneshot(
            Request::post("/v1/anisette")
                .header("Host", "127.0.0.1:18432")
                .header("Origin", "https://tags.example.test")
                .header("Content-Type", "application/json")
                .body(Body::from(
                    json!({"uid":"test","deviceId":"test"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("install-mac-coreadi")
    );
    assert!(body.get("headers").is_none());
}
#[tokio::test]
async fn bridge_connects_without_credentials_and_requires_exact_origin() {
    let response = call("/v1/health", "https://tags.example.test", None).await;
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["Cache-Control"], "no-store");
    let health: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(health["protocolVersion"], 1);
    assert_eq!(health["agentVersion"], env!("CARGO_PKG_VERSION"));
    assert_eq!(health["storage"], "none");
    assert!(health.get("account").is_none());
    assert!(health.get("requiresAuthorization").is_none());
    assert_eq!(health["capabilities"]["anisette"], true);
    assert_eq!(health["capabilities"]["appleRelay"], true);
    for version in [0, 2, 3] {
        for (route, body) in [
            ("health", None),
            ("anisette", Some(json!({}))),
            ("apple/request", Some(json!({}))),
        ] {
            assert_eq!(
                call(
                    &format!("/v{version}/{route}"),
                    "https://tags.example.test",
                    body
                )
                .await
                .status(),
                StatusCode::NOT_FOUND
            );
        }
    }
    assert_eq!(
        call("/v1/health", "https://evil.example.test", None)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    for path in [
        "/v1/authorize",
        "/v1/devices",
        "/v1/auth/state",
        "/v1/provisioning/bundles",
        "/v1/operations/x",
    ] {
        assert_eq!(
            call(path, "https://tags.example.test", None).await.status(),
            StatusCode::NOT_FOUND
        );
    }
}
#[tokio::test]
async fn bridge_rejects_user_state_and_arbitrary_targets_before_any_upstream_request() {
    for body in [
        json!({"endpoint":"gsa","method":"POST","headers":{},"bodyBase64":"","password":"forbidden"}),
        json!({"endpoint":"http://evil.test/","method":"POST","headers":{},"bodyBase64":""}),
        json!({"endpoint":"gsa","method":"DELETE","headers":{},"bodyBase64":""}),
        json!({"endpoint":"gsa","method":"POST","headers":{"Host":"evil.test"},"bodyBase64":""}),
    ] {
        assert_eq!(
            call("/v1/apple/request", "https://tags.example.test", Some(body))
                .await
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    assert_eq!(
        call(
            "/v1/anisette",
            "https://tags.example.test",
            Some(json!({"uid":"u","deviceId":"d","account":"forbidden"}))
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    for path in ["/v1/findmy/fetch", "/v1/auth/login", "/v1/auth/code"] {
        assert_eq!(
            call(path, "https://tags.example.test", None).await.status(),
            StatusCode::NOT_FOUND
        );
    }
}

#[tokio::test]
async fn bridge_checks_host_and_origin_on_posts_without_credentials() {
    for (host, origin, expected) in [
        (
            "127.0.0.1:18432",
            "https://tags.example.test",
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            "localhost:18432",
            "https://tags.example.test",
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            "evil.example.test:18432",
            "https://tags.example.test",
            StatusCode::FORBIDDEN,
        ),
        (
            "127.0.0.1:18432",
            "https://evil.example.test",
            StatusCode::FORBIDDEN,
        ),
    ] {
        let request = Request::builder()
            .method("POST")
            .uri("/v1/apple/request")
            .header("Host", host)
            .header("Origin", origin)
            .header("Content-Type", "application/json")
            .body(Body::from("{}"))
            .unwrap();
        assert_eq!(
            bridge().router().oneshot(request).await.unwrap().status(),
            expected
        );
    }
}

#[tokio::test]
async fn preflight_allows_json_requests_from_the_configured_origin() {
    for (origin, requested_headers, expected) in [
        (
            "https://tags.example.test",
            "Content-Type, Accept",
            StatusCode::NO_CONTENT,
        ),
        (
            "https://evil.example.test",
            "Content-Type",
            StatusCode::FORBIDDEN,
        ),
        (
            "https://tags.example.test",
            "Authorization",
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
    ] {
        let request = Request::builder()
            .method("OPTIONS")
            .uri("/v1/apple/request")
            .header("Host", "127.0.0.1:18432")
            .header("Origin", origin)
            .header("Access-Control-Request-Method", "POST")
            .header("Access-Control-Request-Headers", requested_headers)
            .header("Access-Control-Request-Private-Network", "true")
            .body(Body::empty())
            .unwrap();
        let response = bridge().router().oneshot(request).await.unwrap();
        assert_eq!(response.status(), expected);
        assert_eq!(response.headers()["Cache-Control"], "no-store");
        if expected == StatusCode::NO_CONTENT {
            assert_eq!(response.headers()["Access-Control-Allow-Origin"], origin);
            assert_eq!(
                response.headers()["Access-Control-Allow-Headers"],
                "Content-Type, Accept"
            );
            assert_eq!(
                response.headers()["Access-Control-Allow-Private-Network"],
                "true"
            );
        }
    }
}
