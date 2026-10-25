//! Entitlements and metered consumption against a real PostgreSQL 18 (see tests/common/mod.rs).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::{PlanSpec, at, fx};
use recon_billing::entitlements::{Access, EntitlementValue, PlanSource};
use recon_billing::{Billing, BillingError, CapCheck, Consume, NotEntitled, Policy, keys};
use time::Duration;

fn billing(f: &common::Fx) -> Billing {
    Billing::new(
        f.cmd.clone(),
        Policy {
            past_due_grace: Duration::days(14),
        },
    )
}

const T0: &str = "2026-03-10T12:00:00Z";

#[tokio::test]
async fn no_subscription_and_no_fallback_plan_denies_everything() {
    let f = fx().await;
    let tenant = f.tenant().await;
    let b = billing(&f);

    let e = b.entitlements_at(tenant, at(T0)).await.unwrap();
    assert_eq!((e.access, e.source), (Access::None, PlanSource::None));
    assert!(e.plan.is_none() && e.limits.is_empty() && e.period.is_none());
    assert_eq!(
        b.check_and_consume_at(tenant, keys::RUNS_PER_MONTH, 1, "k1", at(T0))
            .await
            .unwrap(),
        Consume::NotEntitled {
            reason: NotEntitled::NoPlan
        }
    );
    assert_eq!(
        e.check_cap(keys::USERS, 0),
        CapCheck::NotEntitled {
            reason: NotEntitled::NoPlan
        }
    );
    // nothing was recorded
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM billing.usage_consumption")
        .fetch_one(&f.admin)
        .await
        .unwrap();
    assert_eq!(n, 0);

    // a paid plan that exists but is not subscribed to does not change that
    f.plan(PlanSpec {
        code: "pro",
        interval: "month",
        price: Some("price_pro"),
        fallback: false,
        limits: &[(keys::RUNS_PER_MONTH, 100)],
    })
    .await;
    assert_eq!(
        b.entitlements_at(tenant, at(T0)).await.unwrap().access,
        Access::None
    );
    f.cleanup().await;
}

#[tokio::test]
async fn the_fallback_plan_applies_only_when_it_exists_and_counts_per_calendar_month() {
    let f = fx().await;
    let tenant = f.tenant().await;
    let b = billing(&f);
    f.plan(PlanSpec {
        code: "sandbox",
        interval: "month",
        price: None,
        fallback: true,
        limits: &[(keys::RUNS_PER_MONTH, 2), (keys::USERS, 1)],
    })
    .await;

    let e = b.entitlements_at(tenant, at(T0)).await.unwrap();
    assert_eq!((e.access, e.source), (Access::Full, PlanSource::Fallback));
    let p = e.period.unwrap();
    assert_eq!(
        (p.start, p.end),
        (at("2026-03-01T00:00:00Z"), at("2026-04-01T00:00:00Z"))
    );
    assert_eq!(e.limit(keys::USERS), Some(1));
    assert_eq!(
        e.check_cap(keys::USERS, 0),
        CapCheck::Allowed { limit: 1, used: 0 }
    );
    assert_eq!(
        e.check_cap(keys::USERS, 1),
        CapCheck::LimitExceeded { limit: 1, used: 1 }
    );

    for (k, want) in [("a", 1), ("b", 2)] {
        assert_eq!(
            b.check_and_consume_at(tenant, keys::RUNS_PER_MONTH, 1, k, at(T0))
                .await
                .unwrap(),
            Consume::Allowed {
                limit: 2,
                used: want,
                replayed: false
            }
        );
    }
    assert_eq!(
        b.check_and_consume_at(tenant, keys::RUNS_PER_MONTH, 1, "c", at(T0))
            .await
            .unwrap(),
        Consume::LimitExceeded { limit: 2, used: 2 }
    );
    // a metric the plan does not carry is denied, not unlimited
    assert_eq!(
        b.check_and_consume_at(tenant, keys::RECORDS_PER_MONTH, 1, "d", at(T0))
            .await
            .unwrap(),
        Consume::NotEntitled {
            reason: NotEntitled::NotInPlan
        }
    );
    // next calendar month: a fresh counter
    assert_eq!(
        b.check_and_consume_at(
            tenant,
            keys::RUNS_PER_MONTH,
            1,
            "e",
            at("2026-04-02T00:00:00Z")
        )
        .await
        .unwrap(),
        Consume::Allowed {
            limit: 2,
            used: 1,
            replayed: false
        }
    );
    f.cleanup().await;
}

#[tokio::test]
async fn concurrent_consumers_never_exceed_the_limit() {
    let f = fx().await;
    let tenant = f.tenant().await;
    let b = billing(&f);
    let plan = f
        .plan(PlanSpec {
            code: "pro",
            interval: "month",
            price: Some("price_pro"),
            fallback: false,
            limits: &[(keys::RECORDS_PER_MONTH, 50)],
        })
        .await;
    f.subscription(
        tenant,
        plan,
        "active",
        "2026-03-01T00:00:00Z",
        "2026-04-01T00:00:00Z",
        None,
    )
    .await;

    // 120 parallel callers, each wants 1; the limit is 50
    let mut tasks = Vec::new();
    for i in 0..120 {
        let b = b.clone();
        tasks.push(tokio::spawn(async move {
            b.check_and_consume_at(
                tenant,
                keys::RECORDS_PER_MONTH,
                1,
                &format!("c-{i}"),
                at(T0),
            )
            .await
            .unwrap()
        }));
    }
    let mut allowed = 0;
    let mut denied = 0;
    let mut seen_used = std::collections::BTreeSet::new();
    for t in tasks {
        match t.await.unwrap() {
            Consume::Allowed {
                used,
                replayed: false,
                ..
            } => {
                allowed += 1;
                assert!(
                    seen_used.insert(used),
                    "two callers were told the same counter value {used}"
                );
            }
            Consume::LimitExceeded { limit: 50, .. } => denied += 1,
            other => panic!("unexpected {other:?}"),
        }
    }
    assert_eq!((allowed, denied), (50, 70));
    assert_eq!(seen_used.iter().copied().max(), Some(50));
    let (q, rows): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT quantity FROM billing.usage_counter WHERE metric = 'records_per_month'),
                (SELECT count(*) FROM billing.usage_consumption)",
    )
    .fetch_one(&f.admin)
    .await
    .unwrap();
    assert_eq!(
        (q, rows),
        (50, 50),
        "counter and idempotency records agree; denied calls leave no claim behind"
    );

    // mixed amounts racing for the remaining headroom never overshoot either
    let b2 = b.clone();
    let tenant2 = f.tenant().await;
    f.subscription(
        tenant2,
        plan,
        "active",
        "2026-03-01T00:00:00Z",
        "2026-04-01T00:00:00Z",
        None,
    )
    .await;
    let mut tasks = Vec::new();
    for i in 0..60u64 {
        let b = b2.clone();
        tasks.push(tokio::spawn(async move {
            b.check_and_consume_at(
                tenant2,
                keys::RECORDS_PER_MONTH,
                1 + i % 7,
                &format!("m-{i}"),
                at(T0),
            )
            .await
            .unwrap()
        }));
    }
    let mut total = 0u64;
    for (i, t) in tasks.into_iter().enumerate() {
        if let Consume::Allowed { .. } = t.await.unwrap() {
            total += 1 + (i as u64) % 7;
        }
    }
    let q: i64 =
        sqlx::query_scalar("SELECT quantity FROM billing.usage_counter WHERE tenant_id = $1")
            .bind(tenant2)
            .fetch_one(&f.admin)
            .await
            .unwrap();
    assert!(
        q <= 50 && q as u64 == total,
        "counter {q} must equal the accepted total {total} and stay <= 50"
    );
    f.cleanup().await;
}

#[tokio::test]
async fn retries_with_the_same_idempotency_key_count_once() {
    let f = fx().await;
    let tenant = f.tenant().await;
    let b = billing(&f);
    let plan = f
        .plan(PlanSpec {
            code: "pro",
            interval: "month",
            price: Some("price_pro"),
            fallback: false,
            limits: &[(keys::RUNS_PER_MONTH, 5)],
        })
        .await;
    f.subscription(
        tenant,
        plan,
        "active",
        "2026-03-01T00:00:00Z",
        "2026-04-01T00:00:00Z",
        None,
    )
    .await;

    // 30 concurrent deliveries of the SAME request
    let mut tasks = Vec::new();
    for _ in 0..30 {
        let b = b.clone();
        tasks.push(tokio::spawn(async move {
            b.check_and_consume_at(tenant, keys::RUNS_PER_MONTH, 2, "run-42", at(T0))
                .await
                .unwrap()
        }));
    }
    let (mut fresh, mut replayed) = (0, 0);
    for t in tasks {
        match t.await.unwrap() {
            Consume::Allowed {
                used: 2,
                replayed: false,
                ..
            } => fresh += 1,
            Consume::Allowed {
                used: 2,
                replayed: true,
                ..
            } => replayed += 1,
            other => panic!("unexpected {other:?}"),
        }
    }
    assert_eq!((fresh, replayed), (1, 29));
    let q: i64 = sqlx::query_scalar("SELECT quantity FROM billing.usage_counter")
        .fetch_one(&f.admin)
        .await
        .unwrap();
    assert_eq!(q, 2);

    // same key, different amount: refused, nothing changes
    assert!(matches!(
        b.check_and_consume_at(tenant, keys::RUNS_PER_MONTH, 3, "run-42", at(T0))
            .await,
        Err(BillingError::IdempotencyKeyReused)
    ));
    // a denied call can be retried later with the same key (nothing was recorded for it)
    assert_eq!(
        b.check_and_consume_at(tenant, keys::RUNS_PER_MONTH, 4, "big", at(T0))
            .await
            .unwrap(),
        Consume::LimitExceeded { limit: 5, used: 2 }
    );
    assert_eq!(
        b.check_and_consume_at(tenant, keys::RUNS_PER_MONTH, 3, "big", at(T0))
            .await
            .unwrap(),
        Consume::Allowed {
            limit: 5,
            used: 5,
            replayed: false
        }
    );
    // invalid input is rejected before touching the database
    for (metric, amount, key) in [
        ("Runs", 1, "k"),
        ("runs_per_month", 0, "k"),
        ("runs_per_month", 1, ""),
    ] {
        assert!(matches!(
            b.check_and_consume_at(tenant, metric, amount, key, at(T0))
                .await,
            Err(BillingError::Invalid(_))
        ));
    }
    f.cleanup().await;
}

#[tokio::test]
async fn the_window_follows_the_subscription_period_and_rolls_over_when_the_renewal_is_late() {
    let f = fx().await;
    let tenant = f.tenant().await;
    let b = billing(&f);
    let plan = f
        .plan(PlanSpec {
            code: "pro",
            interval: "month",
            price: Some("price_pro"),
            fallback: false,
            limits: &[(keys::RUNS_PER_MONTH, 3)],
        })
        .await;
    // a billing cycle anchored on the 15th
    f.subscription(
        tenant,
        plan,
        "active",
        "2026-03-15T08:30:00Z",
        "2026-04-15T08:30:00Z",
        None,
    )
    .await;

    let e = b
        .entitlements_at(tenant, at("2026-03-20T00:00:00Z"))
        .await
        .unwrap();
    let p = e.period.unwrap();
    assert_eq!(
        (p.start, p.end),
        (at("2026-03-15T08:30:00Z"), at("2026-04-15T08:30:00Z"))
    );
    for (k, want) in [("a", 1), ("b", 2), ("c", 3)] {
        assert_eq!(
            b.check_and_consume_at(
                tenant,
                keys::RUNS_PER_MONTH,
                1,
                k,
                at("2026-03-20T00:00:00Z")
            )
            .await
            .unwrap(),
            Consume::Allowed {
                limit: 3,
                used: want,
                replayed: false
            }
        );
    }
    assert!(matches!(
        b.check_and_consume_at(
            tenant,
            keys::RUNS_PER_MONTH,
            1,
            "d",
            at("2026-04-15T08:29:59Z")
        )
        .await
        .unwrap(),
        Consume::LimitExceeded { .. }
    ));
    // the period ended and the renewal webhook has not arrived: the window rolls forward, counters start at zero
    let late = at("2026-04-16T00:00:00Z");
    let e = b.entitlements_at(tenant, late).await.unwrap();
    let p = e.period.unwrap();
    assert_eq!(
        (p.start, p.end),
        (at("2026-04-15T08:30:00Z"), at("2026-05-15T08:30:00Z"))
    );
    assert_eq!(e.access, Access::Full);
    assert_eq!(
        b.check_and_consume_at(tenant, keys::RUNS_PER_MONTH, 1, "e", late)
            .await
            .unwrap(),
        Consume::Allowed {
            limit: 3,
            used: 1,
            replayed: false
        }
    );
    // exactly on the boundary belongs to the new window; several windows later still resolves
    let p = b
        .entitlements_at(tenant, at("2026-05-15T08:30:00Z"))
        .await
        .unwrap()
        .period
        .unwrap();
    assert_eq!(
        (p.start, p.end),
        (at("2026-05-15T08:30:00Z"), at("2026-06-15T08:30:00Z"))
    );
    let p = b
        .entitlements_at(tenant, at("2026-04-20T00:00:00Z"))
        .await
        .unwrap()
        .period
        .unwrap();
    assert_eq!(p.start, at("2026-04-15T08:30:00Z"));

    // yearly plans roll by years
    let tenant_y = f.tenant().await;
    let yearly = f
        .plan(PlanSpec {
            code: "pro",
            interval: "year",
            price: Some("price_pro_y"),
            fallback: false,
            limits: &[(keys::RUNS_PER_MONTH, 3)],
        })
        .await;
    f.subscription(
        tenant_y,
        yearly,
        "active",
        "2026-01-31T00:00:00Z",
        "2027-01-31T00:00:00Z",
        None,
    )
    .await;
    let p = b
        .entitlements_at(tenant_y, at("2027-03-01T00:00:00Z"))
        .await
        .unwrap()
        .period
        .unwrap();
    assert_eq!(
        (p.start, p.end),
        (at("2027-01-31T00:00:00Z"), at("2028-01-31T00:00:00Z"))
    );
    f.cleanup().await;
}

#[tokio::test]
async fn past_due_keeps_working_during_the_grace_then_becomes_read_only_and_nothing_is_deleted() {
    let f = fx().await;
    let tenant = f.tenant().await;
    let b = billing(&f);
    let plan = f
        .plan(PlanSpec {
            code: "pro",
            interval: "month",
            price: Some("price_pro"),
            fallback: false,
            limits: &[(keys::RUNS_PER_MONTH, 10)],
        })
        .await;
    f.subscription(
        tenant,
        plan,
        "past_due",
        "2026-03-01T00:00:00Z",
        "2026-04-01T00:00:00Z",
        Some("2026-03-10T00:00:00Z"),
    )
    .await;

    // inside the 14-day window
    assert_eq!(
        b.check_and_consume_at(
            tenant,
            keys::RUNS_PER_MONTH,
            1,
            "a",
            at("2026-03-23T23:59:59Z")
        )
        .await
        .unwrap(),
        Consume::Allowed {
            limit: 10,
            used: 1,
            replayed: false
        }
    );
    // after it: read-only, entitlements still describe the plan
    let after = at("2026-03-24T00:00:00Z");
    let e = b.entitlements_at(tenant, after).await.unwrap();
    assert_eq!(e.access, Access::ReadOnly);
    assert_eq!(
        e.limits.get(keys::RUNS_PER_MONTH),
        Some(&EntitlementValue::Limit(10))
    );
    assert_eq!(
        b.check_and_consume_at(tenant, keys::RUNS_PER_MONTH, 1, "b", after)
            .await
            .unwrap(),
        Consume::NotEntitled {
            reason: NotEntitled::ReadOnly
        }
    );
    assert_eq!(
        e.check_cap(keys::RUNS_PER_MONTH, 0),
        CapCheck::NotEntitled {
            reason: NotEntitled::ReadOnly
        }
    );
    // the counter and the claim from before are untouched
    let q: i64 = sqlx::query_scalar("SELECT quantity FROM billing.usage_counter")
        .fetch_one(&f.admin)
        .await
        .unwrap();
    assert_eq!(q, 1);

    // a stricter policy is honoured
    let strict = Billing::new(
        f.cmd.clone(),
        Policy {
            past_due_grace: Duration::days(1),
        },
    );
    assert_eq!(
        strict
            .entitlements_at(tenant, at("2026-03-12T00:00:00Z"))
            .await
            .unwrap()
            .access,
        Access::ReadOnly
    );

    // an active subscription whose period ended long ago without any renewal event is not trusted forever
    let stale_tenant = f.tenant().await;
    f.subscription(
        stale_tenant,
        plan,
        "active",
        "2026-01-01T00:00:00Z",
        "2026-02-01T00:00:00Z",
        None,
    )
    .await;
    assert_eq!(
        b.entitlements_at(stale_tenant, at("2026-02-10T00:00:00Z"))
            .await
            .unwrap()
            .access,
        Access::Full
    );
    assert_eq!(
        b.entitlements_at(stale_tenant, at("2026-02-15T00:00:00Z"))
            .await
            .unwrap()
            .access,
        Access::ReadOnly
    );

    // canceled / incomplete subscriptions grant nothing (and without a fallback plan: no plan at all)
    let canceled = f.tenant().await;
    f.subscription(
        canceled,
        plan,
        "canceled",
        "2026-03-01T00:00:00Z",
        "2026-04-01T00:00:00Z",
        None,
    )
    .await;
    assert_eq!(
        b.entitlements_at(canceled, at(T0)).await.unwrap().access,
        Access::None
    );
    let incomplete = f.tenant().await;
    f.subscription(
        incomplete,
        plan,
        "incomplete",
        "2026-03-01T00:00:00Z",
        "2026-04-01T00:00:00Z",
        None,
    )
    .await;
    assert_eq!(
        b.entitlements_at(incomplete, at(T0)).await.unwrap().access,
        Access::None
    );
    f.cleanup().await;
}
