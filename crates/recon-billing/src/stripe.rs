//! Minimal Stripe HTTP client (no SDK): Checkout Session and Billing Portal Session creation.
//!
//! * Endpoints: `POST /v1/checkout/sessions` (https://docs.stripe.com/api/checkout/sessions/create) and
//!   `POST /v1/billing_portal/sessions` (https://docs.stripe.com/api/customer_portal/sessions/create), accessed 2026-10-25.
//! * Requests are form-encoded, authenticated with `Authorization: Bearer <secret key>` (header marked sensitive) and pin
//!   `Stripe-Version` to [`API_VERSION`] so behaviour does not change with the account's default version
//!   (https://docs.stripe.com/api/versioning).
//! * Only billing identity and amounts go to Stripe: tenant id and plan id (opaque UUIDs) as reference/metadata, the Stripe
//!   price id and the return URLs. No reconciliation data, no tenant name, no e-mail address.
//! * The secret key is never logged and never part of an error value.

use crate::config::Secret;
use crate::error::BillingError;
use reqwest::{Client, StatusCode, header};
use serde::Deserialize;
use std::time::Duration;
use url::Url;
use uuid::Uuid;

/// The Stripe API version this crate is written against: "The current version is 2026-09-30.endive"
/// (https://docs.stripe.com/api/versioning, accessed 2026-10-25). Webhook endpoints should be created with the same version
/// (events use the endpoint's version, not the request header).
pub const API_VERSION: &str = "2026-09-30.endive";

/// Stripe production API base.
pub const DEFAULT_BASE_URL: &str = "https://api.stripe.com";

/// A created Checkout Session: where to send the customer.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct CheckoutSession {
    pub id: String,
    pub url: String,
}

/// A created Billing Portal session.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PortalSession {
    pub url: String,
}

/// What a Checkout Session is created for.
#[derive(Debug, Clone)]
pub struct CheckoutRequest<'a> {
    pub tenant: Uuid,
    pub plan: Uuid,
    pub price_id: &'a str,
    pub success_url: &'a Url,
    pub cancel_url: &'a Url,
    /// Existing Stripe customer of this tenant (a returning customer), if any.
    pub customer: Option<&'a str>,
}

/// HTTP client for the Stripe API.
#[derive(Clone)]
pub struct StripeClient {
    http: Client,
    base: Url,
    secret: Secret,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: Option<ErrorDetail>,
}

#[derive(Deserialize)]
struct ErrorDetail {
    code: Option<String>,
}

impl StripeClient {
    /// Client for the production API.
    pub fn new(secret: Secret) -> Result<Self, BillingError> {
        Self::with_base_url(secret, DEFAULT_BASE_URL)
    }

    /// Client for another base URL (a private Stripe-compatible endpoint, or a local fake server in tests). Plain `http` is
    /// accepted only for loopback hosts; anything else must be `https`, so the secret key cannot be sent in clear text.
    pub fn with_base_url(secret: Secret, base: &str) -> Result<Self, BillingError> {
        let base = Url::parse(base).map_err(|_| BillingError::Invalid("stripe_base_url"))?;
        let loopback = match base.host() {
            Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            None => false,
        };
        if !(base.scheme() == "https" || (base.scheme() == "http" && loopback)) {
            return Err(BillingError::Invalid("stripe_base_url"));
        }
        // `ring` is the crypto provider used by sqlx in this workspace; installing it twice is harmless (Err ignored).
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("recon-billing/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| BillingError::ProviderTransport("client build"))?;
        Ok(Self { http, base, secret })
    }

    async fn post_form<T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        form: &[(String, String)],
    ) -> Result<T, BillingError> {
        let url = self
            .base
            .join(path)
            .map_err(|_| BillingError::Invalid("stripe_path"))?;
        let res = self
            .http
            .post(url)
            .bearer_auth(self.secret.expose())
            .header("Stripe-Version", API_VERSION)
            .form(form)
            .send()
            .await
            .map_err(|e| {
                BillingError::ProviderTransport(if e.is_timeout() {
                    "timeout"
                } else if e.is_connect() {
                    "connect"
                } else {
                    "request"
                })
            })?;
        let status = res.status();
        if !status.is_success() {
            let code = res
                .json::<ErrorBody>()
                .await
                .ok()
                .and_then(|b| b.error)
                .and_then(|e| e.code)
                .filter(|c| {
                    c.len() <= 64 && c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                });
            return Err(BillingError::ProviderStatus {
                status: status.as_u16(),
                code,
            });
        }
        if status != StatusCode::OK
            || !res
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.starts_with("application/json"))
        {
            return Err(BillingError::ProviderResponse);
        }
        res.json::<T>()
            .await
            .map_err(|_| BillingError::ProviderResponse)
    }

    fn redirect_ok(&self, url: &str) -> bool {
        Url::parse(url).is_ok_and(|u| u.scheme() == self.base.scheme() && u.host().is_some())
    }

    /// Create a subscription Checkout Session for `req`. The tenant id travels as `client_reference_id` and in
    /// `subscription_data.metadata` (so every later subscription and invoice event can be attributed), the plan id in
    /// `metadata`. The billing address and VAT id are collected on Stripe's page and stay at Stripe.
    pub async fn create_checkout_session(
        &self,
        req: &CheckoutRequest<'_>,
    ) -> Result<CheckoutSession, BillingError> {
        let tenant = req.tenant.to_string();
        let plan = req.plan.to_string();
        let mut f: Vec<(String, String)> = vec![
            ("mode".into(), "subscription".into()),
            ("client_reference_id".into(), tenant.clone()),
            ("line_items[0][price]".into(), req.price_id.into()),
            ("line_items[0][quantity]".into(), "1".into()),
            ("success_url".into(), req.success_url.as_str().into()),
            ("cancel_url".into(), req.cancel_url.as_str().into()),
            ("billing_address_collection".into(), "required".into()),
            ("tax_id_collection[enabled]".into(), "true".into()),
            (
                format!(
                    "subscription_data[metadata][{}]",
                    crate::event::METADATA_TENANT
                ),
                tenant.clone(),
            ),
            (
                format!(
                    "subscription_data[metadata][{}]",
                    crate::event::METADATA_PLAN
                ),
                plan.clone(),
            ),
            (
                format!("metadata[{}]", crate::event::METADATA_TENANT),
                tenant,
            ),
            (format!("metadata[{}]", crate::event::METADATA_PLAN), plan),
        ];
        if let Some(c) = req.customer {
            // an existing customer needs explicit permission for Checkout to save the collected name and address on it
            f.push(("customer".into(), c.into()));
            f.push(("customer_update[name]".into(), "auto".into()));
            f.push(("customer_update[address]".into(), "auto".into()));
        }
        let s: CheckoutSession = self.post_form("/v1/checkout/sessions", &f).await?;
        if !self.redirect_ok(&s.url) {
            return Err(BillingError::ProviderResponse);
        }
        Ok(s)
    }

    /// Create a Billing Portal session for an existing Stripe customer.
    pub async fn create_portal_session(
        &self,
        customer: &str,
        return_url: &Url,
    ) -> Result<PortalSession, BillingError> {
        let f = vec![
            ("customer".to_string(), customer.to_string()),
            ("return_url".to_string(), return_url.as_str().to_string()),
        ];
        let s: PortalSession = self.post_form("/v1/billing_portal/sessions", &f).await?;
        if !self.redirect_ok(&s.url) {
            return Err(BillingError::ProviderResponse);
        }
        Ok(s)
    }
}

impl std::fmt::Debug for StripeClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StripeClient")
            .field("base", &self.base.as_str())
            .field("secret", &self.secret)
            .finish()
    }
}
