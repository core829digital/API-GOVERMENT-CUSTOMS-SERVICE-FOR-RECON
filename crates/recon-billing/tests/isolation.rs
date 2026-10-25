//! Tenant isolation (RLS, fail-closed binding) and role grants of the billing schema, as the NON-superuser application
//! role. Real PostgreSQL 18 (tests/common/mod.rs).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::{PlanSpec, at, fx};
use recon_billing::{Billing, Consume, Policy, keys};
use time::Duration;
use uuid::Uuid;

async fn seed_tenant(f: &common::Fx, plan: Uuid, tag: &str) -> Uuid {
    let tenant = f.tenant().await;
    f.subscription(
        tenant,
        plan,
        "active",
        "2026-03-01T00:00:00Z",
        "2026-04-01T00:00:00Z",
        None,
    )
    .await;
    sqlx::query(
        "INSERT INTO billing.invoice_ref(tenant_id, provider_invoice_id, number, amount_minor, currency, status, provider_event_created)
         VALUES ($1, $2, $3, 4900, 'EUR', 'paid', now())",
    )
    .bind(tenant)
    .bind(format!("in_{}", tenant.simple()))
    .bind(format!("INV-{tag}"))
    .execute(&f.admin)
    .await
    .unwrap();
    tenant
}

async fn visible(f: &common::Fx, bound: Uuid, sql: &str) -> i64 {
    let mut tx = f.cmd.begin_tenant(bound).await.unwrap();
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(tx.conn())
        .await
        .unwrap()
}

#[tokio::test]
async fn a_tenant_cannot_read_or_touch_another_tenants_billing_rows() {
    let f = fx().await;
    let plan = f
        .plan(PlanSpec {
            code: "pro",
            interval: "month",
            price: Some("price_pro"),
            fallback: false,
            limits: &[(keys::RUNS_PER_MONTH, 5)],
        })
        .await;
    let a = seed_tenant(&f, plan, "A").await;
    let b = seed_tenant(&f, plan, "B").await;
    let billing = Billing::new(
        f.cmd.clone(),
        Policy {
            past_due_grace: Duration::days(14),
        },
    );
    let now = at("2026-03-10T00:00:00Z");
    assert!(matches!(
        billing
            .check_and_consume_at(a, keys::RUNS_PER_MONTH, 3, "a-run", now)
            .await
            .unwrap(),
        Consume::Allowed { used: 3, .. }
    ));

    // as tenant B, every tenant table shows only B's rows
    for table in ["billing.subscription", "billing.invoice_ref"] {
        assert_eq!(
            visible(&f, b, &format!("SELECT count(*) FROM {table}")).await,
            1,
            "{table}"
        );
        assert_eq!(
            visible(
                &f,
                b,
                &format!("SELECT count(*) FROM {table} WHERE tenant_id = '{a}'")
            )
            .await,
            0,
            "{table}"
        );
    }
    assert_eq!(
        visible(&f, b, "SELECT count(*) FROM billing.usage_counter").await,
        0,
        "A's usage is invisible to B"
    );
    assert_eq!(
        visible(&f, a, "SELECT count(*) FROM billing.usage_counter").await,
        1
    );
    // the library, as B, sees none of A's subscription, usage or invoices
    let ov = billing.overview_at(b, now).await.unwrap();
    assert_eq!(ov.invoices.len(), 1);
    assert_eq!(ov.invoices[0].number.as_deref(), Some("INV-B"));
    assert!(ov.usage.is_empty());
    assert_eq!(
        billing.overview_at(a, now).await.unwrap().usage[keys::RUNS_PER_MONTH],
        3
    );

    // writes cannot cross tenants: consuming for A while the transaction is bound to B is refused by the function
    let mut tx = f.cmd.begin_tenant(b).await.unwrap();
    let err =
        sqlx::query("SELECT * FROM billing.consume_usage($1, 'runs_per_month', 1, 'x', now(), 5)")
            .bind(a)
            .fetch_all(tx.conn())
            .await
            .unwrap_err();
    assert!(
        err.to_string().contains("tenant context is not bound"),
        "{err}"
    );
    drop(tx);
    // a direct UPDATE from B's transaction is refused outright: the application role has no UPDATE privilege at all
    let mut tx = f.cmd.begin_tenant(b).await.unwrap();
    assert!(
        sqlx::query("UPDATE billing.subscription SET plan_id = plan_id")
            .execute(tx.conn())
            .await
            .is_err()
    );
    drop(tx);
    f.cleanup().await;
}

#[tokio::test]
async fn an_unbound_transaction_fails_closed() {
    let f = fx().await;
    let plan = f
        .plan(PlanSpec {
            code: "pro",
            interval: "month",
            price: Some("price_pro"),
            fallback: false,
            limits: &[(keys::RUNS_PER_MONTH, 5)],
        })
        .await;
    let _ = seed_tenant(&f, plan, "A").await;
    for table in [
        "billing.subscription",
        "billing.invoice_ref",
        "billing.usage_counter",
    ] {
        let mut tx = f.cmd.begin_unbound().await.unwrap();
        let err = sqlx::query(sqlx::AssertSqlSafe(format!("SELECT * FROM {table}")))
            .fetch_all(tx.conn())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("app.tenant_id"), "{table}: {err}");
    }
    // the same holds for an empty (not merely unset) binding
    let mut tx = f.cmd.begin_unbound().await.unwrap();
    sqlx::query("SELECT set_config('app.tenant_id', '', true)")
        .execute(tx.conn())
        .await
        .unwrap();
    assert!(
        sqlx::query("SELECT * FROM billing.subscription")
            .fetch_all(tx.conn())
            .await
            .is_err()
    );
    f.cleanup().await;
}

#[tokio::test]
async fn application_roles_can_read_plans_but_not_change_billing_state_directly() {
    let f = fx().await;
    let plan = f
        .plan(PlanSpec {
            code: "pro",
            interval: "month",
            price: Some("price_pro"),
            fallback: false,
            limits: &[(keys::RUNS_PER_MONTH, 5)],
        })
        .await;
    let tenant = seed_tenant(&f, plan, "A").await;
    let mut tx = f.cmd.begin_tenant(tenant).await.unwrap();

    // plans and entitlements are readable
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM billing.plan_entitlement")
        .fetch_one(tx.conn())
        .await
        .unwrap();
    assert_eq!(n, 1);
    drop(tx);

    // but no direct writes, no deletes, no DDL for the application role (R-DB-12)
    for sql in [
        "INSERT INTO billing.subscription(tenant_id, plan_id, status, provider_subscription_id, provider_event_created) SELECT tenant_id, plan_id, 'incomplete', 'sub_zzz', now() FROM billing.subscription",
        "UPDATE billing.subscription SET status = 'active'",
        "DELETE FROM billing.subscription",
        "TRUNCATE billing.subscription",
        "UPDATE billing.usage_counter SET quantity = 0",
        "DELETE FROM billing.usage_consumption",
        "INSERT INTO billing.plan(code, display_key, billing_interval, currency, unit_amount_minor) VALUES ('x','billing.x','month','EUR',0)",
        "UPDATE billing.plan SET unit_amount_minor = 0",
        "SELECT billing.create_plan('x','billing.x','month','EUR',0,false,false,0,NULL,NULL,'{}'::jsonb)",
        "SELECT billing.retire_plan(gen_random_uuid(), NULL)",
        "SELECT * FROM billing.provider_event",
        "SELECT * FROM billing.usage_consumption",
        "CREATE TABLE billing.sneaky(x int)",
    ] {
        let mut tx = f.cmd.begin_tenant(tenant).await.unwrap();
        let err = sqlx::query(sql).fetch_all(tx.conn()).await;
        // `fetch_all` returns rows for SELECT/RETURNING statements and an error on any privilege failure
        let msg = err.err().map(|e| e.to_string()).unwrap_or_default();
        assert!(
            msg.contains("permission denied") || msg.contains("must be owner"),
            "`{sql}` was not refused for the application role: {msg:?}"
        );
    }
    // the operator role cannot read tenant billing rows
    let mut tx = f.plans.begin_unbound().await.unwrap();
    assert!(
        sqlx::query("SELECT * FROM billing.subscription")
            .fetch_all(tx.conn())
            .await
            .is_err()
    );
    f.cleanup().await;
}
