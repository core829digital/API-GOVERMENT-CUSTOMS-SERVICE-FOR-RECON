//! Entitlement resolution: what a tenant's plan allows right now.
//!
//! Resolution order (one tenant-bound W transaction, RLS applies):
//! 1. the tenant's live subscription (`trialing`, `active`, `past_due`) and its plan;
//! 2. otherwise the open-ended *fallback* plan (`billing.plan.is_fallback`, the free/sandbox plan) **if such a row exists**;
//! 3. otherwise nothing: access is [`Access::None`] and every consumption is denied (fail closed).
//!
//! Access level of a subscription:
//! * `trialing` / `active`: [`Access::Full`];
//! * `past_due`: [`Access::Full`] for `past_due_grace` after the provider reported the failed payment (default 14 days =
//!   Stripe's recommended retry window), then [`Access::ReadOnly`];
//! * a period that ended more than `past_due_grace` ago without any renewal event (webhook outage or missed event) is also
//!   [`Access::ReadOnly`]: stale billing state is not trusted to grant access indefinitely.
//!
//! `ReadOnly` means *no new consumption*. Billing never deletes or hides data; reads of existing findings and evidence are
//! not gated here at all.

use crate::error::BillingError;
use serde::Serialize;
use sqlx::PgConnection;
use std::collections::BTreeMap;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

/// Entitlement keys known to this crate. A plan may carry only these (checked when seeding).
pub mod keys {
    pub const RUNS_PER_MONTH: &str = "runs_per_month";
    pub const RECORDS_PER_MONTH: &str = "records_per_month";
    pub const LEGAL_ENTITIES: &str = "legal_entities";
    pub const USERS: &str = "users";
    pub const COUNTRIES: &str = "countries";
    pub const API_KEYS: &str = "api_keys";
    pub const EVIDENCE_PACKS: &str = "evidence_packs";
    pub const SUPPORT_TIER: &str = "support_tier";

    /// Every key, all numeric limits. Metered per period: `RUNS_PER_MONTH`, `RECORDS_PER_MONTH`, `EVIDENCE_PACKS`
    /// (use `check_and_consume`). Caps checked against a current count: `LEGAL_ENTITIES`, `USERS`, `COUNTRIES`, `API_KEYS`
    /// (use `Entitlements::check_cap`). `SUPPORT_TIER` is an ordinal read with `Entitlements::limit`.
    pub const ALL: [&str; 8] = [
        RUNS_PER_MONTH,
        RECORDS_PER_MONTH,
        LEGAL_ENTITIES,
        USERS,
        COUNTRIES,
        API_KEYS,
        EVIDENCE_PACKS,
        SUPPORT_TIER,
    ];
}

/// One entitlement value: a numeric limit or a boolean flag (serialises as a JSON number or boolean).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum EntitlementValue {
    Limit(u64),
    Flag(bool),
}

/// Subscription status (this schema's vocabulary).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionStatus {
    Trialing,
    Active,
    PastDue,
}

/// Where the effective plan came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanSource {
    Subscription,
    Fallback,
    None,
}

/// What the tenant may do with the product's metered features right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    /// New consumption allowed up to the plan's limits.
    Full,
    /// No new consumption. Existing data stays readable; nothing is deleted.
    ReadOnly,
    /// No plan at all (no subscription and no fallback plan): everything denied.
    None,
}

/// The plan row a tenant is on. Contains no secret; `display_key` is an i18n key, never user-facing text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlanSummary {
    pub id: Uuid,
    pub code: String,
    pub display_key: String,
    pub billing_interval: String,
    pub currency: String,
    pub unit_amount_minor: i64,
}

/// A usage window, `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Period {
    #[serde(with = "time::serde::rfc3339")]
    pub start: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub end: OffsetDateTime,
}

/// Why a request was not entitled (as opposed to over a limit).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NotEntitled {
    /// No subscription and no fallback plan.
    NoPlan,
    /// Payment overdue beyond the grace period, or billing state stale: no new consumption.
    ReadOnly,
    /// The plan does not carry this entitlement key (or it is not a numeric limit).
    NotInPlan,
}

/// The resolved entitlements of one tenant at one instant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Entitlements {
    pub plan: Option<PlanSummary>,
    pub source: PlanSource,
    pub status: Option<SubscriptionStatus>,
    pub access: Access,
    pub cancel_at_period_end: bool,
    #[serde(with = "time::serde::rfc3339::option")]
    pub past_due_since: Option<OffsetDateTime>,
    /// The usage window counters belong to. `None` only when `access` is `None`.
    pub period: Option<Period>,
    pub limits: BTreeMap<String, EntitlementValue>,
}

/// Result of [`Entitlements::check_cap`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum CapCheck {
    /// One more is allowed: `used < limit`.
    Allowed {
        limit: u64,
        used: u64,
    },
    LimitExceeded {
        limit: u64,
        used: u64,
    },
    NotEntitled {
        reason: NotEntitled,
    },
}

impl Entitlements {
    /// Numeric limit for `key`, if the plan has one.
    pub fn limit(&self, key: &str) -> Option<u64> {
        match self.limits.get(key) {
            Some(EntitlementValue::Limit(n)) => Some(*n),
            _ => None,
        }
    }

    /// Boolean flag for `key`, if the plan has one.
    pub fn flag(&self, key: &str) -> Option<bool> {
        match self.limits.get(key) {
            Some(EntitlementValue::Flag(b)) => Some(*b),
            _ => None,
        }
    }

    /// May the tenant add ONE more of a counted resource (legal entity, user, country, API key) given that it currently has
    /// `current`? Pure function of the resolved entitlements.
    pub fn check_cap(&self, key: &str, current: u64) -> CapCheck {
        match self.access {
            Access::None => {
                return CapCheck::NotEntitled {
                    reason: NotEntitled::NoPlan,
                };
            }
            Access::ReadOnly => {
                return CapCheck::NotEntitled {
                    reason: NotEntitled::ReadOnly,
                };
            }
            Access::Full => {}
        }
        match self.limit(key) {
            None => CapCheck::NotEntitled {
                reason: NotEntitled::NotInPlan,
            },
            Some(limit) if current < limit => CapCheck::Allowed {
                limit,
                used: current,
            },
            Some(limit) => CapCheck::LimitExceeded {
                limit,
                used: current,
            },
        }
    }
}

/// Grace policy for resolution.
#[derive(Debug, Clone, Copy)]
pub struct Policy {
    pub past_due_grace: Duration,
}

#[derive(sqlx::FromRow)]
struct SubRow {
    status: String,
    cancel_at_period_end: bool,
    past_due_since: Option<OffsetDateTime>,
    current_period_start: OffsetDateTime,
    current_period_end: OffsetDateTime,
    id: Uuid,
    code: String,
    display_key: String,
    billing_interval: String,
    currency: String,
    unit_amount_minor: i64,
}

#[derive(sqlx::FromRow)]
struct PlanRow {
    id: Uuid,
    code: String,
    display_key: String,
    billing_interval: String,
    currency: String,
    unit_amount_minor: i64,
}

impl From<PlanRow> for PlanSummary {
    fn from(p: PlanRow) -> Self {
        Self {
            id: p.id,
            code: p.code,
            display_key: p.display_key,
            billing_interval: p.billing_interval,
            currency: p.currency,
            unit_amount_minor: p.unit_amount_minor,
        }
    }
}

/// Resolve entitlements on a connection whose transaction is already bound to `tenant` (`app.tenant_id`).
pub(crate) async fn resolve(
    conn: &mut PgConnection,
    tenant: Uuid,
    now: OffsetDateTime,
    policy: Policy,
) -> Result<Entitlements, BillingError> {
    let sub: Option<SubRow> = sqlx::query_as(
        "SELECT s.status, s.cancel_at_period_end, s.past_due_since, s.current_period_start, s.current_period_end,
                p.id, p.code, p.display_key, p.billing_interval, p.currency, p.unit_amount_minor
           FROM billing.subscription AS s JOIN billing.plan AS p ON p.id = s.plan_id
          WHERE s.tenant_id = $1 AND s.status IN ('trialing', 'active', 'past_due')",
    )
    .bind(tenant)
    .fetch_optional(&mut *conn)
    .await?;

    if let Some(s) = sub {
        let (status, access) = access_of(&s, now, policy);
        let (ps, pe): (OffsetDateTime, OffsetDateTime) = sqlx::query_as(
            "SELECT period_start, period_end FROM billing.usage_period($1, $2, $3, $4)",
        )
        .bind(s.current_period_start)
        .bind(s.current_period_end)
        .bind(&s.billing_interval)
        .bind(now)
        .fetch_one(&mut *conn)
        .await?;
        let plan = PlanSummary {
            id: s.id,
            code: s.code,
            display_key: s.display_key,
            billing_interval: s.billing_interval,
            currency: s.currency,
            unit_amount_minor: s.unit_amount_minor,
        };
        let limits = limits_of(conn, plan.id).await?;
        return Ok(Entitlements {
            plan: Some(plan),
            source: PlanSource::Subscription,
            status: Some(status),
            access,
            cancel_at_period_end: s.cancel_at_period_end,
            past_due_since: s.past_due_since,
            period: Some(Period { start: ps, end: pe }),
            limits,
        });
    }

    let fallback: Option<PlanRow> = sqlx::query_as(
        "SELECT id, code, display_key, billing_interval, currency, unit_amount_minor
           FROM billing.plan
          WHERE is_fallback AND valid_from <= $1 AND (valid_to IS NULL OR valid_to > $1)",
    )
    .bind(now)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(plan) = fallback else {
        return Ok(Entitlements {
            plan: None,
            source: PlanSource::None,
            status: None,
            access: Access::None,
            cancel_at_period_end: false,
            past_due_since: None,
            period: None,
            limits: BTreeMap::new(),
        });
    };
    // the fallback plan's window is the UTC calendar month
    let (ps, pe): (OffsetDateTime, OffsetDateTime) = sqlx::query_as(
        "SELECT date_trunc('month', $1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
                (date_trunc('month', $1::timestamptz AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC'",
    )
    .bind(now)
    .fetch_one(&mut *conn)
    .await?;
    let plan: PlanSummary = plan.into();
    let limits = limits_of(conn, plan.id).await?;
    Ok(Entitlements {
        plan: Some(plan),
        source: PlanSource::Fallback,
        status: None,
        access: Access::Full,
        cancel_at_period_end: false,
        past_due_since: None,
        period: Some(Period { start: ps, end: pe }),
        limits,
    })
}

fn access_of(s: &SubRow, now: OffsetDateTime, policy: Policy) -> (SubscriptionStatus, Access) {
    let status = match s.status.as_str() {
        "trialing" => SubscriptionStatus::Trialing,
        "past_due" => SubscriptionStatus::PastDue,
        _ => SubscriptionStatus::Active,
    };
    let overdue = status == SubscriptionStatus::PastDue
        && s.past_due_since
            .is_none_or(|since| now >= since + policy.past_due_grace);
    let stale = now >= s.current_period_end + policy.past_due_grace;
    (
        status,
        if overdue || stale {
            Access::ReadOnly
        } else {
            Access::Full
        },
    )
}

async fn limits_of(
    conn: &mut PgConnection,
    plan: Uuid,
) -> Result<BTreeMap<String, EntitlementValue>, BillingError> {
    let rows: Vec<(String, Option<i64>, Option<bool>)> = sqlx::query_as(
        "SELECT key, int_value, bool_value FROM billing.plan_entitlement WHERE plan_id = $1 ORDER BY key",
    )
    .bind(plan)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(k, i, b)| {
            let v = match (i, b) {
                (Some(n), None) => EntitlementValue::Limit(u64::try_from(n).ok()?),
                (None, Some(f)) => EntitlementValue::Flag(f),
                _ => return None,
            };
            Some((k, v))
        })
        .collect())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn ent(access: Access, limits: &[(&str, EntitlementValue)]) -> Entitlements {
        Entitlements {
            plan: None,
            source: PlanSource::Subscription,
            status: Some(SubscriptionStatus::Active),
            access,
            cancel_at_period_end: false,
            past_due_since: None,
            period: None,
            limits: limits.iter().map(|(k, v)| ((*k).to_string(), *v)).collect(),
        }
    }

    #[test]
    fn caps_allow_until_the_limit_is_reached() {
        let e = ent(Access::Full, &[(keys::USERS, EntitlementValue::Limit(3))]);
        assert_eq!(
            e.check_cap(keys::USERS, 2),
            CapCheck::Allowed { limit: 3, used: 2 }
        );
        assert_eq!(
            e.check_cap(keys::USERS, 3),
            CapCheck::LimitExceeded { limit: 3, used: 3 }
        );
        assert_eq!(
            e.check_cap(keys::API_KEYS, 0),
            CapCheck::NotEntitled {
                reason: NotEntitled::NotInPlan
            }
        );
    }

    #[test]
    fn caps_are_denied_without_full_access() {
        let limits = [(keys::USERS, EntitlementValue::Limit(3))];
        assert_eq!(
            ent(Access::ReadOnly, &limits).check_cap(keys::USERS, 0),
            CapCheck::NotEntitled {
                reason: NotEntitled::ReadOnly
            }
        );
        assert_eq!(
            ent(Access::None, &limits).check_cap(keys::USERS, 0),
            CapCheck::NotEntitled {
                reason: NotEntitled::NoPlan
            }
        );
    }

    #[test]
    fn a_boolean_is_not_a_numeric_limit() {
        let e = ent(
            Access::Full,
            &[(keys::SUPPORT_TIER, EntitlementValue::Flag(true))],
        );
        assert_eq!(e.limit(keys::SUPPORT_TIER), None);
        assert_eq!(e.flag(keys::SUPPORT_TIER), Some(true));
        assert_eq!(
            e.check_cap(keys::SUPPORT_TIER, 0),
            CapCheck::NotEntitled {
                reason: NotEntitled::NotInPlan
            }
        );
    }
}
