//! Time source for the limiters and the service-signature checks, injectable so tests never sleep.

use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// A monotonic clock (for bucket refill and expiry) plus wall-clock Unix seconds (for signed timestamps).
pub trait Clock: Send + Sync + 'static {
    /// Nanoseconds since an arbitrary fixed origin; never goes backwards.
    fn monotonic_nanos(&self) -> u64;
    /// Seconds since 1970-01-01T00:00:00Z.
    fn unix_secs(&self) -> i64;
}

/// The real clock.
#[derive(Debug)]
pub struct SystemClock {
    origin: Instant,
}

impl SystemClock {
    pub fn new() -> Self {
        Self {
            origin: Instant::now(),
        }
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for SystemClock {
    fn monotonic_nanos(&self) -> u64 {
        u64::try_from(self.origin.elapsed().as_nanos()).unwrap_or(u64::MAX)
    }

    fn unix_secs(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|d| i64::try_from(d.as_secs()).ok())
            .unwrap_or(0)
    }
}

/// A clock the test advances by hand.
#[cfg(test)]
pub(crate) struct ManualClock {
    nanos: std::sync::atomic::AtomicU64,
    unix: std::sync::atomic::AtomicI64,
}

#[cfg(test)]
impl ManualClock {
    pub(crate) fn new(unix_secs: i64) -> Self {
        Self {
            nanos: std::sync::atomic::AtomicU64::new(1_000_000_000),
            unix: std::sync::atomic::AtomicI64::new(unix_secs),
        }
    }

    pub(crate) fn advance_secs(&self, secs: u64) {
        use std::sync::atomic::Ordering::SeqCst;
        self.nanos.fetch_add(secs * 1_000_000_000, SeqCst);
        self.unix
            .fetch_add(i64::try_from(secs).unwrap_or(i64::MAX), SeqCst);
    }
}

#[cfg(test)]
impl Clock for ManualClock {
    fn monotonic_nanos(&self) -> u64 {
        self.nanos.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn unix_secs(&self) -> i64 {
        self.unix.load(std::sync::atomic::Ordering::SeqCst)
    }
}
