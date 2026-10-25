//! HTTP surface, ready to mount into `recon-api`.
//!
//! | Route | Auth | Purpose |
//! |---|---|---|
//! | `POST /billing/webhook` | **none** — Stripe's signature (`Stripe-Signature`) over the raw body | provider events |
//! | `POST /billing/checkout` | tenant | create a subscription Checkout Session; body `{plan_id, success_url, cancel_url}` |
//! | `POST /billing/portal` | tenant | create a Billing Portal session; body `{return_url}` |
//! | `GET /billing/subscription` | tenant | entitlements, usage of the current window, recent invoices |
//!
//! ## How the parent mounts it
//! * The webhook is called by Stripe, not by a customer: mount it on the **public** listener and do **not** put the API-key
//!   layer in front of it ([`webhook_router`]). It rate-limits and body-limits itself (1 MiB) and verifies the signature
//!   before parsing anything.
//! * The three tenant routes ([`tenant_router`]) read the caller from the request extension [`TenantId`]. The parent's
//!   authentication layer MUST insert it (`req.extensions_mut().insert(TenantId(principal.tenant))`) after it has
//!   authenticated the API key and checked its scope. A request without the extension is answered `401` (fail closed), so
//!   forgetting the auth layer cannot expose another tenant's data.
//! * [`router`] merges both. If the parent applies one auth layer to the merged router it must let `POST /billing/webhook`
//!   through ([`WEBHOOK_PATH`]); layering [`tenant_router`] alone is simpler.
//! * Billing data exists only on cluster W (never replicated), so these handlers read W by necessity. That is a deliberate,
//!   documented exception to "queries use R" (DatabaseInfo.md, Billing); they hold a `WriteStore` only (R-DB-1) and never
//!   fall back from R to W.
//! * Checkout/portal creation changes nothing in our database (the session lives at Stripe), so they do not use the
//!   `Idempotency-Key` store; the webhook is idempotent per provider event id.

use crate::apply;
use crate::config::BillingConfig;
use crate::error::BillingError;
use crate::event;
use crate::service::{Billing, CheckoutContext};
use crate::signature;
use crate::stripe::{CheckoutRequest, StripeClient};
use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, FromRequestParts, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header, request::Parts};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use recon_store::WriteStore;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use time::OffsetDateTime;
use uuid::Uuid;

/// Path of the provider webhook.
pub const WEBHOOK_PATH: &str = "/billing/webhook";

const WEBHOOK_BODY_LIMIT: usize = 1024 * 1024;
const TENANT_BODY_LIMIT: usize = 8 * 1024;

/// The authenticated tenant of a request. Inserted into the request extensions by the parent's authentication layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TenantId(pub Uuid);

/// Shared state of the billing routes.
#[derive(Clone)]
pub struct BillingState {
    w: WriteStore,
    billing: Billing,
    stripe: Arc<StripeClient>,
    config: Arc<BillingConfig>,
}

impl BillingState {
    /// State with a Stripe client for the production API.
    pub fn new(w: WriteStore, config: BillingConfig) -> Result<Self, BillingError> {
        let stripe = StripeClient::new(config.stripe_secret_key.clone())?;
        Ok(Self::with_stripe(w, config, stripe))
    }

    /// State with an explicit Stripe client (another base URL, or a local fake server in tests).
    pub fn with_stripe(w: WriteStore, config: BillingConfig, stripe: StripeClient) -> Self {
        let billing = Billing::new(
            w.clone(),
            crate::entitlements::Policy {
                past_due_grace: config.past_due_grace,
            },
        );
        Self {
            w,
            billing,
            stripe: Arc::new(stripe),
            config: Arc::new(config),
        }
    }

    /// The library facade for the same store and policy (for `check_and_consume` in the API/worker).
    pub fn billing(&self) -> &Billing {
        &self.billing
    }
}

/// All billing routes.
pub fn router(state: BillingState) -> Router {
    webhook_router(state.clone()).merge(tenant_router(state))
}

/// `POST /billing/webhook` only. Mount on the public listener WITHOUT the API-key layer.
pub fn webhook_router(state: BillingState) -> Router {
    Router::new()
        .route(WEBHOOK_PATH, post(webhook))
        .layer(DefaultBodyLimit::max(WEBHOOK_BODY_LIMIT))
        .with_state(state)
}

/// `POST /billing/checkout`, `POST /billing/portal`, `GET /billing/subscription`. Mount behind the authentication layer
/// that inserts [`TenantId`].
pub fn tenant_router(state: BillingState) -> Router {
    Router::new()
        .route("/billing/checkout", post(checkout))
        .route("/billing/portal", post(portal))
        .route("/billing/subscription", get(subscription))
        .layer(DefaultBodyLimit::max(TENANT_BODY_LIMIT))
        .with_state(state)
}

// ---------------------------------------------------------------------------------------------------------------------
// errors (same body shape as recon-api: {"error": {"code", "message"}})

struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: &'static str,
}

impl ApiError {
    const fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
        }
    }
    const fn bad_request(code: &'static str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, "request rejected")
    }
    const fn internal() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal error",
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = json!({"error": {"code": self.code, "message": self.message}});
        no_store((self.status, Json(body)).into_response())
    }
}

impl From<BillingError> for ApiError {
    fn from(e: BillingError) -> Self {
        match e {
            BillingError::Invalid(code) => Self::bad_request(code),
            BillingError::ProviderStatus { .. }
            | BillingError::ProviderTransport(_)
            | BillingError::ProviderResponse => {
                eprintln!("billing: provider call failed: {e}");
                Self::new(
                    StatusCode::BAD_GATEWAY,
                    "billing_provider_error",
                    "the billing provider could not complete the request",
                )
            }
            other => {
                eprintln!("billing: internal error: {other}");
                Self::internal()
            }
        }
    }
}

fn no_store(mut r: Response) -> Response {
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

/// The caller's tenant, or `401` when the parent mounted the route without its authentication layer.
struct AuthTenant(Uuid);

impl<S: Send + Sync> FromRequestParts<S> for AuthTenant {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<TenantId>()
            .map(|t| AuthTenant(t.0))
            .ok_or(ApiError::new(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "missing or invalid credentials",
            ))
    }
}

fn parse_json<T: for<'de> Deserialize<'de>>(body: &Bytes) -> Result<T, ApiError> {
    serde_json::from_slice(body).map_err(|_| ApiError::bad_request("invalid_json"))
}

// ---------------------------------------------------------------------------------------------------------------------
// webhook

async fn webhook(State(s): State<BillingState>, headers: HeaderMap, body: Bytes) -> Response {
    // 1. authenticate: signature over the RAW bytes, before any parsing
    let Some(sig) = headers
        .get("stripe-signature")
        .and_then(|v| v.to_str().ok())
    else {
        return ApiError::bad_request("invalid_signature").into_response();
    };
    let now = OffsetDateTime::now_utc().unix_timestamp();
    if let Err(e) = signature::verify(&body, sig, &s.config.webhook_secrets, now) {
        eprintln!("billing: webhook rejected: {e}");
        return ApiError::bad_request("invalid_signature").into_response();
    }
    // 2. parse the envelope
    let ev = match event::parse_event(&body) {
        Ok(ev) => ev,
        Err(e) => {
            eprintln!("billing: signed webhook has an unusable envelope: {e}");
            return ApiError::bad_request("invalid_event").into_response();
        }
    };
    // 3. apply exactly once; anything but success is a 5xx so the provider retries
    match apply::process(&s.w, &ev).await {
        Ok(p) => {
            if matches!(&p, apply::Processed::Applied(o) if o == "conflict") {
                eprintln!(
                    "billing: event {} ({}) conflicts with an existing subscription",
                    ev.id, ev.kind
                );
            }
            no_store(
                (
                    StatusCode::OK,
                    Json(json!({"received": true, "outcome": p.as_str()})),
                )
                    .into_response(),
            )
        }
        Err(e) => {
            eprintln!("billing: event {} ({}) not applied: {e}", ev.id, ev.kind);
            ApiError::internal().into_response()
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// tenant routes

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CheckoutBody {
    plan_id: Uuid,
    success_url: String,
    cancel_url: String,
}

async fn checkout(
    State(s): State<BillingState>,
    AuthTenant(tenant): AuthTenant,
    body: Bytes,
) -> Result<Response, ApiError> {
    let b: CheckoutBody = parse_json(&body)?;
    let success = s
        .config
        .validate_return_url(&b.success_url)
        .map_err(ApiError::bad_request)?;
    let cancel = s
        .config
        .validate_return_url(&b.cancel_url)
        .map_err(ApiError::bad_request)?;
    let (price_id, customer) = match s.billing.checkout_context(tenant, b.plan_id).await? {
        CheckoutContext::PlanUnavailable => {
            return Err(ApiError::new(
                StatusCode::NOT_FOUND,
                "plan_not_available",
                "plan not available",
            ));
        }
        CheckoutContext::AlreadySubscribed => {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "already_subscribed",
                "a subscription already exists; use the billing portal to change it",
            ));
        }
        CheckoutContext::Ready { price_id, customer } => (price_id, customer),
    };
    let session = s
        .stripe
        .create_checkout_session(&CheckoutRequest {
            tenant,
            plan: b.plan_id,
            price_id: &price_id,
            success_url: &success,
            cancel_url: &cancel,
            customer: customer.as_deref(),
        })
        .await?;
    Ok(no_store(
        (
            StatusCode::OK,
            Json(json!({"id": session.id, "url": session.url})),
        )
            .into_response(),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PortalBody {
    return_url: String,
}

async fn portal(
    State(s): State<BillingState>,
    AuthTenant(tenant): AuthTenant,
    body: Bytes,
) -> Result<Response, ApiError> {
    let b: PortalBody = parse_json(&body)?;
    let return_url = s
        .config
        .validate_return_url(&b.return_url)
        .map_err(ApiError::bad_request)?;
    let Some(customer) = s.billing.provider_customer(tenant).await? else {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "no_billing_account",
            "no billing account exists for this tenant",
        ));
    };
    let session = s
        .stripe
        .create_portal_session(&customer, &return_url)
        .await?;
    Ok(no_store(
        (StatusCode::OK, Json(json!({"url": session.url}))).into_response(),
    ))
}

async fn subscription(
    State(s): State<BillingState>,
    AuthTenant(tenant): AuthTenant,
) -> Result<Response, ApiError> {
    let overview = s.billing.overview(tenant).await?;
    Ok(no_store((StatusCode::OK, Json(overview)).into_response()))
}
