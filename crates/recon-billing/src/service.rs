//! [`Billing`]: the library API used by the API and the worker.
//!
//! Billing data lives only on cluster W (it is never replicated), so this module holds a [`WriteStore`] and nothing else
//! (R-DB-1). Every call runs in one tenant-bound transaction (`SET LOCAL app.tenant_id`), so RLS applies and an unset or
//! different tenant sees no rows.

use crate::entitlements::{self, Access, EntitlementValue, Entitlements, NotEntitled, Policy};
use crate::error::BillingError;
use recon_store::WriteStore;
use serde::Serialize;
use std::collections::BTreeMap;
use time::OffsetDateTime;
use uuid::Uuid;

/// Result of [`Billing::check_and_consume`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum Consume {
    /// Counted. `used` is the counter after this call. `replayed` = the idempotency key had already been counted (a
    /// retry): nothing was added this time.
    Allowed {
        limit: u64,
        used: u64,
        replayed: bool,
    },
    /// Not counted: `used + amount` would exceed `limit`.
    LimitExceeded { limit: u64, used: u64 },
    /// Not counted: the tenant is not entitled to consume this metric at all.
    NotEntitled { reason: NotEntitled },
}

/// One invoice reference as shown to the tenant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct InvoiceSummary {
    pub number: Option<String>,
    pub amount_minor: i64,
    pub currency: String,
    pub status: String,
    pub hosted_url: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// Everything `GET /billing/subscription` shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Overview {
    #[serde(flatten)]
    pub entitlements: Entitlements,
    /// Counters of the current window, by metric.
    pub usage: BTreeMap<String, u64>,
    /// The newest invoices (at most 12).
    pub invoices: Vec<InvoiceSummary>,
}

/// Entry point of the billing library.
#[derive(Clone)]
pub struct Billing {
    w: WriteStore,
    policy: Policy,
}

fn valid_metric(m: &str) -> bool {
    let mut b = m.bytes();
    matches!(b.next(), Some(c) if c.is_ascii_lowercase())
        && m.len() <= 48
        && m.bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
}

impl Billing {
    pub fn new(w: WriteStore, policy: Policy) -> Self {
        Self { w, policy }
    }

    /// The tenant's entitlements now.
    pub async fn entitlements(&self, tenant: Uuid) -> Result<Entitlements, BillingError> {
        self.entitlements_at(tenant, OffsetDateTime::now_utc())
            .await
    }

    /// As [`Billing::entitlements`] at an explicit instant (tests and replays).
    pub async fn entitlements_at(
        &self,
        tenant: Uuid,
        now: OffsetDateTime,
    ) -> Result<Entitlements, BillingError> {
        let mut tx = self.w.begin_tenant(tenant).await?;
        entitlements::resolve(tx.conn(), tenant, now, self.policy).await
    }

    /// Atomically check the tenant's limit for `metric` and consume `amount` of it.
    ///
    /// * Race-safe: the limit check and the increment are one conditional `UPDATE` on the counter row, so any number of
    ///   concurrent callers can never push the counter past the limit.
    /// * Idempotent per `(tenant, metric, idempotency_key)`: a retry with the same key and amount is
    ///   `Allowed { replayed: true }` and counts nothing; the same key with another amount is
    ///   [`BillingError::IdempotencyKeyReused`]. A `LimitExceeded` or `NotEntitled` answer records nothing, so the key can be
    ///   used again later (for example after an upgrade).
    /// * Fail closed: no subscription and no fallback plan, a read-only subscription, or a metric the plan does not carry ⇒
    ///   [`Consume::NotEntitled`].
    /// * The window is the subscription's current period (rolled forward in whole intervals if the renewal event is late);
    ///   counters of a new window start at zero.
    pub async fn check_and_consume(
        &self,
        tenant: Uuid,
        metric: &str,
        amount: u64,
        idempotency_key: &str,
    ) -> Result<Consume, BillingError> {
        self.check_and_consume_at(
            tenant,
            metric,
            amount,
            idempotency_key,
            OffsetDateTime::now_utc(),
        )
        .await
    }

    /// As [`Billing::check_and_consume`] at an explicit instant (tests and replays).
    pub async fn check_and_consume_at(
        &self,
        tenant: Uuid,
        metric: &str,
        amount: u64,
        idempotency_key: &str,
        now: OffsetDateTime,
    ) -> Result<Consume, BillingError> {
        if !valid_metric(metric) {
            return Err(BillingError::Invalid("metric"));
        }
        let amount = i64::try_from(amount)
            .ok()
            .filter(|a| *a > 0)
            .ok_or(BillingError::Invalid("amount"))?;
        if idempotency_key.is_empty() || idempotency_key.chars().count() > 128 {
            return Err(BillingError::Invalid("idempotency_key"));
        }

        let mut tx = self.w.begin_tenant(tenant).await?;
        let ent = entitlements::resolve(tx.conn(), tenant, now, self.policy).await?;
        match ent.access {
            Access::None => {
                return Ok(Consume::NotEntitled {
                    reason: NotEntitled::NoPlan,
                });
            }
            Access::ReadOnly => {
                return Ok(Consume::NotEntitled {
                    reason: NotEntitled::ReadOnly,
                });
            }
            Access::Full => {}
        }
        let (Some(EntitlementValue::Limit(limit)), Some(period)) =
            (ent.limits.get(metric), ent.period)
        else {
            return Ok(Consume::NotEntitled {
                reason: NotEntitled::NotInPlan,
            });
        };
        let limit = *limit;
        let limit_db = i64::try_from(limit).map_err(|_| BillingError::Invalid("limit"))?;

        let (outcome, used): (String, i64) = sqlx::query_as(
            "SELECT outcome, used FROM billing.consume_usage($1, $2, $3, $4, $5, $6)",
        )
        .bind(tenant)
        .bind(metric)
        .bind(amount)
        .bind(idempotency_key)
        .bind(period.start)
        .bind(limit_db)
        .fetch_one(tx.conn())
        .await?;
        let used = u64::try_from(used).unwrap_or(0);
        match outcome.as_str() {
            "allowed" | "replayed" => {
                tx.commit().await?;
                Ok(Consume::Allowed {
                    limit,
                    used,
                    replayed: outcome == "replayed",
                })
            }
            // dropping the transaction rolls it back (the function already removed its own claim row)
            "limit_exceeded" => Ok(Consume::LimitExceeded { limit, used }),
            "key_reused" => Err(BillingError::IdempotencyKeyReused),
            _ => Err(BillingError::Invalid("unexpected consume outcome")),
        }
    }

    /// Entitlements, current counters and recent invoices of one tenant.
    pub async fn overview(&self, tenant: Uuid) -> Result<Overview, BillingError> {
        self.overview_at(tenant, OffsetDateTime::now_utc()).await
    }

    /// As [`Billing::overview`] at an explicit instant.
    pub async fn overview_at(
        &self,
        tenant: Uuid,
        now: OffsetDateTime,
    ) -> Result<Overview, BillingError> {
        let mut tx = self.w.begin_tenant(tenant).await?;
        let ent = entitlements::resolve(tx.conn(), tenant, now, self.policy).await?;
        let usage: BTreeMap<String, u64> = match ent.period {
            Some(p) => {
                let rows: Vec<(String, i64)> = sqlx::query_as(
                    "SELECT metric, quantity FROM billing.usage_counter WHERE tenant_id = $1 AND period_start = $2",
                )
                .bind(tenant)
                .bind(p.start)
                .fetch_all(tx.conn())
                .await?;
                rows.into_iter()
                    .map(|(m, q)| (m, u64::try_from(q).unwrap_or(0)))
                    .collect()
            }
            None => BTreeMap::new(),
        };
        let invoices: Vec<InvoiceSummary> = sqlx::query_as(
            "SELECT number, amount_minor, currency::text AS currency, status, hosted_url, created_at
               FROM billing.invoice_ref WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT 12",
        )
        .bind(tenant)
        .fetch_all(tx.conn())
        .await?;
        Ok(Overview {
            entitlements: ent,
            usage,
            invoices,
        })
    }
}

/// What a Checkout Session may be created with, decided in one tenant-bound transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckoutContext {
    /// No such plan, or it is retired, not yet valid, not public, the fallback plan, or has no provider price.
    PlanUnavailable,
    /// The tenant already has a non-canceled subscription: changes go through the billing portal.
    AlreadySubscribed,
    Ready {
        price_id: String,
        /// The tenant's Stripe customer from an earlier subscription, reused so invoices stay under one customer.
        customer: Option<String>,
    },
}

impl Billing {
    /// Inputs for a Checkout Session on `plan`.
    pub async fn checkout_context(
        &self,
        tenant: Uuid,
        plan: Uuid,
    ) -> Result<CheckoutContext, BillingError> {
        let mut tx = self.w.begin_tenant(tenant).await?;
        let price: Option<(String,)> = sqlx::query_as(
            "SELECT provider_price_id FROM billing.plan
              WHERE id = $1 AND is_public AND NOT is_fallback AND provider_price_id IS NOT NULL
                AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())",
        )
        .bind(plan)
        .fetch_optional(tx.conn())
        .await?;
        let Some((price_id,)) = price else {
            return Ok(CheckoutContext::PlanUnavailable);
        };
        let live: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM billing.subscription WHERE tenant_id = $1 AND status <> 'canceled')",
        )
        .bind(tenant)
        .fetch_one(tx.conn())
        .await?;
        if live {
            return Ok(CheckoutContext::AlreadySubscribed);
        }
        Ok(CheckoutContext::Ready {
            price_id,
            customer: customer_in(&mut tx, tenant).await?,
        })
    }

    /// The tenant's Stripe customer id (for the billing portal), if it ever had a subscription.
    pub async fn provider_customer(&self, tenant: Uuid) -> Result<Option<String>, BillingError> {
        let mut tx = self.w.begin_tenant(tenant).await?;
        customer_in(&mut tx, tenant).await
    }
}

async fn customer_in(
    tx: &mut recon_store::WriteTx,
    tenant: Uuid,
) -> Result<Option<String>, BillingError> {
    Ok(sqlx::query_scalar(
        "SELECT provider_customer_id FROM billing.subscription
          WHERE tenant_id = $1 AND provider_customer_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    )
    .bind(tenant)
    .fetch_optional(tx.conn())
    .await?)
}
#[cfg(test)]
mod tests {
    use super::valid_metric;

    #[test]
    fn metric_names_are_constrained() {
        assert!(valid_metric("runs_per_month"));
        assert!(!valid_metric(""));
        assert!(!valid_metric("Runs"));
        assert!(!valid_metric("1runs"));
        assert!(!valid_metric("runs-per-month"));
        assert!(!valid_metric(&"a".repeat(49)));
    }
}
