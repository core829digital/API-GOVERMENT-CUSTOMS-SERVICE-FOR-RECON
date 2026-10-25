//! Configuration. Secrets come from the environment only, are wrapped so that `Debug`/`Display` redact them
//! (R-PRIV-1, R-SEC-2), and are never written to logs or to the ledger.
//!
//! | Variable | Meaning |
//! |---|---|
//! | `STRIPE_SECRET_KEY` | Stripe secret or restricted API key (`sk_…` / `rk_…`). |
//! | `STRIPE_WEBHOOK_SECRET` | Signing secret(s) of the webhook endpoint, `whsec_…`; comma-separated while a secret is being rolled. |
//! | `BILLING_ALLOWED_RETURN_ORIGINS` | Comma-separated origins (`https://app.example.eu`) that checkout/portal return URLs may point to. |
//! | `BILLING_PAST_DUE_GRACE_DAYS` | Optional. Days a `past_due` subscription keeps working before it becomes read-only (default 14). |

use crate::error::ConfigError;
use std::fmt;
use time::Duration;
use url::{Host, Url};

/// Default grace period for `past_due`: Stripe's recommended Smart Retries setting is "8 tries within 2 weeks"
/// (https://docs.stripe.com/billing/revenue-recovery/smart-retries, accessed 2026-10-25). The retry window is configurable
/// in the Stripe Dashboard; set `BILLING_PAST_DUE_GRACE_DAYS` to match what is configured there.
pub const DEFAULT_PAST_DUE_GRACE_DAYS: i64 = 14;

/// A secret string. `Debug` and `Display` print a fixed marker.
#[derive(Clone)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The secret value. Call only where it is used (HTTP authorisation, HMAC key).
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

impl fmt::Display for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

/// Billing configuration.
#[derive(Debug, Clone)]
pub struct BillingConfig {
    pub stripe_secret_key: Secret,
    pub webhook_secrets: Vec<Secret>,
    allowed_return_origins: Vec<String>,
    pub past_due_grace: Duration,
}

impl BillingConfig {
    /// Read the configuration from the process environment. Every required variable must be present and valid;
    /// there are no defaults for secrets or origins (fail closed).
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|k| std::env::var(k).ok())
    }

    /// As [`BillingConfig::from_env`] with an explicit variable source (used by tests).
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let key = get("STRIPE_SECRET_KEY")
            .filter(|v| !v.trim().is_empty())
            .ok_or(ConfigError::Missing("STRIPE_SECRET_KEY"))?;
        let key = key.trim();
        if !(key.starts_with("sk_") || key.starts_with("rk_")) {
            return Err(ConfigError::Invalid(
                "STRIPE_SECRET_KEY",
                "expected a Stripe secret or restricted key",
            ));
        }
        let secrets = get("STRIPE_WEBHOOK_SECRET")
            .filter(|v| !v.trim().is_empty())
            .ok_or(ConfigError::Missing("STRIPE_WEBHOOK_SECRET"))?;
        let mut webhook_secrets = Vec::new();
        for s in secrets.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            if !s.starts_with("whsec_") {
                return Err(ConfigError::Invalid(
                    "STRIPE_WEBHOOK_SECRET",
                    "expected whsec_… signing secrets",
                ));
            }
            webhook_secrets.push(Secret::new(s));
        }
        if webhook_secrets.is_empty() || webhook_secrets.len() > 4 {
            return Err(ConfigError::Invalid(
                "STRIPE_WEBHOOK_SECRET",
                "between one and four secrets are accepted",
            ));
        }
        let origins = get("BILLING_ALLOWED_RETURN_ORIGINS")
            .filter(|v| !v.trim().is_empty())
            .ok_or(ConfigError::Missing("BILLING_ALLOWED_RETURN_ORIGINS"))?;
        let allowed_return_origins = origins
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|o| {
                parse_origin(o).ok_or(ConfigError::Invalid(
                    "BILLING_ALLOWED_RETURN_ORIGINS",
                    "each entry must be an origin: https://host[:port] (http only for localhost), no path",
                ))
            })
            .collect::<Result<Vec<_>, _>>()?;
        if allowed_return_origins.is_empty() {
            return Err(ConfigError::Missing("BILLING_ALLOWED_RETURN_ORIGINS"));
        }
        let grace_days = match get("BILLING_PAST_DUE_GRACE_DAYS") {
            None => DEFAULT_PAST_DUE_GRACE_DAYS,
            Some(v) => v
                .trim()
                .parse::<i64>()
                .ok()
                .filter(|d| (0..=90).contains(d))
                .ok_or(ConfigError::Invalid(
                    "BILLING_PAST_DUE_GRACE_DAYS",
                    "expected an integer between 0 and 90",
                ))?,
        };
        Ok(Self {
            stripe_secret_key: Secret::new(key),
            webhook_secrets,
            allowed_return_origins,
            past_due_grace: Duration::days(grace_days),
        })
    }

    /// The allowed origins, normalised (`scheme://host[:port]`).
    pub fn allowed_return_origins(&self) -> &[String] {
        &self.allowed_return_origins
    }

    /// Validate a return URL (checkout success/cancel, portal return): an absolute `https` URL (`http` only for loopback
    /// hosts), no credentials, whose origin is exactly one of the allowed origins. Stripe's `{CHECKOUT_SESSION_ID}`
    /// placeholder is allowed in the query.
    pub fn validate_return_url(&self, raw: &str) -> Result<Url, &'static str> {
        if raw.len() > 2048 {
            return Err("return_url_too_long");
        }
        let url = Url::parse(raw).map_err(|_| "return_url_invalid")?;
        if !scheme_ok(&url) {
            return Err("return_url_scheme");
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err("return_url_credentials");
        }
        let origin = url.origin().ascii_serialization();
        if self.allowed_return_origins.contains(&origin) {
            Ok(url)
        } else {
            Err("return_url_origin_not_allowed")
        }
    }
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

fn scheme_ok(url: &Url) -> bool {
    url.scheme() == "https" || (url.scheme() == "http" && is_loopback(url))
}

/// `https://host[:port]` (or `http://localhost…`) with no path, query, fragment or credentials → normalised origin.
fn parse_origin(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    let plain = (url.path().is_empty() || url.path() == "/")
        && url.query().is_none()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.host().is_some();
    if plain && scheme_ok(&url) {
        Some(url.origin().ascii_serialization())
    } else {
        None
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn cfg(extra: &[(&str, &str)]) -> Result<BillingConfig, ConfigError> {
        let mut m: HashMap<String, String> = [
            ("STRIPE_SECRET_KEY", "sk_test_abc"),
            ("STRIPE_WEBHOOK_SECRET", "whsec_one"),
            (
                "BILLING_ALLOWED_RETURN_ORIGINS",
                "https://app.example.eu, https://example.eu:8443",
            ),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        for (k, v) in extra {
            if v.is_empty() {
                m.remove(*k);
            } else {
                m.insert((*k).to_string(), (*v).to_string());
            }
        }
        BillingConfig::from_lookup(|k| m.get(k).cloned())
    }

    #[test]
    fn secrets_never_render() {
        let c = cfg(&[]).unwrap();
        let shown = format!("{c:?} {}", c.stripe_secret_key);
        assert!(!shown.contains("sk_test_abc") && !shown.contains("whsec_one"));
    }

    #[test]
    fn missing_or_malformed_values_fail_closed() {
        assert_eq!(
            cfg(&[("STRIPE_SECRET_KEY", "")]).unwrap_err(),
            ConfigError::Missing("STRIPE_SECRET_KEY")
        );
        assert!(cfg(&[("STRIPE_SECRET_KEY", "pk_live_x")]).is_err());
        assert!(cfg(&[("STRIPE_WEBHOOK_SECRET", "")]).is_err());
        assert!(cfg(&[("STRIPE_WEBHOOK_SECRET", "nope")]).is_err());
        assert!(cfg(&[("BILLING_ALLOWED_RETURN_ORIGINS", "")]).is_err());
        assert!(cfg(&[("BILLING_ALLOWED_RETURN_ORIGINS", "https://a.eu/path")]).is_err());
        assert!(cfg(&[("BILLING_ALLOWED_RETURN_ORIGINS", "*")]).is_err());
        assert!(cfg(&[("BILLING_ALLOWED_RETURN_ORIGINS", "http://app.example.eu")]).is_err());
        assert!(cfg(&[("BILLING_PAST_DUE_GRACE_DAYS", "-1")]).is_err());
        assert_eq!(
            cfg(&[("BILLING_PAST_DUE_GRACE_DAYS", "7")])
                .unwrap()
                .past_due_grace,
            Duration::days(7)
        );
        assert_eq!(cfg(&[]).unwrap().past_due_grace, Duration::days(14));
    }

    #[test]
    fn two_webhook_secrets_while_rolling() {
        let c = cfg(&[("STRIPE_WEBHOOK_SECRET", "whsec_old, whsec_new")]).unwrap();
        assert_eq!(c.webhook_secrets.len(), 2);
    }

    #[test]
    fn return_urls_must_match_an_allowed_origin() {
        let c = cfg(&[]).unwrap();
        assert!(
            c.validate_return_url("https://app.example.eu/billing?ok=1")
                .is_ok()
        );
        assert!(
            c.validate_return_url("https://app.example.eu/done?s={CHECKOUT_SESSION_ID}")
                .is_ok()
        );
        assert!(c.validate_return_url("https://example.eu:8443/x").is_ok());
        for bad in [
            "https://evil.example/x",
            "https://app.example.eu.evil.example/x",
            "https://app.example.eu@evil.example/x",
            "https://user:pw@app.example.eu/x",
            "http://app.example.eu/x",
            "https://example.eu/x",
            "javascript:alert(1)",
            "//app.example.eu/x",
            "/relative",
            "",
        ] {
            assert!(c.validate_return_url(bad).is_err(), "accepted {bad}");
        }
    }
}
