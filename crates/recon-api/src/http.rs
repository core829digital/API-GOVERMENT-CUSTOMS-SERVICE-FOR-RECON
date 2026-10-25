//! HTTP hardening shared by every route and both listeners: response headers, size limits, content-type checks,
//! client-IP resolution and the pre-authentication rate limit.
//!
//! Limits enforced here (all answered with the stable JSON error shape and no echo of the input):
//! * request line: URI at most [`MAX_URI_BYTES`] (414);
//! * headers: at most [`MAX_HEADER_COUNT`] fields, [`MAX_HEADER_VALUE_BYTES`] per value and
//!   [`MAX_HEADER_BYTES`] in total (431). hyper has already buffered the head by the time this runs and applies
//!   its own, larger cap first (about 400 KiB); these are the API's tighter limits;
//! * body: per route (see `lib.rs`), by `Content-Length` before authentication and by streaming count after (413);
//! * `Content-Type: application/json` on every JSON body (415).

use crate::error::ApiError;
use crate::guard::Guard;
use crate::net::{ClientIp, resolve_client_ip};
use axum::body::Bytes;
use axum::extract::{ConnectInfo, FromRequest, Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::net::SocketAddr;
use std::sync::Arc;

pub const MAX_URI_BYTES: usize = 4096;
pub const MAX_HEADER_COUNT: usize = 64;
pub const MAX_HEADER_VALUE_BYTES: usize = 4096;
pub const MAX_HEADER_BYTES: usize = 16 * 1024;

/// Headers on every response. The API returns JSON (or the fixed `ok` text of `/healthz`), never HTML, so the
/// policy forbids everything: a response that is somehow rendered by a browser can load and run nothing.
pub fn security_headers() -> [(HeaderName, HeaderValue); 5] {
    [
        (header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")),
        (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        (
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'"),
        ),
        (header::REFERRER_POLICY, HeaderValue::from_static("no-referrer")),
        (
            HeaderName::from_static("cross-origin-resource-policy"),
            HeaderValue::from_static("same-origin"),
        ),
    ]
}

/// Outermost middleware: add [`security_headers`] to every response, errors and rejections included, and make
/// sure a body-carrying response declares a type.
pub async fn add_security_headers(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let headers = res.headers_mut();
    for (name, value) in security_headers() {
        headers.insert(name, value);
    }
    res
}

/// Resolve [`ClientIp`] from the TCP peer (and `X-Forwarded-For` only from trusted proxies, see [`crate::net`]).
pub async fn client_ip(State(guard): State<Arc<Guard>>, mut req: Request, next: Next) -> Response {
    let peer = req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0);
    let xff: Vec<&str> = req
        .headers()
        .get_all(HeaderName::from_static("x-forwarded-for"))
        .iter()
        .filter_map(|v| v.to_str().ok())
        .collect();
    let ip = resolve_client_ip(peer, &xff, &guard.trusted_proxies);
    req.extensions_mut().insert(ClientIp(ip));
    next.run(req).await
}

/// Refuse oversized URIs and header blocks (414 / 431).
pub async fn limit_request_head(req: Request, next: Next) -> Response {
    if req.uri().path_and_query().map_or(0, |p| p.as_str().len()) > MAX_URI_BYTES {
        return ApiError::new(StatusCode::URI_TOO_LONG, "uri_too_long", "the request URI is too long").into_response();
    }
    let headers = req.headers();
    let total: usize = headers.iter().map(|(n, v)| n.as_str().len() + v.len()).sum();
    let too_big = headers.len() > MAX_HEADER_COUNT
        || total > MAX_HEADER_BYTES
        || headers.values().any(|v| v.len() > MAX_HEADER_VALUE_BYTES);
    if too_big {
        return ApiError::new(
            StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE,
            "headers_too_large",
            "the request headers are too large",
        )
        .into_response();
    }
    next.run(req).await
}

/// Public listener only: the per-client-IP bucket, taken before authentication and therefore before any Argon2.
pub async fn limit_ip(State(guard): State<Arc<Guard>>, req: Request, next: Next) -> Response {
    let ip = req.extensions().get::<ClientIp>().and_then(|c| c.0);
    match guard.check_ip(ip) {
        Ok(()) => next.run(req).await,
        Err(e) => e.into_response(),
    }
}

/// Per-route request rules, applied before authentication.
#[derive(Clone, Copy)]
pub struct RouteRules {
    /// Largest accepted body in bytes (0 = the route takes no body).
    pub body_limit: usize,
}

/// Exactly one `Content-Type`, `application/json`, optionally with `charset=utf-8`.
pub fn check_json_content_type(headers: &HeaderMap) -> Result<(), ApiError> {
    let mut it = headers.get_all(header::CONTENT_TYPE).iter();
    let (Some(v), None) = (it.next(), it.next()) else {
        return Err(ApiError::unsupported_media_type());
    };
    let ok = v.to_str().ok().is_some_and(|s| {
        let mut parts = s.split(';').map(str::trim);
        let essence = parts.next().unwrap_or("");
        essence.eq_ignore_ascii_case("application/json")
            && parts.all(|p| p.eq_ignore_ascii_case("charset=utf-8") || p.eq_ignore_ascii_case("charset=\"utf-8\""))
    });
    if ok { Ok(()) } else { Err(ApiError::unsupported_media_type()) }
}

/// Before authentication: no declared length above the route's limit (413), and a JSON content type on every
/// request that carries a body or is a POST to a body-taking route (415). Routes that take no body have limit 0.
pub async fn enforce_route_rules(State(rules): State<RouteRules>, req: Request, next: Next) -> Response {
    let declared = match req.headers().get(header::CONTENT_LENGTH) {
        None => None,
        Some(v) => match v.to_str().ok().and_then(|s| s.parse::<usize>().ok()) {
            Some(n) => Some(n),
            None => return ApiError::bad_request("invalid_content_length", "Content-Length is not a valid size").into_response(),
        },
    };
    if declared.is_some_and(|n| n > rules.body_limit) {
        return ApiError::payload_too_large().into_response();
    }
    let has_body = declared.is_some_and(|n| n > 0) || req.headers().contains_key(header::TRANSFER_ENCODING);
    if rules.body_limit > 0
        && (has_body || req.method() == Method::POST)
        && let Err(e) = check_json_content_type(req.headers())
    {
        return e.into_response();
    }
    next.run(req).await
}

/// Fallback for unknown paths.
pub async fn not_found() -> Response {
    ApiError::not_found().into_response()
}

/// Fallback for a known path with an unsupported method.
pub async fn method_not_allowed() -> Response {
    ApiError::new(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed", "method not allowed for this resource").into_response()
}

/// A request body buffered within the route's limit, whose `Content-Type` was checked. Parse it with
/// [`JsonBody::parse`]; authentication and scope checks run before that because extractors on the handler run in
/// order and this one is last.
pub struct JsonBody(Bytes);

/// A request-body type: strict (`#[serde(deny_unknown_fields)]`) with a fixed hint for the 400 message.
pub trait BodySchema: DeserializeOwned {
    const HINT: &'static str;
}

impl JsonBody {
    /// Parse into the typed struct (unknown, missing, duplicate or mistyped fields are refused) and also return the
    /// generic JSON value that idempotency hashes. The error never contains parser output, which could echo input.
    pub fn parse<T: BodySchema>(&self) -> Result<(T, Value), ApiError> {
        let typed: T = serde_json::from_slice(&self.0).map_err(|_| ApiError::bad_request("invalid_body", T::HINT))?;
        let raw: Value = serde_json::from_slice(&self.0)
            .map_err(|_| ApiError::bad_request("invalid_json", "request body must be a JSON object"))?;
        Ok((typed, raw))
    }
}

impl<S: Send + Sync> FromRequest<S> for JsonBody {
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, ApiError> {
        check_json_content_type(req.headers())?;
        let bytes = Bytes::from_request(req, state).await.map_err(|r| {
            if r.status() == StatusCode::PAYLOAD_TOO_LARGE {
                ApiError::payload_too_large()
            } else {
                ApiError::bad_request("invalid_body", "the request body could not be read")
            }
        })?;
        Ok(Self(bytes))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn ct(values: &[&str]) -> Result<(), ApiError> {
        let mut h = HeaderMap::new();
        for v in values {
            h.append(header::CONTENT_TYPE, HeaderValue::from_str(v).unwrap());
        }
        check_json_content_type(&h)
    }

    #[test]
    fn only_application_json_is_accepted() {
        for ok in ["application/json", "Application/JSON", "application/json; charset=utf-8", "application/json;charset=UTF-8"] {
            ct(&[ok]).unwrap();
        }
        for bad in [
            "text/plain",
            "application/x-www-form-urlencoded",
            "multipart/form-data; boundary=x",
            "application/jsonx",
            "application/json; charset=latin1",
            "application/json; boundary=x",
            "application/ld+json",
            "",
        ] {
            assert_eq!(ct(&[bad]).unwrap_err().status, StatusCode::UNSUPPORTED_MEDIA_TYPE, "{bad}");
        }
        assert!(ct(&[]).is_err());
        assert!(ct(&["application/json", "application/json"]).is_err());
    }
}
