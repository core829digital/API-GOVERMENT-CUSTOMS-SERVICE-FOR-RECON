//! Subscription billing for `recon`: plans and entitlements, race-safe metered usage, Stripe Checkout / Billing Portal /
//! webhooks, ledger events for plan changes. Billing data lives on cluster W only (`migrations/w/0008_billing.sql`).
//!
//! * [`Billing`]: `entitlements(tenant)`, `check_and_consume(tenant, metric, amount, idempotency_key)`, `overview(tenant)`.
//! * [`http::router`]: `POST /billing/webhook`, `POST /billing/checkout`, `POST /billing/portal`,
//!   `GET /billing/subscription`; see [`http`] for how to mount it.
//! * [`plans`] and the `recon-billing-seed` binary insert plan rows (prices are data, never code).
//! * [`signature`]: Stripe webhook signature verification.
//!
//! Only billing identity and amounts are ever sent to the payment provider: no reconciliation data, no tenant name. Billing
//! contact details (name, address, VAT id, e-mail) are collected and stored by the provider; this crate stores none.
//!
//! ```text
//! // in recon-api (owner: the API slice); env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, BILLING_ALLOWED_RETURN_ORIGINS
//! let state = BillingState::new(write_store.clone(), BillingConfig::from_env()?)?;
//! let public = app.merge(webhook_router(state.clone()));                  // public listener, NO API-key layer
//! let tenant = tenant_router(state.clone()).layer(your_auth_layer);       // layer inserts TenantId(principal.tenant)
//! // metering in a command handler:
//! match state.billing().check_and_consume(tenant_id, keys::RUNS_PER_MONTH, 1, &idempotency_key).await? {
//!     Consume::Allowed { .. } => { /* proceed */ }
//!     Consume::LimitExceeded { .. } | Consume::NotEntitled { .. } => { /* 402/429, do not start the run */ }
//! }
//! ```

pub mod apply;
pub mod config;
pub mod entitlements;
pub mod error;
pub mod event;
pub mod http;
pub mod plans;
pub mod service;
pub mod signature;
pub mod stripe;

pub use config::{BillingConfig, Secret};
pub use entitlements::{Access, CapCheck, Entitlements, NotEntitled, Policy, keys};
pub use error::{BillingError, ConfigError};
pub use http::{BillingState, TenantId, router, tenant_router, webhook_router};
pub use service::{Billing, Consume, Overview};
