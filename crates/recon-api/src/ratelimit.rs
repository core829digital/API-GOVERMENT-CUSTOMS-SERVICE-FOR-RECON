//! In-process token-bucket rate limiting (Architecture.md §14: no Redis in v1).
//!
//! **Per replica.** Each API process keeps its own buckets, so with N replicas behind a load balancer the
//! effective limit for one caller is up to N times the configured one. A shared limiter would need shared state
//! (Redis or the database), which v1 does not have.
//!
//! **Bounded memory.** A bucket that has refilled completely is indistinguishable from an absent one, so such
//! buckets are dropped when the table reaches `max_keys` (at most one sweep per second). If the table is still
//! full of *active* buckets, requests from keys not yet tracked are refused (fail closed) until entries recover;
//! the table never grows past `max_keys`.
//!
//! Arithmetic is integer only: tokens are held in micro-tokens, refill is `elapsed_ns * per_minute / 60_000`.

use crate::clock::Clock;
use std::collections::HashMap;
use std::hash::Hash;
use std::str::FromStr;
use std::sync::{Arc, Mutex, PoisonError};

const MICRO: u64 = 1_000_000;
const NANOS_PER_SEC: u64 = 1_000_000_000;
/// Table sweeps (dropping fully refilled buckets) are rate-limited to one per this interval.
const SWEEP_INTERVAL_NANOS: u64 = NANOS_PER_SEC;

/// Sustained rate and burst size of one bucket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Quota {
    /// Tokens added per minute (>= 1).
    pub per_minute: u32,
    /// Bucket capacity: how many requests may arrive at once from a full bucket (>= 1).
    pub burst: u32,
}

impl Quota {
    pub const fn new(per_minute: u32, burst: u32) -> Self {
        Self { per_minute, burst }
    }
}

impl FromStr for Quota {
    type Err = String;

    /// `<per_minute>/<burst>`, both positive integers, e.g. `600/100`.
    fn from_str(s: &str) -> Result<Self, String> {
        let bad = || format!("`{s}` is not `<per_minute>/<burst>` with two positive integers");
        let (a, b) = s.split_once('/').ok_or_else(bad)?;
        let parse = |t: &str| t.parse::<u32>().ok().filter(|n| *n >= 1);
        match (parse(a), parse(b)) {
            (Some(per_minute), Some(burst)) => Ok(Self { per_minute, burst }),
            _ => Err(bad()),
        }
    }
}

/// Outcome of one `check`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allowed { limit: u32, remaining: u32 },
    Limited { limit: u32, retry_after_secs: u32 },
}

#[derive(Debug, Clone, Copy)]
struct Bucket {
    tokens_micro: u64,
    last_nanos: u64,
}

struct Table<K> {
    buckets: HashMap<K, Bucket>,
    last_sweep_nanos: Option<u64>,
}

/// A keyed token-bucket limiter with injectable clock and bounded table.
pub struct RateLimiter<K> {
    quota: Quota,
    max_keys: usize,
    clock: Arc<dyn Clock>,
    table: Mutex<Table<K>>,
}

impl<K: Eq + Hash + Clone> RateLimiter<K> {
    pub fn new(quota: Quota, max_keys: usize, clock: Arc<dyn Clock>) -> Self {
        Self {
            quota,
            max_keys: max_keys.max(1),
            clock,
            table: Mutex::new(Table {
                buckets: HashMap::new(),
                last_sweep_nanos: None,
            }),
        }
    }

    fn capacity_micro(&self) -> u64 {
        u64::from(self.quota.burst) * MICRO
    }

    /// Tokens after refilling `b` up to `now`.
    fn refilled(&self, b: &Bucket, now: u64) -> u64 {
        let elapsed = u128::from(now.saturating_sub(b.last_nanos));
        let add = elapsed * u128::from(self.quota.per_minute) / 60_000;
        let total = u128::from(b.tokens_micro) + add;
        u64::try_from(total)
            .unwrap_or(u64::MAX)
            .min(self.capacity_micro())
    }

    fn retry_after_secs(&self, tokens_micro: u64) -> u32 {
        let deficit = u128::from(MICRO.saturating_sub(tokens_micro));
        let per_minute = u128::from(self.quota.per_minute);
        let nanos = (deficit * 60_000).div_ceil(per_minute);
        let secs = nanos.div_ceil(u128::from(NANOS_PER_SEC));
        u32::try_from(secs).unwrap_or(u32::MAX).max(1)
    }

    /// Take one token for `key`.
    pub fn check(&self, key: K) -> Decision {
        let now = self.clock.monotonic_nanos();
        let limit = self.quota.burst;
        let mut table = self.table.lock().unwrap_or_else(PoisonError::into_inner);

        if !table.buckets.contains_key(&key) && table.buckets.len() >= self.max_keys {
            let due = table
                .last_sweep_nanos
                .is_none_or(|t| now.saturating_sub(t) >= SWEEP_INTERVAL_NANOS);
            if due {
                let cap = self.capacity_micro();
                table.buckets.retain(|_, b| self.refilled(b, now) < cap);
                table.last_sweep_nanos = Some(now);
            }
            if table.buckets.len() >= self.max_keys {
                return Decision::Limited {
                    limit,
                    retry_after_secs: 1,
                };
            }
        }

        let cap = self.capacity_micro();
        let bucket = table.buckets.entry(key).or_insert(Bucket {
            tokens_micro: cap,
            last_nanos: now,
        });
        let tokens = self.refilled(bucket, now);
        bucket.last_nanos = now;
        if tokens >= MICRO {
            bucket.tokens_micro = tokens - MICRO;
            Decision::Allowed {
                limit,
                remaining: u32::try_from(bucket.tokens_micro / MICRO).unwrap_or(u32::MAX),
            }
        } else {
            bucket.tokens_micro = tokens;
            Decision::Limited {
                limit,
                retry_after_secs: self.retry_after_secs(tokens),
            }
        }
    }

    /// Number of tracked keys (for tests and metrics).
    pub fn tracked(&self) -> usize {
        self.table
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .buckets
            .len()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::clock::ManualClock;

    fn limiter(per_minute: u32, burst: u32, max_keys: usize) -> (RateLimiter<u32>, Arc<ManualClock>) {
        let clock = Arc::new(ManualClock::new(1_700_000_000));
        (
            RateLimiter::new(Quota::new(per_minute, burst), max_keys, clock.clone()),
            clock,
        )
    }

    #[test]
    fn burst_is_allowed_then_limited_with_a_retry_hint() {
        let (l, _) = limiter(60, 3, 10);
        for remaining in [2, 1, 0] {
            assert_eq!(l.check(1), Decision::Allowed { limit: 3, remaining });
        }
        assert_eq!(
            l.check(1),
            Decision::Limited {
                limit: 3,
                retry_after_secs: 1
            }
        );
    }

    #[test]
    fn tokens_refill_with_time_and_never_exceed_the_burst() {
        let (l, clock) = limiter(60, 2, 10); // one token per second
        assert!(matches!(l.check(1), Decision::Allowed { .. }));
        assert!(matches!(l.check(1), Decision::Allowed { .. }));
        assert!(matches!(l.check(1), Decision::Limited { .. }));
        clock.advance_secs(1);
        assert!(matches!(l.check(1), Decision::Allowed { remaining: 0, .. }));
        assert!(matches!(l.check(1), Decision::Limited { .. }));
        clock.advance_secs(3600);
        assert_eq!(l.check(1), Decision::Allowed { limit: 2, remaining: 1 });
    }

    #[test]
    fn slow_rates_report_a_proportional_retry_after() {
        let (l, _) = limiter(6, 1, 10); // one token per 10 s
        assert!(matches!(l.check(1), Decision::Allowed { .. }));
        assert_eq!(
            l.check(1),
            Decision::Limited {
                limit: 1,
                retry_after_secs: 10
            }
        );
    }

    #[test]
    fn keys_are_independent() {
        let (l, _) = limiter(60, 1, 10);
        assert!(matches!(l.check(1), Decision::Allowed { .. }));
        assert!(matches!(l.check(1), Decision::Limited { .. }));
        assert!(matches!(l.check(2), Decision::Allowed { .. }));
    }

    #[test]
    fn idle_keys_are_evicted_and_the_table_never_exceeds_its_cap() {
        let (l, clock) = limiter(60, 1, 3);
        for k in 0..3 {
            assert!(matches!(l.check(k), Decision::Allowed { .. }));
        }
        assert_eq!(l.tracked(), 3);
        // all three are active (empty buckets): a new key is refused, memory stays bounded
        assert!(matches!(l.check(99), Decision::Limited { .. }));
        assert_eq!(l.tracked(), 3);
        // once they have refilled they are dropped on demand and the newcomer is admitted
        clock.advance_secs(2);
        assert!(matches!(l.check(99), Decision::Allowed { .. }));
        assert_eq!(l.tracked(), 1);
    }

    #[test]
    fn an_attacker_rotating_keys_cannot_grow_the_table() {
        let (l, _) = limiter(60, 1, 50);
        for k in 0..10_000 {
            l.check(k);
        }
        assert!(l.tracked() <= 50);
    }

    #[test]
    fn quota_parsing_is_strict() {
        assert_eq!("600/100".parse::<Quota>().unwrap(), Quota::new(600, 100));
        for bad in ["", "600", "0/1", "1/0", "a/b", "1/2/3", "-1/2", " 1/2"] {
            assert!(bad.parse::<Quota>().is_err(), "{bad}");
        }
    }
}
