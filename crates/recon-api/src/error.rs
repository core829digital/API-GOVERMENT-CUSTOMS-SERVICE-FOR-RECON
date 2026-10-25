//! API errors. Bodies never carry SQL, stack traces, other tenants' identifiers or PII (Rules R-API-5).

use axum::Json;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use recon_store::StoreError;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub retry_after_secs: Option<u32>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            retry_after_secs: None,
        }
    }
    pub fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }
    pub fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or invalid credentials",
        )
    }
    pub fn forbidden(scope: &str) -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            format!("credential lacks scope `{scope}`"),
        )
    }
    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", "resource not found")
    }
    pub fn internal() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal error",
        )
    }
}

impl From<StoreError> for ApiError {
    fn from(e: StoreError) -> Self {
        match e {
            // R has not applied the client's X-Min-Seq within the bridge wait: never fall back to W (R-DB-5).
            StoreError::ReplicaLag { .. } => Self {
                status: StatusCode::SERVICE_UNAVAILABLE,
                code: "replica_lag",
                message: "read replica has not yet applied your write; retry".into(),
                retry_after_secs: Some(1),
            },
            other => {
                eprintln!("internal store error: {other}");
                Self::internal()
            }
        }
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        eprintln!("internal database error: {e}");
        Self::internal()
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = serde_json::json!({"error": {"code": self.code, "message": self.message}});
        let mut res = (self.status, Json(body)).into_response();
        if let Some(s) = self.retry_after_secs {
            res.headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from(s));
        }
        res
    }
}
