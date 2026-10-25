//! Applying verified provider events to cluster W, exactly once.
//!
//! One event = one tenant-bound transaction: claim the provider event id (`billing.provider_event`, UNIQUE), apply the
//! effect, append the ledger event (subscription changes only; opaque references, no personal data) and commit together.
//! A redelivered event finds its row and changes nothing. If anything fails the transaction rolls back, nothing is
//! recorded, and the provider's retry (up to three days with exponential back-off in live mode,
//! https://docs.stripe.com/webhooks#automatic-retries, accessed 2026-10-25) tries again.

use crate::error::BillingError;
use crate::event::{Action, Event};
use recon_store::WriteStore;
use time::OffsetDateTime;
use uuid::Uuid;

/// What happened to a verified event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Processed {
    /// An event type this crate does not act on.
    Ignored,
    /// No tenant could be attributed (another product on the same provider account). Recorded, not applied.
    Unattributed,
    /// Already processed earlier (redelivery): no effect this time.
    Duplicate,
    /// Applied; the database's outcome word (`created`, `updated`, `unchanged`, `stale`, `conflict`, `linked`, `recorded`, …).
    Applied(String),
}

impl Processed {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Ignored => "ignored",
            Self::Unattributed => "unattributed",
            Self::Duplicate => "duplicate",
            Self::Applied(o) => o,
        }
    }
}

fn ts(secs: i64) -> Result<OffsetDateTime, BillingError> {
    OffsetDateTime::from_unix_timestamp(secs).map_err(|_| BillingError::EventParse("timestamp"))
}

/// Apply one verified event. Idempotent per provider event id.
pub async fn process(w: &WriteStore, event: &Event) -> Result<Processed, BillingError> {
    let Some(action) = crate::event::classify(event)? else {
        return Ok(Processed::Ignored);
    };
    let created = ts(event.created)?;
    let summary = action.summary();
    let (subscription, customer, hint) = action.refs();

    // Resolve the tenant WITHOUT a tenant binding (narrow SECURITY DEFINER lookup), then do all work bound to it.
    let mut lookup = w.begin_unbound().await?;
    let tenant: Option<Uuid> = sqlx::query_scalar("SELECT billing.resolve_tenant($1, $2, $3)")
        .bind(hint)
        .bind(subscription)
        .bind(customer)
        .fetch_one(lookup.conn())
        .await?;
    drop(lookup);

    let Some(tenant) = tenant else {
        let mut tx = w.begin_unbound().await?;
        let fresh: bool =
            sqlx::query_scalar("SELECT billing.record_unattributed_event($1, $2, $3, $4)")
                .bind(&event.id)
                .bind(&event.kind)
                .bind(created)
                .bind(&summary)
                .fetch_one(tx.conn())
                .await?;
        tx.commit().await?;
        return Ok(if fresh {
            Processed::Unattributed
        } else {
            Processed::Duplicate
        });
    };

    let mut tx = w.begin_tenant(tenant).await?;
    let outcome: String = match &action {
        Action::Checkout(c) => {
            sqlx::query_scalar(
                "SELECT billing.apply_checkout_completed($1, $2, $3, $4, $5, $6, $7, $8)",
            )
            .bind(tenant)
            .bind(&event.id)
            .bind(&event.kind)
            .bind(created)
            .bind(c.subscription.as_deref())
            .bind(c.customer.as_deref())
            .bind(c.plan_hint)
            .bind(&summary)
            .fetch_one(tx.conn())
            .await?
        }
        Action::Subscription(s) => {
            let start = s.period_start.map(ts).transpose()?;
            let end = s.period_end.map(ts).transpose()?;
            sqlx::query_scalar(
                "SELECT billing.apply_subscription_event($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
            )
            .bind(tenant)
            .bind(&event.id)
            .bind(&event.kind)
            .bind(created)
            .bind(&s.subscription)
            .bind(s.customer.as_deref())
            .bind(s.price_id.as_deref())
            .bind(s.status.as_str())
            .bind(start)
            .bind(end)
            .bind(s.cancel_at_period_end)
            .bind(&summary)
            .fetch_one(tx.conn())
            .await?
        }
        Action::Invoice(i) => sqlx::query_scalar(
            "SELECT billing.apply_invoice_event($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
        )
        .bind(tenant)
        .bind(&event.id)
        .bind(&event.kind)
        .bind(created)
        .bind(&i.invoice)
        .bind(i.subscription.as_deref())
        .bind(i.number.as_deref())
        .bind(i.amount_minor)
        .bind(&i.currency)
        .bind(i.status)
        .bind(i.hosted_url.as_deref())
        .bind(&summary)
        .fetch_one(tx.conn())
        .await?,
    };

    match outcome.as_str() {
        // nothing was recorded; leave the transaction uncommitted so the provider retries once the plan exists
        "unknown_price" => Err(BillingError::PlanNotConfigured),
        "duplicate" => {
            tx.commit().await?;
            Ok(Processed::Duplicate)
        }
        _ => {
            tx.commit().await?;
            Ok(Processed::Applied(outcome))
        }
    }
}
