//! Webhook endpoint end to end: signature gate, idempotent application, ledger events, PII-free storage.
//! Real PostgreSQL 18 (tests/common/mod.rs); the Stripe API itself is never called by these tests.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use axum::http::StatusCode;
use common::{PlanSpec, call, event, fx, signed, unix_now, webhook_request};
use recon_billing::entitlements::{Access, PlanSource};
use recon_billing::event::{METADATA_PLAN, METADATA_TENANT};
use recon_billing::{keys, webhook_router};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

async fn count(pool: &PgPool, sql: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(pool)
        .await
        .unwrap()
}
async fn ledger_types(pool: &PgPool, tenant: Uuid) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT event_type FROM ledger.audit_event WHERE tenant_id = $1 ORDER BY seq",
    )
    .bind(tenant)
    .fetch_all(pool)
    .await
    .unwrap()
}

fn sub_object(
    sub: &str,
    tenant: Uuid,
    price: &str,
    status: &str,
    start: i64,
    end: i64,
    cancel: bool,
) -> Value {
    json!({"id": sub, "object": "subscription", "customer": "cus_alpha1", "status": status,
           "cancel_at_period_end": cancel, "metadata": {METADATA_TENANT: tenant.to_string()},
           "items": {"data": [{"price": {"id": price}, "current_period_start": start, "current_period_end": end}]}})
}

#[tokio::test]
async fn the_signature_is_checked_before_anything_is_parsed_or_stored() {
    let f = fx().await;
    let router = webhook_router(common::state(&f, "http://127.0.0.1:1"));
    let tenant = f.tenant().await;
    let plan = f
        .plan(PlanSpec {
            code: "pro",
            interval: "month",
            price: Some("price_pro"),
            fallback: false,
            limits: &[(keys::RUNS_PER_MONTH, 10)],
        })
        .await;
    let _ = plan;
    let now = unix_now();
    let body = event(
        "evt_sig1",
        "customer.subscription.created",
        now,
        sub_object(
            "sub_s1",
            tenant,
            "price_pro",
            "active",
            now,
            now + 2_592_000,
            false,
        ),
    );
    let secret = recon_billing::Secret::new(common::WEBHOOK_SECRET);
    let good = recon_billing::signature::sign(&body, &secret, now);

    // tampered payload
    let mut tampered = body.clone();
    let pos = tampered.windows(8).position(|w| w == b"price_pr").unwrap();
    tampered[pos + 6] = b'X';
    let (st, _) = call(&router, webhook_request(tampered, Some(good.clone()))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    // old timestamp (validly signed, 6 minutes ago)
    let old = recon_billing::signature::sign(&body, &secret, now - 360);
    assert_eq!(
        call(&router, webhook_request(body.clone(), Some(old)))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    // wrong secret
    let wrong =
        recon_billing::signature::sign(&body, &recon_billing::Secret::new("whsec_other"), now);
    assert_eq!(
        call(&router, webhook_request(body.clone(), Some(wrong)))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    // missing and malformed headers
    assert_eq!(
        call(&router, webhook_request(body.clone(), None)).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &router,
            webhook_request(body.clone(), Some("nonsense".into()))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    // the error body does not say why
    let (_, err) = call(&router, webhook_request(body.clone(), None)).await;
    assert_eq!(err["error"]["code"], "invalid_signature");

    assert_eq!(
        count(&f.admin, "SELECT count(*) FROM billing.provider_event").await,
        0,
        "rejected deliveries leave no trace"
    );
    assert_eq!(
        count(&f.admin, "SELECT count(*) FROM billing.subscription").await,
        0
    );

    // several v1 signatures in one header: a valid one among junk is enough
    let v1 = good.split_once(",v1=").unwrap().1;
    let multi = format!("t={now},v1={},v1=not-hex,v1={v1}", "00".repeat(32));
    let (st, out) = call(&router, webhook_request(body.clone(), Some(multi))).await;
    assert_eq!(
        (st, out["outcome"].as_str()),
        (StatusCode::OK, Some("created"))
    );
    assert_eq!(
        count(&f.admin, "SELECT count(*) FROM billing.subscription").await,
        1
    );
    f.cleanup().await;
}

#[tokio::test]
async fn a_subscription_lifecycle_is_applied_once_per_event_and_ledgered_without_personal_data() {
    let f = fx().await;
    let router = webhook_router(common::state(&f, "http://127.0.0.1:1"));
    let b = recon_billing::Billing::new(
        f.cmd.clone(),
        recon_billing::Policy {
            past_due_grace: time::Duration::days(14),
        },
    );
    let tenant = f.tenant().await;
    let plan_a = f
        .plan(PlanSpec {
            code: "starter",
            interval: "month",
            price: Some("price_a"),
            fallback: false,
            limits: &[(keys::RUNS_PER_MONTH, 10)],
        })
        .await;
    let plan_b = f
        .plan(PlanSpec {
            code: "pro",
            interval: "month",
            price: Some("price_b"),
            fallback: false,
            limits: &[(keys::RUNS_PER_MONTH, 100)],
        })
        .await;
    let t0 = unix_now();
    let end = t0 + 30 * 86_400;
    let send = |id: &'static str, kind: &'static str, created: i64, obj: Value| {
        let router = router.clone();
        async move {
            let (st, out) = call(&router, signed(event(id, kind, created, obj))).await;
            assert_eq!(st, StatusCode::OK, "{id}: {out}");
            out["outcome"].as_str().unwrap().to_string()
        }
    };

    // 1. checkout completed: links ids, grants nothing yet
    let checkout = json!({"id": "cs_1", "mode": "subscription", "client_reference_id": tenant.to_string(), "customer": "cus_alpha1",
        "subscription": "sub_alpha1", "customer_details": {"email": "buyer@example.com", "name": "Buyer Name"},
        "metadata": {METADATA_TENANT: tenant.to_string(), METADATA_PLAN: plan_a.to_string()}});
    assert_eq!(
        send("evt_1", "checkout.session.completed", t0, checkout).await,
        "created_incomplete"
    );
    let e = b.entitlements(tenant).await.unwrap();
    assert_eq!(
        e.access,
        Access::None,
        "an incomplete subscription grants nothing"
    );

    // 2. subscription becomes active
    let created = sub_object("sub_alpha1", tenant, "price_a", "active", t0, end, false);
    assert_eq!(
        send(
            "evt_2",
            "customer.subscription.created",
            t0 + 1,
            created.clone()
        )
        .await,
        "updated"
    );
    let e = b.entitlements(tenant).await.unwrap();
    assert_eq!(
        (e.access, e.source),
        (Access::Full, PlanSource::Subscription)
    );
    assert_eq!(e.plan.as_ref().unwrap().id, plan_a);
    assert_eq!(e.limit(keys::RUNS_PER_MONTH), Some(10));

    // 3. the same event delivered again: one effect only
    let before = (
        count(&f.admin, "SELECT count(*) FROM billing.provider_event").await,
        ledger_types(&f.admin, tenant).await.len(),
    );
    assert_eq!(
        send("evt_2", "customer.subscription.created", t0 + 1, created).await,
        "duplicate"
    );
    assert_eq!(
        (
            count(&f.admin, "SELECT count(*) FROM billing.provider_event").await,
            ledger_types(&f.admin, tenant).await.len()
        ),
        before
    );

    // 4. invoice paid: attributed through the subscription we already know (no metadata on the event)
    let invoice = json!({"id": "in_1", "status": "paid", "currency": "eur", "total": 4900, "number": "RC-0001",
        "hosted_invoice_url": "https://invoice.stripe.com/i/acct_1/live_abc", "customer": "cus_alpha1",
        "customer_email": "buyer@example.com", "customer_name": "Buyer Name",
        "customer_address": {"line1": "1 Main Street", "country": "RO"},
        "parent": {"subscription_details": {"subscription": "sub_alpha1"}}});
    assert_eq!(
        send("evt_3", "invoice.paid", t0 + 2, invoice).await,
        "recorded"
    );
    let ov = b.overview(tenant).await.unwrap();
    assert_eq!(ov.invoices.len(), 1);
    assert_eq!(
        (
            ov.invoices[0].amount_minor,
            ov.invoices[0].currency.as_str(),
            ov.invoices[0].status.as_str()
        ),
        (4900, "EUR", "paid")
    );
    assert_eq!(ov.invoices[0].number.as_deref(), Some("RC-0001"));

    // 5. plan change
    let upgraded = sub_object("sub_alpha1", tenant, "price_b", "active", t0, end, false);
    assert_eq!(
        send("evt_4", "customer.subscription.updated", t0 + 10, upgraded).await,
        "updated"
    );
    let e = b.entitlements(tenant).await.unwrap();
    assert_eq!(
        (e.plan.as_ref().unwrap().id, e.limit(keys::RUNS_PER_MONTH)),
        (plan_b, Some(100))
    );

    // 6. an older event arriving late is ignored
    let old = sub_object("sub_alpha1", tenant, "price_a", "active", t0, end, false);
    assert_eq!(
        send("evt_5", "customer.subscription.updated", t0 + 5, old).await,
        "stale"
    );
    assert_eq!(
        b.entitlements(tenant).await.unwrap().plan.unwrap().id,
        plan_b
    );

    // 7. payment fails
    let failed = json!({"id": "in_2", "status": "open", "currency": "eur", "total": 4900,
        "parent": {"subscription_details": {"subscription": "sub_alpha1"}}});
    assert_eq!(
        send("evt_6", "invoice.payment_failed", t0 + 20, failed).await,
        "recorded"
    );
    let past_due = sub_object("sub_alpha1", tenant, "price_b", "past_due", t0, end, false);
    assert_eq!(
        send("evt_7", "customer.subscription.updated", t0 + 21, past_due).await,
        "updated"
    );
    let e = b.entitlements(tenant).await.unwrap();
    assert_eq!(
        e.status,
        Some(recon_billing::entitlements::SubscriptionStatus::PastDue)
    );
    assert_eq!(e.access, Access::Full, "inside the grace window");
    assert!(e.past_due_since.is_some());

    // 8. paid again and cancellation scheduled
    let recovered = sub_object("sub_alpha1", tenant, "price_b", "active", t0, end, true);
    assert_eq!(
        send("evt_8", "customer.subscription.updated", t0 + 30, recovered).await,
        "updated"
    );
    let e = b.entitlements(tenant).await.unwrap();
    assert!(e.cancel_at_period_end && e.past_due_since.is_none());

    // 9. subscription deleted: no entitlement, no fallback plan exists, nothing is deleted
    let deleted = sub_object("sub_alpha1", tenant, "price_b", "canceled", t0, end, true);
    assert_eq!(
        send("evt_9", "customer.subscription.deleted", t0 + 40, deleted).await,
        "updated"
    );
    assert_eq!(b.entitlements(tenant).await.unwrap().access, Access::None);
    assert_eq!(
        count(&f.admin, "SELECT count(*) FROM billing.invoice_ref").await,
        2
    );
    assert_eq!(
        count(&f.admin, "SELECT count(*) FROM billing.subscription").await,
        1,
        "history is kept"
    );

    // ledger: plan changes and cancellations, in order, once each
    assert_eq!(
        ledger_types(&f.admin, tenant).await,
        [
            "tenant.created",
            "billing.subscription.status_changed", // incomplete -> active
            "billing.subscription.plan_changed",   // price_a -> price_b
            "billing.subscription.status_changed", // active -> past_due
            "billing.subscription.status_changed", // past_due -> active
            "billing.subscription.cancel_at_period_end_changed",
            "billing.subscription.status_changed", // active -> canceled
        ]
    );
    // ledger payloads carry opaque references only
    let payloads: Vec<Value> = sqlx::query_scalar(
        "SELECT payload FROM ledger.audit_event WHERE event_type LIKE 'billing.%' ORDER BY seq",
    )
    .fetch_all(&f.admin)
    .await
    .unwrap();
    let allowed = [
        "plan_id",
        "from_plan_id",
        "to_plan_id",
        "plan_code",
        "status",
        "from_status",
        "to_status",
        "cancel_at_period_end",
        "event",
    ];
    for p in &payloads {
        for k in p.as_object().unwrap().keys() {
            assert!(allowed.contains(&k.as_str()), "unexpected ledger key {k}");
        }
        let text = p.to_string();
        for pii in [
            "buyer",
            "Buyer",
            "Main Street",
            "cus_",
            "sub_",
            "invoice.stripe.com",
            "RC-0001",
        ] {
            assert!(!text.contains(pii), "ledger payload leaks {pii}: {text}");
        }
    }
    // the stored event log is PII-free too (allow-listed projection, never the raw event)
    let stored: Vec<Value> = sqlx::query_scalar("SELECT payload FROM billing.provider_event")
        .fetch_all(&f.admin)
        .await
        .unwrap();
    assert_eq!(stored.len(), 9);
    for p in &stored {
        let text = p.to_string();
        for pii in [
            "buyer@example.com",
            "Buyer Name",
            "Main Street",
            "invoice.stripe.com",
            "card",
        ] {
            assert!(
                !text.contains(pii),
                "provider_event payload leaks {pii}: {text}"
            );
        }
    }
    f.cleanup().await;
}

#[tokio::test]
async fn concurrent_redeliveries_of_one_event_have_one_effect() {
    let f = fx().await;
    let router = webhook_router(common::state(&f, "http://127.0.0.1:1"));
    let tenant = f.tenant().await;
    f.plan(PlanSpec {
        code: "pro",
        interval: "month",
        price: Some("price_pro"),
        fallback: false,
        limits: &[(keys::RUNS_PER_MONTH, 10)],
    })
    .await;
    let now = unix_now();
    let body = event(
        "evt_race",
        "customer.subscription.created",
        now,
        sub_object(
            "sub_race",
            tenant,
            "price_pro",
            "active",
            now,
            now + 86_400 * 30,
            false,
        ),
    );

    let mut tasks = Vec::new();
    for _ in 0..12 {
        let (router, body) = (router.clone(), body.clone());
        tasks.push(tokio::spawn(async move {
            let (st, out) = call(&router, signed(body)).await;
            assert_eq!(st, StatusCode::OK);
            out["outcome"].as_str().unwrap().to_string()
        }));
    }
    let mut outcomes = Vec::new();
    for t in tasks {
        outcomes.push(t.await.unwrap());
    }
    assert_eq!(
        outcomes.iter().filter(|o| *o == "created").count(),
        1,
        "{outcomes:?}"
    );
    assert_eq!(
        outcomes.iter().filter(|o| *o == "duplicate").count(),
        11,
        "{outcomes:?}"
    );
    assert_eq!(
        count(&f.admin, "SELECT count(*) FROM billing.subscription").await,
        1
    );
    assert_eq!(
        count(&f.admin, "SELECT count(*) FROM billing.provider_event").await,
        1
    );
    assert_eq!(
        ledger_types(&f.admin, tenant).await,
        ["tenant.created", "billing.subscription.created"]
    );
    f.cleanup().await;
}

#[tokio::test]
async fn an_event_for_a_price_without_a_plan_is_not_recorded_so_the_provider_retries() {
    let f = fx().await;
    let router = webhook_router(common::state(&f, "http://127.0.0.1:1"));
    let tenant = f.tenant().await;
    let now = unix_now();
    let body = event(
        "evt_noplan",
        "customer.subscription.created",
        now,
        sub_object(
            "sub_np",
            tenant,
            "price_future",
            "active",
            now,
            now + 86_400,
            false,
        ),
    );

    let (st, out) = call(&router, signed(body.clone())).await;
    assert_eq!(st, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(out["error"]["code"], "internal");
    assert_eq!(
        count(&f.admin, "SELECT count(*) FROM billing.provider_event").await,
        0
    );
    assert_eq!(
        count(&f.admin, "SELECT count(*) FROM billing.subscription").await,
        0
    );

    // an operator seeds the plan; the provider's retry of the very same event now succeeds
    f.plan(PlanSpec {
        code: "late",
        interval: "month",
        price: Some("price_future"),
        fallback: false,
        limits: &[(keys::RUNS_PER_MONTH, 1)],
    })
    .await;
    let (st, out) = call(&router, signed(body)).await;
    assert_eq!(
        (st, out["outcome"].as_str()),
        (StatusCode::OK, Some("created"))
    );
    f.cleanup().await;
}

#[tokio::test]
async fn events_nobody_owns_are_recorded_but_never_applied_and_other_types_are_ignored() {
    let f = fx().await;
    let router = webhook_router(common::state(&f, "http://127.0.0.1:1"));
    let now = unix_now();
    let foreign = json!({"id": "sub_foreign", "status": "active", "customer": "cus_foreign",
        "items": {"data": [{"price": {"id": "price_x"}, "current_period_start": now, "current_period_end": now + 100}]}});
    let body = event("evt_foreign", "customer.subscription.created", now, foreign);
    let (st, out) = call(&router, signed(body.clone())).await;
    assert_eq!(
        (st, out["outcome"].as_str()),
        (StatusCode::OK, Some("unattributed"))
    );
    let (_, out) = call(&router, signed(body)).await;
    assert_eq!(out["outcome"], "duplicate");
    assert_eq!(count(&f.admin, "SELECT count(*) FROM billing.provider_event WHERE tenant_id IS NULL AND outcome = 'unattributed'").await, 1);
    assert_eq!(
        count(&f.admin, "SELECT count(*) FROM billing.subscription").await,
        0
    );

    // metadata naming a tenant that does not exist is not trusted either
    let ghost = json!({"id": "sub_ghost", "status": "active", "metadata": {METADATA_TENANT: Uuid::from_u128(7).to_string()},
        "items": {"data": [{"price": {"id": "price_x"}, "current_period_start": now, "current_period_end": now + 100}]}});
    let (_, out) = call(
        &router,
        signed(event(
            "evt_ghost",
            "customer.subscription.created",
            now,
            ghost,
        )),
    )
    .await;
    assert_eq!(out["outcome"], "unattributed");

    let (st, out) = call(
        &router,
        signed(event(
            "evt_other",
            "customer.updated",
            now,
            json!({"id": "cus_1"}),
        )),
    )
    .await;
    assert_eq!(
        (st, out["outcome"].as_str()),
        (StatusCode::OK, Some("ignored"))
    );
    assert_eq!(
        count(
            &f.admin,
            "SELECT count(*) FROM billing.provider_event WHERE provider_event_id = 'evt_other'"
        )
        .await,
        0
    );
    f.cleanup().await;
}

#[tokio::test]
async fn a_second_live_subscription_for_one_tenant_is_refused_not_applied() {
    let f = fx().await;
    let router = webhook_router(common::state(&f, "http://127.0.0.1:1"));
    let tenant = f.tenant().await;
    f.plan(PlanSpec {
        code: "pro",
        interval: "month",
        price: Some("price_pro"),
        fallback: false,
        limits: &[(keys::RUNS_PER_MONTH, 10)],
    })
    .await;
    let now = unix_now();
    let first = sub_object(
        "sub_one",
        tenant,
        "price_pro",
        "active",
        now,
        now + 86_400,
        false,
    );
    assert_eq!(
        call(
            &router,
            signed(event("evt_a", "customer.subscription.created", now, first))
        )
        .await
        .1["outcome"],
        "created"
    );
    let second = sub_object(
        "sub_two",
        tenant,
        "price_pro",
        "active",
        now,
        now + 86_400,
        false,
    );
    assert_eq!(
        call(
            &router,
            signed(event("evt_b", "customer.subscription.created", now, second))
        )
        .await
        .1["outcome"],
        "conflict"
    );
    assert_eq!(
        count(&f.admin, "SELECT count(*) FROM billing.subscription").await,
        1
    );

    // after the first one ends, the tenant can subscribe again; history keeps both
    let ended = sub_object(
        "sub_one",
        tenant,
        "price_pro",
        "canceled",
        now,
        now + 86_400,
        false,
    );
    assert_eq!(
        call(
            &router,
            signed(event(
                "evt_c",
                "customer.subscription.deleted",
                now + 1,
                ended
            ))
        )
        .await
        .1["outcome"],
        "updated"
    );
    let again = sub_object(
        "sub_three",
        tenant,
        "price_pro",
        "active",
        now,
        now + 86_400,
        false,
    );
    assert_eq!(
        call(
            &router,
            signed(event(
                "evt_d",
                "customer.subscription.created",
                now + 2,
                again
            ))
        )
        .await
        .1["outcome"],
        "created"
    );
    assert_eq!(
        count(&f.admin, "SELECT count(*) FROM billing.subscription").await,
        2
    );
    f.cleanup().await;
}
