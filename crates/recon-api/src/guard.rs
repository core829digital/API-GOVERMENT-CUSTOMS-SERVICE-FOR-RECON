//! Abuse protection shared by both listeners: the pre-auth per-IP limiter, the post-auth per-key and per-tenant
//! limiters (stricter for writes), the cap on concurrent Argon2 verifications, and the trusted-proxy list.
//!
//! All state is in process memory and per replica (see [`crate::ratelimit`]). The defaults below protect the
//! service; they are not plan or quota definitions of any commercial offer.

use crate::clock::{Clock, SystemClock};
use crate::error::ApiError;
use crate::net::{Cidr, parse_cidr_list};
use crate::ratelimit::{Decision, Quota, RateLimiter};
use std::net::{IpAddr, Ipv6Addr};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;
use uuid::Uuid;

/// Quotas of the five limiters.
#[derive(Debug, Clone, Copy)]
pub struct RateLimits {
    /// Before authentication, per client address (IPv6: per /64). Runs before any Argon2 work.
    pub ip: Quota,
    /// After authentication, per API key, for GET.
    pub key_read: Quota,
    /// After authentication, per API key, for POST (commands).
    pub key_write: Quota,
    /// After authentication, per tenant (all of its keys together), for GET.
    pub tenant_read: Quota,
    /// After authentication, per tenant, for POST.
    pub tenant_write: Quota,
    /// Most tracked keys per limiter; beyond that unknown keys are refused until idle ones expire.
    pub max_tracked_keys: usize,
}

impl Default for RateLimits {
    fn default() -> Self {
        Self {
            ip: Quota::new(600, 100),
            key_read: Quota::new(600, 100),
            key_write: Quota::new(60, 20),
            tenant_read: Quota::new(1200, 200),
            tenant_write: Quota::new(120, 40),
            max_tracked_keys: 100_000,
        }
    }
}

/// Everything the guard needs; [`SecurityConfig::default`] is safe for production use.
#[derive(Debug, Clone)]
pub struct SecurityConfig {
    pub limits: RateLimits,
    /// Argon2id verifications running at once (each uses CPU and ~19 MiB).
    pub argon2_concurrency: usize,
    /// How long a request waits for a verification slot before `503 busy`.
    pub argon2_wait: Duration,
    /// Peers whose `X-Forwarded-For` is believed (see [`crate::net`]).
    pub trusted_proxies: Vec<Cidr>,
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            limits: RateLimits::default(),
            argon2_concurrency: 4,
            argon2_wait: Duration::from_millis(500),
            trusted_proxies: Vec::new(),
        }
    }
}

impl SecurityConfig {
    /// Read the limits from environment-style variables (`get` returns `None` when unset):
    /// `RECON_RATE_IP`, `RECON_RATE_KEY_READ`, `RECON_RATE_KEY_WRITE`, `RECON_RATE_TENANT_READ`,
    /// `RECON_RATE_TENANT_WRITE` (each `<per_minute>/<burst>`), `RECON_RATE_MAX_KEYS`,
    /// `RECON_ARGON2_CONCURRENCY`, `RECON_ARGON2_WAIT_MS`, `RECON_TRUSTED_PROXY_CIDRS`.
    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let mut cfg = Self::default();
        let quota = |name: &str, slot: &mut Quota| -> Result<(), String> {
            if let Some(v) = get(name) {
                *slot = v.parse().map_err(|e| format!("{name}: {e}"))?;
            }
            Ok(())
        };
        quota("RECON_RATE_IP", &mut cfg.limits.ip)?;
        quota("RECON_RATE_KEY_READ", &mut cfg.limits.key_read)?;
        quota("RECON_RATE_KEY_WRITE", &mut cfg.limits.key_write)?;
        quota("RECON_RATE_TENANT_READ", &mut cfg.limits.tenant_read)?;
        quota("RECON_RATE_TENANT_WRITE", &mut cfg.limits.tenant_write)?;
        let positive = |name: &str| -> Result<Option<u64>, String> {
            get(name)
                .map(|v| {
                    v.parse::<u64>()
                        .ok()
                        .filter(|n| *n >= 1)
                        .ok_or_else(|| format!("{name} must be a positive integer"))
                })
                .transpose()
        };
        if let Some(n) = positive("RECON_RATE_MAX_KEYS")? {
            cfg.limits.max_tracked_keys = usize::try_from(n).map_err(|_| "RECON_RATE_MAX_KEYS is too large".to_string())?;
        }
        if let Some(n) = positive("RECON_ARGON2_CONCURRENCY")? {
            cfg.argon2_concurrency = usize::try_from(n).map_err(|_| "RECON_ARGON2_CONCURRENCY is too large".to_string())?;
        }
        if let Some(n) = positive("RECON_ARGON2_WAIT_MS")? {
            cfg.argon2_wait = Duration::from_millis(n);
        }
        if let Some(v) = get("RECON_TRUSTED_PROXY_CIDRS") {
            cfg.trusted_proxies = parse_cidr_list(&v).map_err(|e| format!("RECON_TRUSTED_PROXY_CIDRS: {e}"))?;
        }
        Ok(cfg)
    }
}

/// The limiters and the Argon2 gate, shared through [`crate::AppState`].
pub struct Guard {
    ip: RateLimiter<IpAddr>,
    key_read: RateLimiter<Uuid>,
    key_write: RateLimiter<Uuid>,
    tenant_read: RateLimiter<Uuid>,
    tenant_write: RateLimiter<Uuid>,
    argon2: Semaphore,
    argon2_wait: Duration,
    pub(crate) trusted_proxies: Vec<Cidr>,
}

/// An IPv6 client is a whole /64 (what a single subscriber is routinely given); IPv4-mapped IPv6 is IPv4.
fn ip_bucket(ip: IpAddr) -> IpAddr {
    match ip.to_canonical() {
        IpAddr::V6(a) => IpAddr::V6(Ipv6Addr::from(u128::from(a) & (u128::MAX << 64))),
        v4 => v4,
    }
}

fn into_result(d: Decision) -> Result<(), ApiError> {
    match d {
        Decision::Allowed { .. } => Ok(()),
        Decision::Limited { limit, retry_after_secs } => Err(ApiError::rate_limited(limit, retry_after_secs)),
    }
}

impl Guard {
    pub fn new(cfg: SecurityConfig) -> Self {
        Self::with_clock(cfg, Arc::new(SystemClock::new()))
    }

    pub fn with_clock(cfg: SecurityConfig, clock: Arc<dyn Clock>) -> Self {
        let l = cfg.limits;
        let n = l.max_tracked_keys;
        Self {
            ip: RateLimiter::new(l.ip, n, clock.clone()),
            key_read: RateLimiter::new(l.key_read, n, clock.clone()),
            key_write: RateLimiter::new(l.key_write, n, clock.clone()),
            tenant_read: RateLimiter::new(l.tenant_read, n, clock.clone()),
            tenant_write: RateLimiter::new(l.tenant_write, n, clock),
            argon2: Semaphore::new(cfg.argon2_concurrency.max(1)),
            argon2_wait: cfg.argon2_wait,
            trusted_proxies: cfg.trusted_proxies,
        }
    }

    /// Pre-authentication limit for a client address; `None` (no peer address known) shares one bucket.
    pub fn check_ip(&self, ip: Option<IpAddr>) -> Result<(), ApiError> {
        let key = ip_bucket(ip.unwrap_or(IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED)));
        into_result(self.ip.check(key))
    }

    /// Post-authentication limits: the API key's bucket, then the tenant's. `write` selects the stricter quotas.
    pub fn check_principal(&self, key: Uuid, tenant: Uuid, write: bool) -> Result<(), ApiError> {
        let (k, t) = if write {
            (&self.key_write, &self.tenant_write)
        } else {
            (&self.key_read, &self.tenant_read)
        };
        into_result(k.check(key))?;
        into_result(t.check(tenant))
    }

    /// Run one Argon2id verification under the concurrency cap. Waits at most `argon2_wait` for a slot, then
    /// fails with `503 busy`: unauthenticated traffic can occupy the slots but cannot queue unboundedly.
    pub async fn verify_password(&self, phc: String, secret: String) -> Result<bool, ApiError> {
        let permit = match tokio::time::timeout(self.argon2_wait, self.argon2.acquire()).await {
            Ok(Ok(p)) => p,
            Ok(Err(_)) => return Err(ApiError::internal()),
            Err(_) => return Err(ApiError::busy()),
        };
        let ok = crate::auth::verify(phc, secret).await;
        drop(permit);
        Ok(ok)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::clock::ManualClock;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn defaults_apply_and_overrides_parse_strictly() {
        let d = SecurityConfig::from_env(env(&[])).unwrap();
        assert_eq!(d.limits.key_write, Quota::new(60, 20));
        let c = SecurityConfig::from_env(env(&[
            ("RECON_RATE_IP", "30/5"),
            ("RECON_ARGON2_CONCURRENCY", "2"),
            ("RECON_TRUSTED_PROXY_CIDRS", "10.0.0.0/8, fd00::/8"),
        ]))
        .unwrap();
        assert_eq!(c.limits.ip, Quota::new(30, 5));
        assert_eq!(c.argon2_concurrency, 2);
        assert_eq!(c.trusted_proxies.len(), 2);
        for bad in [
            ("RECON_RATE_IP", "30"),
            ("RECON_RATE_KEY_READ", "0/5"),
            ("RECON_ARGON2_CONCURRENCY", "0"),
            ("RECON_ARGON2_WAIT_MS", "x"),
            ("RECON_RATE_MAX_KEYS", "-3"),
            ("RECON_TRUSTED_PROXY_CIDRS", "10.0.0.1"),
        ] {
            assert!(SecurityConfig::from_env(env(&[bad])).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn ipv6_clients_share_a_bucket_per_64() {
        let cfg = SecurityConfig {
            limits: RateLimits {
                ip: Quota::new(60, 2),
                ..RateLimits::default()
            },
            ..SecurityConfig::default()
        };
        let g = Guard::with_clock(cfg, Arc::new(ManualClock::new(1_700_000_000)));
        let a: IpAddr = "2001:db8:1:2::1".parse().unwrap();
        let b: IpAddr = "2001:db8:1:2:ffff::9".parse().unwrap();
        let other: IpAddr = "2001:db8:1:3::1".parse().unwrap();
        g.check_ip(Some(a)).unwrap();
        g.check_ip(Some(b)).unwrap();
        assert_eq!(g.check_ip(Some(a)).unwrap_err().status, axum::http::StatusCode::TOO_MANY_REQUESTS);
        g.check_ip(Some(other)).unwrap();
    }

    #[test]
    fn writes_have_their_own_stricter_buckets() {
        let cfg = SecurityConfig {
            limits: RateLimits {
                key_read: Quota::new(60, 5),
                key_write: Quota::new(60, 1),
                tenant_read: Quota::new(600, 50),
                tenant_write: Quota::new(600, 50),
                ..RateLimits::default()
            },
            ..SecurityConfig::default()
        };
        let g = Guard::with_clock(cfg, Arc::new(ManualClock::new(1_700_000_000)));
        let (k, t) = (Uuid::from_u128(1), Uuid::from_u128(2));
        g.check_principal(k, t, true).unwrap();
        let e = g.check_principal(k, t, true).unwrap_err();
        assert_eq!((e.status.as_u16(), e.retry_after_secs), (429, Some(1)));
        assert!(e.extra_headers.iter().any(|(n, _)| n == "ratelimit-limit"));
        for _ in 0..5 {
            g.check_principal(k, t, false).unwrap(); // reads are unaffected by the write bucket
        }
    }

    #[test]
    fn tenant_bucket_limits_all_keys_of_the_tenant_together() {
        let cfg = SecurityConfig {
            limits: RateLimits {
                key_read: Quota::new(600, 50),
                tenant_read: Quota::new(60, 2),
                ..RateLimits::default()
            },
            ..SecurityConfig::default()
        };
        let g = Guard::with_clock(cfg, Arc::new(ManualClock::new(1_700_000_000)));
        let t = Uuid::from_u128(9);
        g.check_principal(Uuid::from_u128(1), t, false).unwrap();
        g.check_principal(Uuid::from_u128(2), t, false).unwrap();
        assert!(g.check_principal(Uuid::from_u128(3), t, false).is_err());
        g.check_principal(Uuid::from_u128(3), Uuid::from_u128(10), false).unwrap();
    }

    #[tokio::test]
    async fn argon2_slots_are_capped_and_saturation_fails_fast() {
        let cfg = SecurityConfig {
            argon2_concurrency: 1,
            argon2_wait: Duration::from_millis(30),
            ..SecurityConfig::default()
        };
        let g = Arc::new(Guard::new(cfg));
        let hash = crate::auth::hash_secret("s").unwrap();
        let held = g.argon2.acquire().await.unwrap();
        let e = g.verify_password(hash.clone(), "s".into()).await.unwrap_err();
        assert_eq!((e.status.as_u16(), e.code), (503, "busy"));
        drop(held);
        assert!(g.verify_password(hash, "s".into()).await.unwrap());
    }
}
