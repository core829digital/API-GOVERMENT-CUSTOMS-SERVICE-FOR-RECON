-- target: w
-- Billing (cluster W ONLY). Plans and entitlements, the tenant's subscription, metered usage, provider webhook
-- idempotency and invoice references. NOT in publication `recon_pub`, NOT replicated to R, no R migration (R-DB-11 style:
-- like `api`, payment data never leaves W). The `billing` schema is therefore outside recon-migrate's fingerprint set.
--
-- Privacy design: no billing contact data (name, address, VAT id, e-mail, card data) is stored here. The payment
-- provider (Stripe) is the controller/processor of that data; we keep only opaque provider references, amounts and
-- statuses. `billing.provider_event.payload` holds an allow-listed projection built by recon-billing, never the raw event.
--
-- Write paths (R-DB-6 spirit): application roles get SELECT only. State changes happen in SECURITY DEFINER functions that
-- require the transaction to be bound to the tenant (privacy.require_bound_tenant, 0007) and, for entitlement-relevant
-- changes, append their ledger event in the same transaction. Plans are immutable: a new price is a new row.
-- RLS is ENABLEd (not FORCEd) exactly like 0003/0005: no application role owns an object.

CREATE SCHEMA billing;

-- ================================================================ plan catalogue (global, not tenant data)
CREATE TABLE billing.plan (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  code              text NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,47}$'),
  display_key       text NOT NULL CHECK (display_key ~ '^[a-z][A-Za-z0-9_.]{0,95}$'),
  billing_interval  text NOT NULL CHECK (billing_interval IN ('month', 'year')),
  currency          char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  unit_amount_minor bigint NOT NULL CHECK (unit_amount_minor >= 0),
  is_public         boolean NOT NULL DEFAULT false,
  is_fallback       boolean NOT NULL DEFAULT false,
  sort_order        int NOT NULL DEFAULT 0,
  provider_price_id text CHECK (provider_price_id ~ '^[A-Za-z0-9_]{3,100}$'),
  valid_from        timestamptz NOT NULL DEFAULT now(),
  valid_to          timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, billing_interval, currency, valid_from),
  UNIQUE (provider_price_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  -- the plan applied to tenants WITHOUT a subscription is free and has no provider price
  CHECK (NOT is_fallback OR (unit_amount_minor = 0 AND provider_price_id IS NULL))
);
-- at most one open-ended fallback ("free/sandbox") plan
CREATE UNIQUE INDEX plan_single_open_fallback ON billing.plan ((true)) WHERE is_fallback AND valid_to IS NULL;

CREATE TABLE billing.plan_entitlement (
  plan_id   uuid NOT NULL REFERENCES billing.plan(id),
  key       text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,47}$'),
  int_value bigint CHECK (int_value >= 0),
  bool_value boolean,
  PRIMARY KEY (plan_id, key),
  CHECK ((int_value IS NULL) <> (bool_value IS NULL))   -- exactly one: numeric limit XOR boolean flag
);

-- ================================================================ tenant tables
CREATE TABLE billing.subscription (
  id                       uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id                uuid NOT NULL REFERENCES core.tenant(id),
  plan_id                  uuid NOT NULL REFERENCES billing.plan(id),
  status                   text NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'incomplete')),
  current_period_start     timestamptz,
  current_period_end       timestamptz,
  cancel_at_period_end     boolean NOT NULL DEFAULT false,
  past_due_since           timestamptz,
  provider                 text NOT NULL DEFAULT 'stripe' CHECK (provider IN ('stripe')),
  provider_customer_id     text CHECK (provider_customer_id ~ '^[A-Za-z0-9_]{3,100}$'),
  provider_subscription_id text NOT NULL CHECK (provider_subscription_id ~ '^[A-Za-z0-9_]{3,100}$'),
  provider_event_created   timestamptz NOT NULL,   -- `created` of the newest provider event applied (ordering guard)
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subscription_id),
  CHECK (status NOT IN ('trialing', 'active', 'past_due')
         OR (current_period_start IS NOT NULL AND current_period_end IS NOT NULL AND current_period_end > current_period_start)),
  CHECK ((status = 'past_due') = (past_due_since IS NOT NULL))
);
-- "tenant_id unique active": at most one non-canceled subscription per tenant; canceled rows stay as history
CREATE UNIQUE INDEX subscription_one_live_per_tenant ON billing.subscription (tenant_id) WHERE status <> 'canceled';
CREATE INDEX subscription_by_customer ON billing.subscription (provider_customer_id) WHERE provider_customer_id IS NOT NULL;

CREATE TABLE billing.usage_counter (
  tenant_id    uuid NOT NULL REFERENCES core.tenant(id),
  metric       text NOT NULL CHECK (metric ~ '^[a-z][a-z0-9_]{0,47}$'),
  period_start timestamptz NOT NULL,
  quantity     bigint NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, metric, period_start)
);

-- One row per accepted consumption: the idempotency record that makes retries safe (never double-counted).
CREATE TABLE billing.usage_consumption (
  tenant_id       uuid NOT NULL REFERENCES core.tenant(id),
  metric          text NOT NULL CHECK (metric ~ '^[a-z][a-z0-9_]{0,47}$'),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  period_start    timestamptz NOT NULL,
  amount          bigint NOT NULL CHECK (amount > 0),
  consumed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, metric, idempotency_key)
);

-- Webhook idempotency: the provider's event id is UNIQUE; a redelivered event finds its row and does nothing.
CREATE TABLE billing.provider_event (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  provider          text NOT NULL DEFAULT 'stripe' CHECK (provider IN ('stripe')),
  provider_event_id text NOT NULL UNIQUE CHECK (char_length(provider_event_id) BETWEEN 1 AND 255),
  event_type        text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 100),
  provider_created  timestamptz NOT NULL,
  tenant_id         uuid REFERENCES core.tenant(id),   -- NULL: not attributable to any tenant (recorded, not applied)
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  outcome           text,
  payload           jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 16384)
);

CREATE TABLE billing.invoice_ref (
  id                       uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id                uuid NOT NULL REFERENCES core.tenant(id),
  provider_invoice_id      text NOT NULL UNIQUE CHECK (provider_invoice_id ~ '^[A-Za-z0-9_]{3,100}$'),
  provider_subscription_id text,
  number                   text CHECK (char_length(number) <= 64),
  amount_minor             bigint NOT NULL,
  currency                 char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status                   text NOT NULL CHECK (status IN ('draft', 'open', 'paid', 'uncollectible', 'void')),
  hosted_url               text CHECK (hosted_url ~ '^https://' AND char_length(hosted_url) <= 2048),
  provider_event_created   timestamptz NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_ref_by_tenant ON billing.invoice_ref (tenant_id, created_at DESC);

-- ================================================================ RLS (tenant tables; unset tenant fails closed)
ALTER TABLE billing.subscription ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing.subscription USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE billing.usage_counter ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing.usage_counter USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE billing.usage_consumption ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing.usage_consumption USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE billing.provider_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing.provider_event USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE billing.invoice_ref ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing.invoice_ref USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- ================================================================ plans are immutable
-- Only valid_to (set once, to retire), is_public and sort_order may change. Price, interval, currency, code, provider
-- price and limits never change: a new price is a new row. Entitlements never change at all.
CREATE FUNCTION billing.guard_plan_update() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (NEW.id, NEW.code, NEW.display_key, NEW.billing_interval, NEW.currency, NEW.unit_amount_minor, NEW.is_fallback,
      NEW.provider_price_id, NEW.valid_from, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.code, OLD.display_key, OLD.billing_interval, OLD.currency, OLD.unit_amount_minor, OLD.is_fallback,
      OLD.provider_price_id, OLD.valid_from, OLD.created_at) THEN
    RAISE EXCEPTION 'billing.plan is immutable: create a new plan row for a new price or limits' USING ERRCODE = '55000';
  END IF;
  IF OLD.valid_to IS NOT NULL AND NEW.valid_to IS DISTINCT FROM OLD.valid_to THEN
    RAISE EXCEPTION 'billing.plan.valid_to is already set' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_guard_update BEFORE UPDATE ON billing.plan FOR EACH ROW EXECUTE FUNCTION billing.guard_plan_update();

CREATE FUNCTION billing.deny_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'billing.% is append-only (% denied)', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000'; END $$;
CREATE TRIGGER plan_no_delete BEFORE DELETE OR TRUNCATE ON billing.plan FOR EACH STATEMENT EXECUTE FUNCTION billing.deny_mutation();
CREATE TRIGGER plan_entitlement_no_change BEFORE UPDATE OR DELETE OR TRUNCATE ON billing.plan_entitlement
  FOR EACH STATEMENT EXECUTE FUNCTION billing.deny_mutation();

-- ================================================================ plan seeding (operator role only)
-- p_entitlements: JSON object, key -> integer >= 0 (numeric limit) or boolean. Keys are validated by recon-billing.
CREATE FUNCTION billing.create_plan(
  p_code text, p_display_key text, p_interval text, p_currency text, p_unit_amount_minor bigint,
  p_is_public boolean, p_is_fallback boolean, p_sort_order int, p_provider_price_id text,
  p_valid_from timestamptz, p_entitlements jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_id uuid := uuidv7(); e record;
BEGIN
  IF jsonb_typeof(p_entitlements) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'entitlements must be a JSON object';
  END IF;
  INSERT INTO billing.plan(id, code, display_key, billing_interval, currency, unit_amount_minor, is_public, is_fallback,
                           sort_order, provider_price_id, valid_from)
  VALUES (v_id, p_code, p_display_key, p_interval, p_currency, p_unit_amount_minor, p_is_public, p_is_fallback,
          p_sort_order, p_provider_price_id, coalesce(p_valid_from, now()));
  FOR e IN SELECT k.key, k.value FROM jsonb_each(p_entitlements) AS k LOOP
    IF jsonb_typeof(e.value) = 'boolean' THEN
      INSERT INTO billing.plan_entitlement(plan_id, key, bool_value) VALUES (v_id, e.key, (e.value)::boolean);
    ELSIF jsonb_typeof(e.value) = 'number' AND (e.value)::text ~ '^(0|[1-9][0-9]{0,17})$' THEN
      INSERT INTO billing.plan_entitlement(plan_id, key, int_value) VALUES (v_id, e.key, (e.value)::text::bigint);
    ELSE
      RAISE EXCEPTION 'entitlement % must be a non-negative integer or a boolean', e.key;
    END IF;
  END LOOP;
  RETURN v_id;
END $$;

-- Retire a plan: no new subscriptions on it (existing subscriptions keep it). Sets valid_to once.
CREATE FUNCTION billing.retire_plan(p_plan uuid, p_valid_to timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE billing.plan SET valid_to = coalesce(p_valid_to, now()) WHERE id = p_plan AND valid_to IS NULL;
  RETURN FOUND;
END $$;

-- ================================================================ usage period (pure)
-- The usage window containing p_now. Inside [p_start, p_end) that is the subscription's own period; once p_now is past
-- p_end (renewal webhook late or missed) the window rolls forward in whole billing intervals anchored on p_end, so
-- counters reset on time. The provider's next period update then replaces the nominal window.
CREATE FUNCTION billing.usage_period(p_start timestamptz, p_end timestamptz, p_interval text, p_now timestamptz)
RETURNS TABLE (period_start timestamptz, period_end timestamptz)
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE
  v_step int;
  v_k int;
  v_s timestamptz;
  v_e timestamptz;
BEGIN
  IF p_interval NOT IN ('month', 'year') OR p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
    RAISE EXCEPTION 'invalid billing period';
  END IF;
  IF p_now < p_end THEN
    RETURN QUERY SELECT p_start, p_end;
    RETURN;
  END IF;
  v_step := CASE p_interval WHEN 'month' THEN 1 ELSE 12 END;
  -- estimate from the calendar distance, then correct by at most a window or two
  v_k := greatest(0, (extract(year FROM age(p_now, p_end))::int * 12 + extract(month FROM age(p_now, p_end))::int) / v_step - 1);
  LOOP
    v_s := p_end + make_interval(months => v_k * v_step);
    v_e := p_end + make_interval(months => (v_k + 1) * v_step);
    IF v_s > p_now AND v_k > 0 THEN
      v_k := v_k - 1;
    ELSIF v_e <= p_now THEN
      v_k := v_k + 1;
    ELSE
      EXIT;
    END IF;
    IF v_k > 100000 THEN RAISE EXCEPTION 'billing period out of range'; END IF;
  END LOOP;
  RETURN QUERY SELECT v_s, v_e;
END $$;

-- ================================================================ metered consumption (race-safe, idempotent)
-- Returns one row: outcome 'allowed' | 'replayed' | 'limit_exceeded' | 'key_reused', and the counter value
-- (after the increment for 'allowed', unchanged otherwise). The limit and the period window are decided by the caller
-- from the tenant's entitlements INSIDE the same tenant-bound transaction (recon-billing); the increment itself is one
-- conditional UPDATE, so concurrent consumers serialise on the counter row and can never push it past p_limit.
-- A replay (same tenant, metric, idempotency key) never counts twice; same key with another amount is 'key_reused'.
CREATE FUNCTION billing.consume_usage(
  p_tenant uuid, p_metric text, p_amount bigint, p_key text, p_period_start timestamptz, p_limit bigint
) RETURNS TABLE (outcome text, used bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_n bigint;
  v_prev_amount bigint;
  v_prev_period timestamptz;
  v_used bigint;
BEGIN
  PERFORM privacy.require_bound_tenant(p_tenant);
  IF p_amount IS NULL OR p_amount <= 0 OR p_limit IS NULL OR p_limit < 0 THEN
    RAISE EXCEPTION 'amount must be positive and limit non-negative' USING ERRCODE = '22023';
  END IF;

  INSERT INTO billing.usage_consumption(tenant_id, metric, idempotency_key, period_start, amount)
  VALUES (p_tenant, p_metric, p_key, p_period_start, p_amount)
  ON CONFLICT (tenant_id, metric, idempotency_key) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  IF v_n = 0 THEN
    SELECT c.amount, c.period_start INTO v_prev_amount, v_prev_period
      FROM billing.usage_consumption AS c
     WHERE c.tenant_id = p_tenant AND c.metric = p_metric AND c.idempotency_key = p_key;
    SELECT u.quantity INTO v_used FROM billing.usage_counter AS u
     WHERE u.tenant_id = p_tenant AND u.metric = p_metric AND u.period_start = v_prev_period;
    RETURN QUERY SELECT CASE WHEN v_prev_amount = p_amount THEN 'replayed' ELSE 'key_reused' END, coalesce(v_used, 0::bigint);
    RETURN;
  END IF;

  INSERT INTO billing.usage_counter(tenant_id, metric, period_start, quantity)
  VALUES (p_tenant, p_metric, p_period_start, 0)
  ON CONFLICT (tenant_id, metric, period_start) DO NOTHING;

  UPDATE billing.usage_counter AS u
     SET quantity = u.quantity + p_amount, updated_at = now()
   WHERE u.tenant_id = p_tenant AND u.metric = p_metric AND u.period_start = p_period_start
     AND u.quantity + p_amount <= p_limit
  RETURNING u.quantity INTO v_used;

  IF NOT FOUND THEN
    DELETE FROM billing.usage_consumption AS c
     WHERE c.tenant_id = p_tenant AND c.metric = p_metric AND c.idempotency_key = p_key;
    SELECT u.quantity INTO v_used FROM billing.usage_counter AS u
     WHERE u.tenant_id = p_tenant AND u.metric = p_metric AND u.period_start = p_period_start;
    RETURN QUERY SELECT 'limit_exceeded'::text, coalesce(v_used, 0::bigint);
    RETURN;
  END IF;
  RETURN QUERY SELECT 'allowed'::text, v_used;
END $$;

-- ================================================================ provider webhook application
-- Cross-tenant lookup used by the webhook handler BEFORE it can bind a tenant (same pattern as api.lookup_api_key, 0006):
-- the subscription row we already know wins, then the tenant id we put into provider metadata (only if it exists),
-- then the provider customer. Returns NULL when the event cannot be attributed.
CREATE FUNCTION billing.resolve_tenant(p_hint uuid, p_provider_subscription text, p_provider_customer text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v uuid;
BEGIN
  IF p_provider_subscription IS NOT NULL THEN
    SELECT s.tenant_id INTO v FROM billing.subscription AS s
     WHERE s.provider = 'stripe' AND s.provider_subscription_id = p_provider_subscription;
    IF FOUND THEN RETURN v; END IF;
  END IF;
  IF p_hint IS NOT NULL THEN
    SELECT t.id INTO v FROM core.tenant AS t WHERE t.id = p_hint;
    IF FOUND THEN RETURN v; END IF;
  END IF;
  IF p_provider_customer IS NOT NULL THEN
    SELECT s.tenant_id INTO v FROM billing.subscription AS s
     WHERE s.provider = 'stripe' AND s.provider_customer_id = p_provider_customer
     ORDER BY s.created_at DESC LIMIT 1;
    IF FOUND THEN RETURN v; END IF;
  END IF;
  RETURN NULL;
END $$;

-- An event no tenant can be attributed to (other products on the same provider account): recorded, never applied.
CREATE FUNCTION billing.record_unattributed_event(p_event_id text, p_type text, p_created timestamptz, p_payload jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_n bigint;
BEGIN
  INSERT INTO billing.provider_event(provider_event_id, event_type, provider_created, tenant_id, processed_at, outcome, payload)
  VALUES (p_event_id, p_type, p_created, NULL, now(), 'unattributed', p_payload)
  ON CONFLICT (provider_event_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END $$;

-- First step of every applied event: claim the provider event id. false = already processed (redelivery).
-- Concurrent deliveries of the same event serialise on the unique index; the loser sees the winner's commit.
CREATE FUNCTION billing.claim_event(p_tenant uuid, p_event_id text, p_type text, p_created timestamptz, p_payload jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_n bigint;
BEGIN
  PERFORM privacy.require_bound_tenant(p_tenant);
  INSERT INTO billing.provider_event(provider_event_id, event_type, provider_created, tenant_id, payload)
  VALUES (p_event_id, p_type, p_created, p_tenant, p_payload)
  ON CONFLICT (provider_event_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END $$;

CREATE FUNCTION billing.finish_event(p_event_id text, p_outcome text) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  UPDATE billing.provider_event SET processed_at = now(), outcome = p_outcome WHERE provider_event_id = p_event_id
  RETURNING outcome
$$;

-- customer.subscription.created|updated|deleted. p_status is already mapped to this schema's vocabulary.
-- Returns the outcome: 'created' | 'updated' | 'unchanged' | 'stale' | 'conflict' | 'ignored_unknown_canceled'
--   | 'duplicate' | 'unknown_price' (nothing recorded; the caller MUST roll back and let the provider retry).
CREATE FUNCTION billing.apply_subscription_event(
  p_tenant uuid, p_event_id text, p_event_type text, p_event_created timestamptz,
  p_provider_subscription text, p_provider_customer text, p_price_id text, p_status text,
  p_period_start timestamptz, p_period_end timestamptz, p_cancel_at_period_end boolean, p_payload jsonb
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_plan uuid;
  v_plan_code text;
  v_row billing.subscription%ROWTYPE;
  v_found boolean;
  v_other boolean;
  v_past_due_since timestamptz;
  v_changed boolean := false;
  v_to_plan uuid;
  v_to_code text;
BEGIN
  PERFORM privacy.require_bound_tenant(p_tenant);
  IF p_status NOT IN ('trialing', 'active', 'past_due', 'canceled', 'incomplete') THEN
    RAISE EXCEPTION 'unsupported subscription status' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM billing.subscription AS s
   WHERE s.provider = 'stripe' AND s.provider_subscription_id = p_provider_subscription FOR UPDATE;
  v_found := FOUND;

  SELECT pl.id, pl.code INTO v_plan, v_plan_code FROM billing.plan AS pl WHERE pl.provider_price_id = p_price_id;
  IF v_plan IS NULL AND p_status <> 'canceled' THEN
    RETURN 'unknown_price';
  END IF;

  IF NOT billing.claim_event(p_tenant, p_event_id, p_event_type, p_event_created, p_payload) THEN
    RETURN 'duplicate';
  END IF;

  IF NOT v_found THEN
    IF p_status = 'canceled' THEN
      RETURN billing.finish_event(p_event_id, 'ignored_unknown_canceled');
    END IF;
    SELECT EXISTS (SELECT 1 FROM billing.subscription AS s WHERE s.tenant_id = p_tenant AND s.status <> 'canceled') INTO v_other;
    IF v_other THEN
      RETURN billing.finish_event(p_event_id, 'conflict');
    END IF;
    INSERT INTO billing.subscription(tenant_id, plan_id, status, current_period_start, current_period_end,
                                     cancel_at_period_end, past_due_since, provider_customer_id,
                                     provider_subscription_id, provider_event_created)
    VALUES (p_tenant, v_plan, p_status, p_period_start, p_period_end, p_cancel_at_period_end,
            CASE WHEN p_status = 'past_due' THEN p_event_created END, p_provider_customer,
            p_provider_subscription, p_event_created);
    PERFORM ledger.append_event_jcs(p_tenant, 'billing.subscription.created', 'system', 'billing.stripe_webhook',
              jsonb_build_object('plan_id', v_plan::text, 'plan_code', v_plan_code, 'status', p_status, 'event', p_event_id));
    RETURN billing.finish_event(p_event_id, 'created');
  END IF;

  IF v_row.tenant_id <> p_tenant OR p_event_created < v_row.provider_event_created THEN
    RETURN billing.finish_event(p_event_id, CASE WHEN v_row.tenant_id <> p_tenant THEN 'conflict' ELSE 'stale' END);
  END IF;
  IF v_row.status = 'canceled' AND p_status <> 'canceled' THEN
    SELECT EXISTS (SELECT 1 FROM billing.subscription AS s
                    WHERE s.tenant_id = p_tenant AND s.status <> 'canceled' AND s.id <> v_row.id) INTO v_other;
    IF v_other THEN
      RETURN billing.finish_event(p_event_id, 'conflict');
    END IF;
  END IF;

  v_to_plan := coalesce(v_plan, v_row.plan_id);
  v_past_due_since := CASE WHEN p_status <> 'past_due' THEN NULL
                           WHEN v_row.status = 'past_due' THEN v_row.past_due_since
                           ELSE p_event_created END;

  UPDATE billing.subscription AS s
     SET plan_id = v_to_plan, status = p_status,
         current_period_start = coalesce(p_period_start, s.current_period_start),
         current_period_end = coalesce(p_period_end, s.current_period_end),
         cancel_at_period_end = p_cancel_at_period_end,
         past_due_since = v_past_due_since,
         provider_customer_id = coalesce(s.provider_customer_id, p_provider_customer),
         provider_event_created = p_event_created, updated_at = now()
   WHERE s.id = v_row.id;

  SELECT pl.code INTO v_to_code FROM billing.plan AS pl WHERE pl.id = v_to_plan;
  IF v_to_plan <> v_row.plan_id THEN
    v_changed := true;
    PERFORM ledger.append_event_jcs(p_tenant, 'billing.subscription.plan_changed', 'system', 'billing.stripe_webhook',
              jsonb_build_object('from_plan_id', v_row.plan_id::text, 'to_plan_id', v_to_plan::text,
                                 'plan_code', v_to_code, 'event', p_event_id));
  END IF;
  IF p_status <> v_row.status THEN
    v_changed := true;
    PERFORM ledger.append_event_jcs(p_tenant, 'billing.subscription.status_changed', 'system', 'billing.stripe_webhook',
              jsonb_build_object('plan_id', v_to_plan::text, 'from_status', v_row.status, 'to_status', p_status,
                                 'event', p_event_id));
  END IF;
  IF p_cancel_at_period_end <> v_row.cancel_at_period_end THEN
    v_changed := true;
    PERFORM ledger.append_event_jcs(p_tenant, 'billing.subscription.cancel_at_period_end_changed', 'system',
              'billing.stripe_webhook',
              jsonb_build_object('plan_id', v_to_plan::text, 'cancel_at_period_end', p_cancel_at_period_end,
                                 'event', p_event_id));
  END IF;
  RETURN billing.finish_event(p_event_id, CASE WHEN v_changed THEN 'updated' ELSE 'unchanged' END);
END $$;

-- checkout.session.completed (mode=subscription): link the provider customer/subscription to the tenant. Grants no
-- entitlement by itself (the row it may create is 'incomplete'); customer.subscription.* events carry the real status.
-- Outcome: 'linked' | 'created_incomplete' | 'ignored' | 'duplicate'.
CREATE FUNCTION billing.apply_checkout_completed(
  p_tenant uuid, p_event_id text, p_event_type text, p_event_created timestamptz,
  p_provider_subscription text, p_provider_customer text, p_plan uuid, p_payload jsonb
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_row billing.subscription%ROWTYPE;
  v_other boolean;
BEGIN
  PERFORM privacy.require_bound_tenant(p_tenant);
  IF NOT billing.claim_event(p_tenant, p_event_id, p_event_type, p_event_created, p_payload) THEN
    RETURN 'duplicate';
  END IF;
  IF p_provider_subscription IS NULL THEN
    RETURN billing.finish_event(p_event_id, 'ignored');
  END IF;
  SELECT * INTO v_row FROM billing.subscription AS s
   WHERE s.provider = 'stripe' AND s.provider_subscription_id = p_provider_subscription FOR UPDATE;
  IF FOUND THEN
    IF v_row.tenant_id = p_tenant AND v_row.provider_customer_id IS NULL AND p_provider_customer IS NOT NULL THEN
      UPDATE billing.subscription SET provider_customer_id = p_provider_customer, updated_at = now() WHERE id = v_row.id;
    END IF;
    RETURN billing.finish_event(p_event_id, 'linked');
  END IF;
  IF p_plan IS NULL OR NOT EXISTS (SELECT 1 FROM billing.plan AS pl WHERE pl.id = p_plan) THEN
    RETURN billing.finish_event(p_event_id, 'ignored');
  END IF;
  SELECT EXISTS (SELECT 1 FROM billing.subscription AS s WHERE s.tenant_id = p_tenant AND s.status <> 'canceled') INTO v_other;
  IF v_other THEN
    RETURN billing.finish_event(p_event_id, 'ignored');
  END IF;
  INSERT INTO billing.subscription(tenant_id, plan_id, status, provider_customer_id, provider_subscription_id, provider_event_created)
  VALUES (p_tenant, p_plan, 'incomplete', p_provider_customer, p_provider_subscription, p_event_created);
  RETURN billing.finish_event(p_event_id, 'created_incomplete');
END $$;

-- invoice.paid | invoice.payment_failed: keep a reference row (amount, currency, status, hosted link) per invoice.
-- Subscription status is NOT derived from invoice events; the provider's customer.subscription.updated is authoritative.
-- Outcome: 'recorded' | 'stale' | 'duplicate'.
CREATE FUNCTION billing.apply_invoice_event(
  p_tenant uuid, p_event_id text, p_event_type text, p_event_created timestamptz,
  p_provider_invoice text, p_provider_subscription text, p_number text, p_amount_minor bigint, p_currency text,
  p_status text, p_hosted_url text, p_payload jsonb
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_n bigint;
BEGIN
  PERFORM privacy.require_bound_tenant(p_tenant);
  IF NOT billing.claim_event(p_tenant, p_event_id, p_event_type, p_event_created, p_payload) THEN
    RETURN 'duplicate';
  END IF;
  INSERT INTO billing.invoice_ref AS i(tenant_id, provider_invoice_id, provider_subscription_id, number, amount_minor,
                                       currency, status, hosted_url, provider_event_created)
  VALUES (p_tenant, p_provider_invoice, p_provider_subscription, p_number, p_amount_minor, p_currency, p_status,
          p_hosted_url, p_event_created)
  ON CONFLICT (provider_invoice_id) DO UPDATE
     SET provider_subscription_id = coalesce(EXCLUDED.provider_subscription_id, i.provider_subscription_id),
         number = coalesce(EXCLUDED.number, i.number), amount_minor = EXCLUDED.amount_minor,
         currency = EXCLUDED.currency, status = EXCLUDED.status,
         hosted_url = coalesce(EXCLUDED.hosted_url, i.hosted_url),
         provider_event_created = EXCLUDED.provider_event_created, updated_at = now()
   WHERE i.tenant_id = EXCLUDED.tenant_id AND i.provider_event_created <= EXCLUDED.provider_event_created;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN billing.finish_event(p_event_id, CASE WHEN v_n = 1 THEN 'recorded' ELSE 'stale' END);
END $$;

-- ================================================================ grants
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'w_billing_admin') THEN
    CREATE ROLE w_billing_admin NOLOGIN;
  END IF;
END $$;

REVOKE ALL ON SCHEMA billing FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION
  billing.guard_plan_update(), billing.deny_mutation(),
  billing.create_plan(text, text, text, text, bigint, boolean, boolean, int, text, timestamptz, jsonb),
  billing.retire_plan(uuid, timestamptz),
  billing.usage_period(timestamptz, timestamptz, text, timestamptz),
  billing.consume_usage(uuid, text, bigint, text, timestamptz, bigint),
  billing.resolve_tenant(uuid, text, text),
  billing.record_unattributed_event(text, text, timestamptz, jsonb),
  billing.claim_event(uuid, text, text, timestamptz, jsonb),
  billing.finish_event(text, text),
  billing.apply_subscription_event(uuid, text, text, timestamptz, text, text, text, text, timestamptz, timestamptz, boolean, jsonb),
  billing.apply_checkout_completed(uuid, text, text, timestamptz, text, text, uuid, jsonb),
  billing.apply_invoice_event(uuid, text, text, timestamptz, text, text, text, bigint, text, text, text, jsonb)
  FROM PUBLIC;

-- command handlers: read plans and their own billing rows (RLS), call the narrow functions
GRANT USAGE ON SCHEMA billing TO w_cmd;
GRANT SELECT ON billing.plan, billing.plan_entitlement, billing.subscription, billing.usage_counter, billing.invoice_ref TO w_cmd;
GRANT EXECUTE ON FUNCTION
  billing.usage_period(timestamptz, timestamptz, text, timestamptz),
  billing.consume_usage(uuid, text, bigint, text, timestamptz, bigint),
  billing.resolve_tenant(uuid, text, text),
  billing.record_unattributed_event(text, text, timestamptz, jsonb),
  billing.apply_subscription_event(uuid, text, text, timestamptz, text, text, text, text, timestamptz, timestamptz, boolean, jsonb),
  billing.apply_checkout_completed(uuid, text, text, timestamptz, text, text, uuid, jsonb),
  billing.apply_invoice_event(uuid, text, text, timestamptz, text, text, text, bigint, text, text, text, jsonb)
  TO w_cmd;

-- plan seeding: operator role only (prices are data, inserted by an operator; never by the API role)
GRANT USAGE ON SCHEMA billing TO w_billing_admin;
GRANT SELECT ON billing.plan, billing.plan_entitlement TO w_billing_admin;
GRANT EXECUTE ON FUNCTION
  billing.create_plan(text, text, text, text, bigint, boolean, boolean, int, text, timestamptz, jsonb),
  billing.retire_plan(uuid, timestamptz)
  TO w_billing_admin;

-- ================================================================ classification (every column; billing is W-only so CI L4's
-- replicated-schema scan does not read these, but the grammar is kept so the schema can be added to L4's unpublished set)
COMMENT ON COLUMN billing.plan.id IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.plan.code IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.plan.display_key IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.plan.billing_interval IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.plan.currency IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.plan.unit_amount_minor IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.plan.is_public IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.plan.is_fallback IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.plan.sort_order IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.plan.provider_price_id IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.plan.valid_from IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.plan.valid_to IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.plan.created_at IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.plan_entitlement.plan_id IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.plan_entitlement.key IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.plan_entitlement.int_value IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.plan_entitlement.bool_value IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.subscription.id IS 'class=internal;basis=contract_6_1_b;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.subscription.tenant_id IS 'class=internal;basis=contract_6_1_b;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.subscription.plan_id IS 'class=internal;basis=contract_6_1_b;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.subscription.status IS 'class=internal;basis=contract_6_1_b;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.subscription.current_period_start IS 'class=internal;basis=contract_6_1_b;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.subscription.current_period_end IS 'class=internal;basis=contract_6_1_b;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.subscription.cancel_at_period_end IS 'class=internal;basis=contract_6_1_b;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.subscription.past_due_since IS 'class=internal;basis=contract_6_1_b;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.subscription.provider IS 'class=internal;basis=contract_6_1_b;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.subscription.provider_customer_id IS 'class=internal;basis=contract_6_1_b;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.subscription.provider_subscription_id IS 'class=internal;basis=contract_6_1_b;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.subscription.provider_event_created IS 'class=internal;basis=contract_6_1_b;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.subscription.created_at IS 'class=internal;basis=contract_6_1_b;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.subscription.updated_at IS 'class=internal;basis=contract_6_1_b;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.usage_counter.tenant_id IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.usage_counter.metric IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.usage_counter.period_start IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.usage_counter.quantity IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.usage_counter.updated_at IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.usage_consumption.tenant_id IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.usage_consumption.metric IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.usage_consumption.idempotency_key IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.usage_consumption.period_start IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.usage_consumption.amount IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.usage_consumption.consumed_at IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.provider_event.id IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.provider_event.provider IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.provider_event.provider_event_id IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.provider_event.event_type IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.provider_event.provider_created IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.provider_event.tenant_id IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.provider_event.received_at IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.provider_event.processed_at IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.provider_event.outcome IS 'class=internal;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.provider_event.payload IS 'class=financial;basis=contract_6_1_b;retention=operational;encrypted=none';
COMMENT ON COLUMN billing.invoice_ref.id IS 'class=internal;basis=gdpr_6_1_c;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.invoice_ref.tenant_id IS 'class=internal;basis=gdpr_6_1_c;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.invoice_ref.provider_invoice_id IS 'class=internal;basis=gdpr_6_1_c;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.invoice_ref.provider_subscription_id IS 'class=internal;basis=gdpr_6_1_c;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.invoice_ref.number IS 'class=financial;basis=gdpr_6_1_c;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.invoice_ref.amount_minor IS 'class=financial;basis=gdpr_6_1_c;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.invoice_ref.currency IS 'class=financial;basis=gdpr_6_1_c;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.invoice_ref.status IS 'class=financial;basis=gdpr_6_1_c;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.invoice_ref.hosted_url IS 'class=secret;basis=gdpr_6_1_c;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.invoice_ref.provider_event_created IS 'class=internal;basis=gdpr_6_1_c;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.invoice_ref.created_at IS 'class=internal;basis=gdpr_6_1_c;retention=tax_record;encrypted=none';
COMMENT ON COLUMN billing.invoice_ref.updated_at IS 'class=internal;basis=gdpr_6_1_c;retention=tax_record;encrypted=none';
