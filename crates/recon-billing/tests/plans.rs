//! Plan catalogue: seeding through the operator role, immutability, single fallback plan. Real PostgreSQL 18.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::{PlanSpec, fx};
use recon_billing::keys;
use recon_billing::plans::{Entitlement, NewPlan, create_plan, retire_plan};
use std::collections::BTreeMap;

async fn fails(f: &common::Fx, sql: &'static str, needle: &str) {
    let err = sqlx::query(sql)
        .execute(&f.admin)
        .await
        .unwrap_err()
        .to_string();
    assert!(
        err.contains(needle),
        "`{sql}`: expected `{needle}` in `{err}`"
    );
}

#[tokio::test]
async fn a_plan_row_cannot_be_changed_a_new_price_is_a_new_row() {
    let f = fx().await;
    let id = f
        .plan(PlanSpec {
            code: "pro",
            interval: "month",
            price: Some("price_pro"),
            fallback: false,
            limits: &[(keys::RUNS_PER_MONTH, 100)],
        })
        .await;

    // even the superuser path (owner, triggers fire for everyone): price, limits, identity never change
    fails(
        &f,
        "UPDATE billing.plan SET unit_amount_minor = unit_amount_minor + 1",
        "immutable",
    )
    .await;
    fails(
        &f,
        "UPDATE billing.plan SET provider_price_id = 'price_other'",
        "immutable",
    )
    .await;
    fails(&f, "UPDATE billing.plan SET code = 'renamed'", "immutable").await;
    fails(&f, "DELETE FROM billing.plan", "append-only").await;
    fails(&f, "TRUNCATE billing.plan_entitlement", "append-only").await;
    fails(
        &f,
        "UPDATE billing.plan_entitlement SET int_value = 1000000",
        "append-only",
    )
    .await;
    fails(&f, "DELETE FROM billing.plan_entitlement", "append-only").await;

    // presentation fields may change
    sqlx::query("UPDATE billing.plan SET sort_order = 5, is_public = false")
        .execute(&f.admin)
        .await
        .unwrap();
    // retirement sets valid_to once
    assert!(retire_plan(&f.plans, id, None).await.unwrap());
    assert!(
        !retire_plan(&f.plans, id, None).await.unwrap(),
        "already retired"
    );
    fails(&f, "UPDATE billing.plan SET valid_to = NULL", "already set").await;

    // a new price is a new row; the old row and its limits are untouched
    // (same code, later valid_from: the unique key is (code, interval, currency, valid_from))
    let successor = NewPlan {
        code: "pro".into(),
        display_key: "billing.plan.pro".into(),
        billing_interval: "month".into(),
        currency: "EUR".into(),
        unit_amount_minor: 200,
        is_public: true,
        is_fallback: false,
        sort_order: 0,
        provider_price_id: Some("price_pro_v2".into()),
        valid_from: Some(common::at("2026-01-01T00:00:00Z")),
        entitlements: BTreeMap::from([(keys::RUNS_PER_MONTH.to_string(), Entitlement::Limit(200))]),
    };
    let new = create_plan(&f.plans, &successor).await.unwrap();
    assert_ne!(new, id);
    let limits: Vec<i64> =
        sqlx::query_scalar("SELECT int_value FROM billing.plan_entitlement ORDER BY int_value")
            .fetch_all(&f.admin)
            .await
            .unwrap();
    assert_eq!(limits, [100, 200]);
    f.cleanup().await;
}

#[tokio::test]
async fn seeding_validates_and_there_is_at_most_one_open_fallback_plan() {
    let f = fx().await;
    let base = |code: &str| NewPlan {
        code: code.into(),
        display_key: format!("billing.plan.{code}"),
        billing_interval: "month".into(),
        currency: "EUR".into(),
        unit_amount_minor: 0,
        is_public: false,
        is_fallback: true,
        sort_order: 0,
        provider_price_id: None,
        valid_from: None,
        entitlements: BTreeMap::from([
            (keys::RUNS_PER_MONTH.to_string(), Entitlement::Limit(3)),
            (keys::SUPPORT_TIER.to_string(), Entitlement::Limit(0)),
        ]),
    };
    create_plan(&f.plans, &base("sandbox")).await.unwrap();
    // a second open-ended fallback plan is refused by the database
    let err = create_plan(&f.plans, &base("sandbox2"))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("plan_single_open_fallback"), "{err}");
    // unknown keys never reach the database
    let mut typo = base("typo");
    typo.is_fallback = false;
    typo.unit_amount_minor = 0;
    typo.entitlements
        .insert("runs_per_monht".into(), Entitlement::Limit(1));
    assert!(create_plan(&f.plans, &typo).await.is_err());
    // a malformed currency or interval is refused by the CHECK constraints
    let mut bad = base("bad");
    bad.is_fallback = false;
    bad.currency = "eur".into();
    assert!(create_plan(&f.plans, &bad).await.is_err());
    // nothing was left behind by the failed attempts (single transaction)
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM billing.plan")
        .fetch_one(&f.admin)
        .await
        .unwrap();
    assert_eq!(n, 1);
    // a fallback plan must be free and have no provider price
    let mut priced = base("priced");
    priced.unit_amount_minor = 500;
    assert!(create_plan(&f.plans, &priced).await.is_err());
    f.cleanup().await;
}
