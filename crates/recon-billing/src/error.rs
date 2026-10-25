//! Errors of the billing library. Display strings never contain secrets, provider payloads or personal data.

/// Everything that can go wrong in this crate.
#[derive(Debug, thiserror::Error)]
pub enum BillingError {
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("store error: {0}")]
    Store(#[from] recon_store::StoreError),
    /// The payment provider answered with an HTTP error status. `code` is the provider's machine-readable error code.
    #[error("billing provider returned HTTP {status} (code {code:?})")]
    ProviderStatus { status: u16, code: Option<String> },
    /// The payment provider could not be reached (connect, TLS or timeout).
    #[error("billing provider unreachable: {0}")]
    ProviderTransport(&'static str),
    /// The provider answered 2xx with a body this crate cannot use.
    #[error("billing provider returned an unusable response")]
    ProviderResponse,
    /// Caller input rejected; the text is a stable machine code, never user input.
    #[error("invalid input: {0}")]
    Invalid(&'static str),
    /// The same idempotency key was used for a different amount.
    #[error("idempotency key was already used with a different amount")]
    IdempotencyKeyReused,
    /// A provider event refers to a price that is not in `billing.plan`. Nothing was recorded; the provider will retry,
    /// which gives an operator time to seed the missing plan.
    #[error("provider event refers to a price with no billing.plan row")]
    PlanNotConfigured,
    /// A signed provider event whose JSON does not have the shape this crate understands.
    #[error("provider event could not be parsed: {0}")]
    EventParse(&'static str),
}

/// Configuration errors. Messages name the variable, never its value.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("environment variable {0} is not set")]
    Missing(&'static str),
    #[error("environment variable {0} is invalid: {1}")]
    Invalid(&'static str, &'static str),
}
