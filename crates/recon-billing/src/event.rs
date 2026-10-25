//! Stripe events: parsing and projection to the fields this crate acts on.
//!
//! Shapes verified against https://docs.stripe.com/api/events/object, /api/subscriptions/object, /api/invoices/object
//! and /api/checkout/sessions/object (accessed 2026-10-25; API version 2026-09-30.endive, https://docs.stripe.com/api/versioning):
//!
//! * event: `{id, type, created, data: {object}}`;
//! * subscription: `id, customer, status, cancel_at_period_end, metadata, items.data[].{price.id, current_period_start,
//!   current_period_end}` (since the Basil release the period lives on the subscription ITEM; the top level is read as a
//!   fallback for endpoints still pinned to an older API version);
//! * invoice: `id, number, total, currency, status, hosted_invoice_url, customer, parent.subscription_details.{subscription,
//!   metadata}` (older versions: top-level `subscription`);
//! * checkout session: `id, mode, client_reference_id, customer, subscription, metadata`.
//!
//! The projection is allow-listed: nothing that identifies a person (customer name, e-mail, address, tax id) or a payment
//! instrument is read, so none of it can reach `billing.provider_event.payload`, logs or the ledger.

use crate::error::BillingError;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

/// Provider metadata key holding our tenant id (set on the Checkout Session and on the subscription).
pub const METADATA_TENANT: &str = "recon_tenant_id";
/// Provider metadata key holding our plan id (set on the Checkout Session).
pub const METADATA_PLAN: &str = "recon_plan_id";

/// A verified-and-parsed Stripe event envelope.
#[derive(Debug, Clone)]
pub struct Event {
    pub id: String,
    pub kind: String,
    pub created: i64,
    pub object: Value,
}

#[derive(Deserialize)]
struct Envelope {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    created: i64,
    data: EnvelopeData,
}

#[derive(Deserialize)]
struct EnvelopeData {
    object: Value,
}

/// Parse the (already signature-verified) body.
pub fn parse_event(body: &[u8]) -> Result<Event, BillingError> {
    let e: Envelope =
        serde_json::from_slice(body).map_err(|_| BillingError::EventParse("envelope"))?;
    if e.id.is_empty() || e.id.len() > 255 || e.kind.is_empty() || e.kind.len() > 100 {
        return Err(BillingError::EventParse("envelope fields"));
    }
    Ok(Event {
        id: e.id,
        kind: e.kind,
        created: e.created,
        object: e.data.object,
    })
}

/// Subscription status in this schema's vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubStatus {
    Trialing,
    Active,
    PastDue,
    Canceled,
    Incomplete,
}

impl SubStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Trialing => "trialing",
            Self::Active => "active",
            Self::PastDue => "past_due",
            Self::Canceled => "canceled",
            Self::Incomplete => "incomplete",
        }
    }

    /// Map a Stripe status. `unpaid`, `paused` and `incomplete_expired` grant no access (Stripe: "revoke access when the
    /// subscription is unpaid", https://docs.stripe.com/billing/subscriptions/webhooks, accessed 2026-10-25), so they map to
    /// `canceled`; the row can still return to `active` if the provider reactivates it. An unknown future status also maps to
    /// `canceled`: no entitlement is the fail-closed reading.
    pub fn from_stripe(s: &str) -> Self {
        match s {
            "trialing" => Self::Trialing,
            "active" => Self::Active,
            "past_due" => Self::PastDue,
            "incomplete" => Self::Incomplete,
            _ => Self::Canceled,
        }
    }
}

/// `checkout.session.completed` fields we use.
#[derive(Debug, Clone)]
pub struct CheckoutCompleted {
    pub tenant_hint: Option<Uuid>,
    pub plan_hint: Option<Uuid>,
    pub customer: Option<String>,
    pub subscription: Option<String>,
}

/// `customer.subscription.created|updated|deleted` fields we use.
#[derive(Debug, Clone)]
pub struct SubscriptionChange {
    pub tenant_hint: Option<Uuid>,
    pub subscription: String,
    pub customer: Option<String>,
    pub price_id: Option<String>,
    pub status: SubStatus,
    pub period_start: Option<i64>,
    pub period_end: Option<i64>,
    pub cancel_at_period_end: bool,
}

/// `invoice.paid` / `invoice.payment_failed` fields we use.
#[derive(Debug, Clone)]
pub struct InvoiceChange {
    pub tenant_hint: Option<Uuid>,
    pub invoice: String,
    pub subscription: Option<String>,
    pub customer: Option<String>,
    pub number: Option<String>,
    pub amount_minor: i64,
    pub currency: String,
    pub status: &'static str,
    pub hosted_url: Option<String>,
}

/// The events this crate acts on.
#[derive(Debug, Clone)]
pub enum Action {
    Checkout(CheckoutCompleted),
    Subscription(SubscriptionChange),
    Invoice(InvoiceChange),
}

/// Decide what an event means. `Ok(None)` = an event type we do not act on.
pub fn classify(event: &Event) -> Result<Option<Action>, BillingError> {
    let o = &event.object;
    Ok(match event.kind.as_str() {
        "checkout.session.completed" => Some(Action::Checkout(checkout(o)?)),
        "customer.subscription.created" | "customer.subscription.updated" => {
            Some(Action::Subscription(subscription(o, false)?))
        }
        "customer.subscription.deleted" => Some(Action::Subscription(subscription(o, true)?)),
        "invoice.paid" | "invoice.payment_failed" => Some(Action::Invoice(invoice(o)?)),
        _ => None,
    })
}

impl Action {
    /// Provider customer / subscription ids for tenant resolution.
    pub fn refs(&self) -> (Option<&str>, Option<&str>, Option<Uuid>) {
        match self {
            Action::Checkout(c) => (
                c.subscription.as_deref(),
                c.customer.as_deref(),
                c.tenant_hint,
            ),
            Action::Subscription(s) => (
                Some(s.subscription.as_str()),
                s.customer.as_deref(),
                s.tenant_hint,
            ),
            Action::Invoice(i) => (
                i.subscription.as_deref(),
                i.customer.as_deref(),
                i.tenant_hint,
            ),
        }
    }

    /// The allow-listed projection stored as `billing.provider_event.payload`.
    pub fn summary(&self) -> Value {
        match self {
            Action::Checkout(c) => json!({
                "kind": "checkout",
                "subscription": c.subscription,
                "customer": c.customer,
                "plan": c.plan_hint.map(|p| p.to_string()),
            }),
            Action::Subscription(s) => json!({
                "kind": "subscription",
                "subscription": s.subscription,
                "customer": s.customer,
                "price": s.price_id,
                "status": s.status.as_str(),
                "period_start": s.period_start,
                "period_end": s.period_end,
                "cancel_at_period_end": s.cancel_at_period_end,
            }),
            Action::Invoice(i) => json!({
                "kind": "invoice",
                "invoice": i.invoice,
                "subscription": i.subscription,
                "customer": i.customer,
                "number": i.number,
                "amount_minor": i.amount_minor,
                "currency": i.currency,
                "status": i.status,
            }),
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------

fn parse_err(what: &'static str) -> BillingError {
    BillingError::EventParse(what)
}

/// A provider object id: ASCII alphanumerics and underscore, 3..=100 (the shape the schema CHECKs require).
fn provider_id(v: &Value) -> Option<String> {
    let s = v.as_str()?;
    ((3..=100).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
        .then(|| s.to_string())
}

/// An id that may be a string or an expanded object with an `id`.
fn id_or_object(v: &Value) -> Option<String> {
    match v {
        Value::String(_) => provider_id(v),
        Value::Object(m) => m.get("id").and_then(provider_id),
        _ => None,
    }
}

fn uuid_in(meta: Option<&Value>, key: &str) -> Option<Uuid> {
    meta?
        .get(key)?
        .as_str()
        .and_then(|s| Uuid::parse_str(s).ok())
}

fn checkout(o: &Value) -> Result<CheckoutCompleted, BillingError> {
    if o.get("mode").and_then(Value::as_str) != Some("subscription") {
        // not a subscription checkout: nothing to link
        return Ok(CheckoutCompleted {
            tenant_hint: None,
            plan_hint: None,
            customer: None,
            subscription: None,
        });
    }
    let tenant_hint = o
        .get("client_reference_id")
        .and_then(Value::as_str)
        .and_then(|s| Uuid::parse_str(s).ok())
        .or_else(|| uuid_in(o.get("metadata"), METADATA_TENANT));
    Ok(CheckoutCompleted {
        tenant_hint,
        plan_hint: uuid_in(o.get("metadata"), METADATA_PLAN),
        customer: o.get("customer").and_then(id_or_object),
        subscription: o.get("subscription").and_then(id_or_object),
    })
}

fn subscription(o: &Value, deleted: bool) -> Result<SubscriptionChange, BillingError> {
    let subscription = o
        .get("id")
        .and_then(provider_id)
        .ok_or_else(|| parse_err("subscription id"))?;
    let status = if deleted {
        SubStatus::Canceled
    } else {
        SubStatus::from_stripe(
            o.get("status")
                .and_then(Value::as_str)
                .ok_or_else(|| parse_err("subscription status"))?,
        )
    };
    let items = o
        .get("items")
        .and_then(|i| i.get("data"))
        .and_then(Value::as_array);
    if items.is_some_and(|a| a.len() > 1) {
        eprintln!("billing: subscription has more than one item; only the first is used");
    }
    let item = items.and_then(|a| a.first());
    let price_id = item
        .and_then(|i| i.get("price").or_else(|| i.get("plan")))
        .and_then(|p| p.get("id"))
        .and_then(provider_id);
    let int = |item_key: &str| -> Option<i64> {
        item.and_then(|i| i.get(item_key))
            .and_then(Value::as_i64)
            .or_else(|| o.get(item_key).and_then(Value::as_i64))
    };
    Ok(SubscriptionChange {
        tenant_hint: uuid_in(o.get("metadata"), METADATA_TENANT),
        subscription,
        customer: o.get("customer").and_then(id_or_object),
        price_id,
        status,
        period_start: int("current_period_start"),
        period_end: int("current_period_end"),
        cancel_at_period_end: o
            .get("cancel_at_period_end")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn invoice(o: &Value) -> Result<InvoiceChange, BillingError> {
    let invoice = o
        .get("id")
        .and_then(provider_id)
        .ok_or_else(|| parse_err("invoice id"))?;
    let details = o.get("parent").and_then(|p| p.get("subscription_details"));
    let subscription = details
        .and_then(|d| d.get("subscription"))
        .and_then(id_or_object)
        .or_else(|| o.get("subscription").and_then(id_or_object));
    let currency = o
        .get("currency")
        .and_then(Value::as_str)
        .filter(|c| c.len() == 3 && c.bytes().all(|b| b.is_ascii_alphabetic()))
        .map(str::to_ascii_uppercase)
        .ok_or_else(|| parse_err("invoice currency"))?;
    let status = match o.get("status").and_then(Value::as_str) {
        Some("draft") => "draft",
        Some("open") => "open",
        Some("paid") => "paid",
        Some("uncollectible") => "uncollectible",
        Some("void") => "void",
        _ => return Err(parse_err("invoice status")),
    };
    Ok(InvoiceChange {
        tenant_hint: uuid_in(details.and_then(|d| d.get("metadata")), METADATA_TENANT),
        invoice,
        subscription,
        customer: o.get("customer").and_then(id_or_object),
        number: o
            .get("number")
            .and_then(Value::as_str)
            .filter(|n| n.len() <= 64)
            .map(str::to_string),
        amount_minor: o
            .get("total")
            .and_then(Value::as_i64)
            .ok_or_else(|| parse_err("invoice total"))?,
        currency,
        status,
        hosted_url: o
            .get("hosted_invoice_url")
            .and_then(Value::as_str)
            .filter(|u| u.starts_with("https://") && u.len() <= 2048)
            .map(str::to_string),
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn ev(kind: &str, object: Value) -> Event {
        Event {
            id: "evt_1".into(),
            kind: kind.into(),
            created: 1,
            object,
        }
    }

    #[test]
    fn subscription_period_comes_from_the_item_with_a_top_level_fallback() {
        let tenant = tenant_id();
        let basil = json!({"id": "sub_1", "customer": "cus_1", "status": "active", "cancel_at_period_end": true,
            "metadata": {METADATA_TENANT: tenant.to_string()},
            "items": {"data": [{"price": {"id": "price_1"}, "current_period_start": 10, "current_period_end": 20}]}});
        let Some(Action::Subscription(s)) =
            classify(&ev("customer.subscription.updated", basil)).unwrap()
        else {
            panic!("expected a subscription action")
        };
        assert_eq!((s.period_start, s.period_end), (Some(10), Some(20)));
        assert_eq!(s.price_id.as_deref(), Some("price_1"));
        assert_eq!(s.tenant_hint, Some(tenant));
        assert!(s.cancel_at_period_end);

        let legacy = json!({"id": "sub_1", "status": "past_due", "current_period_start": 1, "current_period_end": 2,
            "items": {"data": [{"price": {"id": "price_1"}}]}});
        let Some(Action::Subscription(s)) =
            classify(&ev("customer.subscription.created", legacy)).unwrap()
        else {
            panic!("expected a subscription action")
        };
        assert_eq!((s.period_start, s.period_end), (Some(1), Some(2)));
        assert_eq!(s.status, SubStatus::PastDue);
    }

    #[test]
    fn deleted_is_always_canceled_and_odd_statuses_grant_nothing() {
        let o = json!({"id": "sub_1", "status": "active"});
        let Some(Action::Subscription(s)) =
            classify(&ev("customer.subscription.deleted", o)).unwrap()
        else {
            panic!("expected a subscription action")
        };
        assert_eq!(s.status, SubStatus::Canceled);
        for st in ["unpaid", "paused", "incomplete_expired", "something_new"] {
            assert_eq!(SubStatus::from_stripe(st), SubStatus::Canceled);
        }
    }

    #[test]
    fn invoice_reads_the_basil_parent_and_the_legacy_field_and_drops_personal_data() {
        let tenant = tenant_id();
        let o = json!({"id": "in_1", "status": "paid", "currency": "eur", "total": 4900, "number": "ABC-0001",
            "hosted_invoice_url": "https://invoice.stripe.com/i/x", "customer": "cus_1",
            "customer_email": "someone@example.com", "customer_name": "A Person",
            "parent": {"subscription_details": {"subscription": "sub_9", "metadata": {METADATA_TENANT: tenant.to_string()}}}});
        let Some(a @ Action::Invoice(_)) = classify(&ev("invoice.paid", o)).unwrap() else {
            panic!("expected an invoice action")
        };
        let Action::Invoice(i) = &a else { panic!() };
        assert_eq!(i.subscription.as_deref(), Some("sub_9"));
        assert_eq!((i.amount_minor, i.currency.as_str()), (4900, "EUR"));
        assert_eq!(i.tenant_hint, Some(tenant));
        let stored = a.summary().to_string();
        assert!(!stored.contains("someone@example.com") && !stored.contains("A Person"));
        assert!(
            !stored.contains("invoice.stripe.com"),
            "capability URL stays out of the event log"
        );

        let legacy = json!({"id": "in_2", "status": "open", "currency": "EUR", "total": 1, "subscription": "sub_3"});
        let Some(Action::Invoice(i)) = classify(&ev("invoice.payment_failed", legacy)).unwrap()
        else {
            panic!("expected an invoice action")
        };
        assert_eq!(i.subscription.as_deref(), Some("sub_3"));
    }

    #[test]
    fn checkout_links_only_subscription_mode_sessions() {
        let tenant = tenant_id();
        let o = json!({"mode": "subscription", "client_reference_id": tenant.to_string(), "customer": "cus_1",
            "subscription": "sub_1", "metadata": {METADATA_PLAN: tenant.to_string()}});
        let Some(Action::Checkout(c)) = classify(&ev("checkout.session.completed", o)).unwrap()
        else {
            panic!("expected a checkout action")
        };
        assert_eq!(c.tenant_hint, Some(tenant));
        assert_eq!(c.subscription.as_deref(), Some("sub_1"));
        let payment = json!({"mode": "payment", "client_reference_id": tenant.to_string(), "subscription": null});
        let Some(Action::Checkout(c)) =
            classify(&ev("checkout.session.completed", payment)).unwrap()
        else {
            panic!("expected a checkout action")
        };
        assert!(c.subscription.is_none() && c.tenant_hint.is_none());
    }

    #[test]
    fn unhandled_types_and_unparseable_objects() {
        assert!(
            classify(&ev("customer.updated", json!({})))
                .unwrap()
                .is_none()
        );
        assert!(
            classify(&ev(
                "customer.subscription.updated",
                json!({"status": "active"})
            ))
            .is_err()
        );
        assert!(
            classify(&ev(
                "invoice.paid",
                json!({"id": "in_1", "status": "weird", "currency": "eur", "total": 1})
            ))
            .is_err()
        );
        assert!(parse_event(b"not json").is_err());
        assert!(
            parse_event(br#"{"id":"evt_1","type":"x","created":1,"data":{"object":{}}}"#).is_ok()
        );
    }

    fn tenant_id() -> Uuid {
        Uuid::from_u128(0x0192_0000_0000_7000_8000_0000_0000_0001)
    }
}
