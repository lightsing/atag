use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AgentError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub AgentError);

impl ApiError {
    pub fn new(status: StatusCode, code: &str, message: &str, retryable: bool) -> Self {
        Self(
            status,
            AgentError {
                code: code.into(),
                message: message.into(),
                retryable,
            },
        )
    }
    pub fn invalid(message: &str) -> Self {
        Self::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_REQUEST",
            message,
            false,
        )
    }
    pub fn not_found() -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "NOT_FOUND",
            "找不到请求的接口。",
            false,
        )
    }
    pub fn internal() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL_ERROR",
            "本地 agent 无法完成操作。",
            false,
        )
    }
    pub fn upstream() -> Self {
        Self::new(
            StatusCode::BAD_GATEWAY,
            "UPSTREAM_UNAVAILABLE",
            "无法访问 Apple 上游服务，请稍后重试。",
            true,
        )
    }
    pub fn timeout() -> Self {
        Self::timeout_for("Apple 请求")
    }
    pub(crate) fn timeout_for(operation: &str) -> Self {
        Self::new(
            StatusCode::GATEWAY_TIMEOUT,
            "TIMEOUT",
            &format!("{operation}超时。"),
            true,
        )
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.1.code, self.1.message)
    }
}
impl std::error::Error for ApiError {}
impl From<std::io::Error> for ApiError {
    fn from(_: std::io::Error) -> Self {
        Self::internal()
    }
}
impl From<serde_json::Error> for ApiError {
    fn from(_: serde_json::Error) -> Self {
        Self::internal()
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({ "error": self.1 }))).into_response()
    }
}
