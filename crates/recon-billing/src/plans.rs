//! Plan seeding. Prices and limits are DATA: an operator inserts plan rows (this module, or the `recon-billing-seed`
//! binary) after the commercial decision; the code contains no price.
//!
//! A plan row is immutable. A new price or new limits mean a new row; the old row is retired with [`retire_plan`] (its
//! `valid_to`), and existing subscriptions keep the row they were sold on. The functions run as the `w_billing_admin` role
//! (`billing.create_plan` / `billing.retire_plan` are granted to nobody else).

use crate::entitlements::keys;
use crate::error::BillingError;
use recon_store::WriteStore;
use serde::Deserialize;
use std::collections::BTreeMap;
use time::OffsetDateTime;
use uuid::Uuid;

/// One entitlement in a plan definition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum Entitlement {
    Limit(u64),
    Flag(bool),
}

/// A plan to insert. Field names match the JSON seed file.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewPlan {
    /// Stable code, `^[a-z0-9][a-z0-9_-]{0,47}$`.
    pub code: String,
    /// i18n key of the display name (the frontend resolves the text; no text lives here).
    pub display_key: String,
    /// `month` or `year`.
    pub billing_interval: String,
    /// ISO 4217, upper case.
    pub currency: String,
    /// Price in minor units (cents). 0 for the fallback plan.
    pub unit_amount_minor: i64,
    #[serde(default)]
    pub is_public: bool,
    /// The plan applied to tenants without a subscription (free/sandbox). At most one open-ended fallback plan exists.
    #[serde(default)]
    pub is_fallback: bool,
    #[serde(default)]
    pub sort_order: i32,
    /// Stripe Price id for Checkout. Required for a plan that can be bought; absent for the fallback plan.
    #[serde(default)]
    pub provider_price_id: Option<String>,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub valid_from: Option<OffsetDateTime>,
    /// Entitlement key → numeric limit or boolean. Keys must be in [`keys::ALL`].
    pub entitlements: BTreeMap<String, Entitlement>,
}

/// The seed file: `{"plans": [ … ]}`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeedFile {
    pub plans: Vec<NewPlan>,
}

impl NewPlan {
    /// Reject what the database would reject, and unknown entitlement keys (a typo would silently grant nothing).
    pub fn validate(&self) -> Result<(), BillingError> {
        if let Some(k) = self
            .entitlements
            .keys()
            .find(|k| !keys::ALL.contains(&k.as_str()))
        {
            eprintln!("billing: unknown entitlement key `{k}`");
            return Err(BillingError::Invalid("unknown entitlement key"));
        }
        if self
            .entitlements
            .iter()
            .any(|(_, v)| matches!(v, Entitlement::Limit(n) if i64::try_from(*n).is_err()))
        {
            return Err(BillingError::Invalid("entitlement limit out of range"));
        }
        if self.is_fallback && self.is_public {
            return Err(BillingError::Invalid(
                "a fallback plan is not a purchasable public plan",
            ));
        }
        if !self.is_fallback && self.unit_amount_minor > 0 && self.provider_price_id.is_none() {
            return Err(BillingError::Invalid(
                "a priced plan needs provider_price_id",
            ));
        }
        Ok(())
    }
}

/// Insert a plan with its entitlements in one transaction; returns its id.
pub async fn create_plan(admin: &WriteStore, plan: &NewPlan) -> Result<Uuid, BillingError> {
    plan.validate()?;
    let ents: serde_json::Map<String, serde_json::Value> = plan
        .entitlements
        .iter()
        .map(|(k, v)| {
            (
                k.clone(),
                match v {
                    Entitlement::Limit(n) => serde_json::Value::from(*n),
                    Entitlement::Flag(b) => serde_json::Value::from(*b),
                },
            )
        })
        .collect();
    let mut tx = admin.begin_unbound().await?;
    let id: Uuid = sqlx::query_scalar(
        "SELECT billing.create_plan($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    )
    .bind(&plan.code)
    .bind(&plan.display_key)
    .bind(&plan.billing_interval)
    .bind(&plan.currency)
    .bind(plan.unit_amount_minor)
    .bind(plan.is_public)
    .bind(plan.is_fallback)
    .bind(plan.sort_order)
    .bind(plan.provider_price_id.as_deref())
    .bind(plan.valid_from)
    .bind(serde_json::Value::Object(ents))
    .fetch_one(tx.conn())
    .await?;
    tx.commit().await?;
    Ok(id)
}

/// Retire a plan from `valid_to` (default: now). Returns `false` if it was not found or already retired.
pub async fn retire_plan(
    admin: &WriteStore,
    plan: Uuid,
    valid_to: Option<OffsetDateTime>,
) -> Result<bool, BillingError> {
    let mut tx = admin.begin_unbound().await?;
    let done: bool = sqlx::query_scalar("SELECT billing.retire_plan($1, $2)")
        .bind(plan)
        .bind(valid_to)
        .fetch_one(tx.conn())
        .await?;
    tx.commit().await?;
    Ok(done)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn plan(json: &str) -> NewPlan {
        serde_json::from_str(json).unwrap()
    }

    const BASE: &str = r#"{"code":"x","display_key":"billing.plan.x","billing_interval":"month","currency":"EUR",
        "unit_amount_minor":100,"provider_price_id":"price_1","entitlements":{"runs_per_month":5,"users":true}}"#;

    #[test]
    fn a_valid_definition_parses_numbers_and_flags() {
        let p = plan(BASE);
        assert_eq!(p.entitlements["runs_per_month"], Entitlement::Limit(5));
        assert_eq!(p.entitlements["users"], Entitlement::Flag(true));
        p.validate().unwrap();
    }

    #[test]
    fn typos_and_inconsistent_plans_are_rejected() {
        assert!(
            plan(&BASE.replace("runs_per_month", "runs_per_monht"))
                .validate()
                .is_err()
        );
        assert!(
            plan(&BASE.replace("\"provider_price_id\":\"price_1\",", ""))
                .validate()
                .is_err()
        );
        let fallback_public = BASE.replace(
            "\"unit_amount_minor\":100,",
            "\"unit_amount_minor\":0,\"is_fallback\":true,\"is_public\":true,",
        );
        assert!(plan(&fallback_public).validate().is_err());
        assert!(
            serde_json::from_str::<NewPlan>(
                &BASE.replace("\"code\"", "\"colour\":\"red\",\"code\"")
            )
            .is_err()
        );
    }
}
