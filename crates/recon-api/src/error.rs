//! API errors. Bodies never carry SQL, stack traces, other tenants' identifiers or PII (Rules R-API-5), and never
//! reflect request input: every message is a fixed string chosen by the server (R-API-9).

use axum::Json;
use axum::http::{HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use recon_store::StoreError;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub retry_after_secs: Option<u32>,
    /// Additional response headers (the `RateLimit-*` set on 429).
    pub extra_headers: Vec<(HeaderName, HeaderValue)>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            retry_after_secs: None,
            extra_headers: Vec::new(),
        }
    }
    /// 429 with `Retry-After` and the `RateLimit-Limit/Remaining/Reset` headers
    /// (draft-ietf-httpapi-ratelimit-headers): the client may retry after `retry_after_secs`.
    pub fn rate_limited(limit: u32, retry_after_secs: u32) -> Self {
        let mut e = Self::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "too many requests; retry after the interval in Retry-After",
        );
        e.retry_after_secs = Some(retry_after_secs);
        e.extra_headers = vec![
            (HeaderName::from_static("ratelimit-limit"), HeaderValue::from(limit)),
            (HeaderName::from_static("ratelimit-remaining"), HeaderValue::from(0u32)),
            (HeaderName::from_static("ratelimit-reset"), HeaderValue::from(retry_after_secs)),
        ];
        e
    }
    /// 503 when a bounded resource (Argon2 verifications, nonce cache) is saturated.
    pub fn busy() -> Self {
        let mut e = Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "busy",
            "the service is saturated; retry shortly",
        );
        e.retry_after_secs = Some(1);
        e
    }
    pub fn payload_too_large() -> Self {
        Self::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            "request body exceeds the size limit of this endpoint",
        )
    }
    pub fn unsupported_media_type() -> Self {
        Self::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            "Content-Type must be application/json",
        )
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
                extra_headers: Vec::new(),
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
        for (name, value) in self.extra_headers {
            res.headers_mut().insert(name, value);
        }
        res
    }
}
