-- target: w
-- Privacy procedures (R-PRIV-3, R-PRIV-5): legal holds, erasure decisions (crypto-shred) and retention purge.
--
-- Design (DatabaseInfo.md §9):
--   * Every state change below happens inside ONE SECURITY DEFINER function together with the ledger event that records
--     it, so no application role can erase, purge or hold without leaving a hash-chained record (R-PRIV-3).
--   * Application roles lose direct UPDATE on privacy.subject_key / privacy.legal_hold and INSERT/UPDATE on
--     privacy.retention_policy; w_cmd can only call the functions. Purging is reachable only by w_retention.
--   * Functions run as their owner (a table owner; RLS is ENABLEd, not FORCEd, so the owner bypasses it), therefore each
--     requires the caller's transaction to be bound to the same tenant (`SET LOCAL app.tenant_id`), failing closed.
--   * Nothing here adds a table or column: no R-side migration and no classification change are needed.
--
-- Retention clock (conservative, documented simplification): the retention period of a record starts at its
-- `created_at` and lasts `privacy.retention_policy.retention_months` for (jurisdiction, data_class = 'tax_record') valid
-- today. Jurisdiction-specific start-of-clock rules are NOT modelled yet; when a policy row is missing the procedures
-- REFUSE (never erase or purge on unknown retention).

-- ---------------------------------------------------------------- RFC 8785 (JCS) for the restricted payload shape
-- Supported: objects with printable-ASCII keys, arrays, strings, booleans, null and integers of at most 15 digits.
-- Anything else (floats, big numbers, non-ASCII keys) raises, because SQL cannot reproduce ECMAScript number formatting
-- or UTF-16 key ordering for them. The Rust side (recon-evidence) verifies the stored hash with a full JCS
-- implementation, and tests/privacy.rs asserts both agree for every payload shape used here.
CREATE FUNCTION ledger.jcs_text(p jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE r text;
BEGIN
  CASE jsonb_typeof(p)
    WHEN 'object' THEN
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(p) AS k WHERE k ~ '[^ -~]') THEN
        RAISE EXCEPTION 'jcs: only printable ASCII object keys are supported';
      END IF;
      SELECT '{' || coalesce(string_agg(to_json(e.key)::text || ':' || ledger.jcs_text(e.value), ',' ORDER BY e.key COLLATE "C"), '') || '}'
        INTO r FROM jsonb_each(p) AS e;
    WHEN 'array' THEN
      SELECT '[' || coalesce(string_agg(ledger.jcs_text(e.value), ',' ORDER BY e.ord), '') || ']'
        INTO r FROM jsonb_array_elements(p) WITH ORDINALITY AS e(value, ord);
    WHEN 'string' THEN
      r := to_json(p #>> '{}')::text;
    WHEN 'number' THEN
      IF p::text !~ '^-?(0|[1-9][0-9]{0,14})$' THEN
        RAISE EXCEPTION 'jcs: only integers of at most 15 digits are supported (got %)', p::text;
      END IF;
      r := p::text;
    WHEN 'boolean' THEN
      r := p::text;
    WHEN 'null' THEN
      r := 'null';
  END CASE;
  RETURN r;
END $$;

-- Append with the payload hash computed in SQL. Not SECURITY DEFINER and not granted to anyone: only the owner-run
-- privacy functions below can call it (append_event itself is revoked from PUBLIC).
CREATE FUNCTION ledger.append_event_jcs(
  p_tenant uuid, p_event_type text, p_actor_type text, p_actor_ref text, p_payload jsonb
) RETURNS TABLE (seq bigint, hash bytea)
LANGUAGE sql SET search_path = pg_catalog, ledger AS $$
  SELECT a.seq, a.hash
    FROM ledger.append_event(p_tenant, p_event_type, p_actor_type, p_actor_ref, p_payload,
                             sha256(convert_to(ledger.jcs_text(p_payload), 'UTF8'))) AS a
$$;

-- ---------------------------------------------------------------- tenant guard
CREATE FUNCTION privacy.require_bound_tenant(p_tenant uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
BEGIN
  IF p_tenant IS NULL OR nullif(current_setting('app.tenant_id', true), '') IS DISTINCT FROM p_tenant::text THEN
    RAISE EXCEPTION 'tenant context is not bound to the requested tenant' USING ERRCODE = '42501';
  END IF;
END $$;

-- ---------------------------------------------------------------- legal holds
-- scope: non-empty object; keys: all (boolean), batch_ids (array of lowercase UUID strings),
-- subject_key_ids (array of lowercase UUID strings). A hold is active while released_at IS NULL.
CREATE FUNCTION privacy.place_legal_hold(
  p_tenant uuid, p_scope jsonb, p_reason text, p_placed_by text, p_actor_type text, p_actor_ref text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_id uuid := uuidv7();
  k text;
BEGIN
  PERFORM privacy.require_bound_tenant(p_tenant);
  IF coalesce(btrim(p_reason), '') = '' OR coalesce(btrim(p_placed_by), '') = '' THEN
    RAISE EXCEPTION 'legal hold requires a reason and placed_by';
  END IF;
  IF jsonb_typeof(p_scope) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'legal hold scope must be a JSON object';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_scope) LOOP
    IF k NOT IN ('all', 'batch_ids', 'subject_key_ids') THEN
      RAISE EXCEPTION 'unknown legal hold scope key: %', k;
    END IF;
  END LOOP;
  IF p_scope ? 'all' AND jsonb_typeof(p_scope -> 'all') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'legal hold scope.all must be a boolean';
  END IF;
  FOREACH k IN ARRAY ARRAY['batch_ids', 'subject_key_ids'] LOOP
    IF p_scope ? k THEN
      IF jsonb_typeof(p_scope -> k) IS DISTINCT FROM 'array'
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_scope -> k) AS e
                     WHERE jsonb_typeof(e) <> 'string'
                        OR (e #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
        RAISE EXCEPTION 'legal hold scope.% must be an array of lowercase UUID strings', k;
      END IF;
    END IF;
  END LOOP;
  IF NOT (coalesce((p_scope ->> 'all')::boolean, false)
          OR jsonb_array_length(coalesce(p_scope -> 'batch_ids', '[]'::jsonb)) > 0
          OR jsonb_array_length(coalesce(p_scope -> 'subject_key_ids', '[]'::jsonb)) > 0) THEN
    RAISE EXCEPTION 'legal hold scope selects nothing';
  END IF;

  INSERT INTO privacy.legal_hold(id, tenant_id, scope, reason, placed_by)
  VALUES (v_id, p_tenant, p_scope, p_reason, p_placed_by);
  PERFORM ledger.append_event_jcs(p_tenant, 'privacy.legal_hold.placed', p_actor_type, p_actor_ref,
            jsonb_build_object('hold_id', v_id::text, 'scope', p_scope));
  RETURN v_id;
END $$;

CREATE FUNCTION privacy.release_legal_hold(p_tenant uuid, p_hold uuid, p_actor_type text, p_actor_ref text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM privacy.require_bound_tenant(p_tenant);
  UPDATE privacy.legal_hold SET released_at = now()
   WHERE id = p_hold AND tenant_id = p_tenant AND released_at IS NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM ledger.append_event_jcs(p_tenant, 'privacy.legal_hold.released', p_actor_type, p_actor_ref,
            jsonb_build_object('hold_id', p_hold::text));
  RETURN true;
END $$;

-- ---------------------------------------------------------------- erasure decision (crypto-shred)
-- Returns: 'shredded' | 'already_shredded' | 'not_found' | 'deferred_legal_hold' | 'deferred_no_retention_policy'
--          | 'deferred_retention'. Every outcome except not_found / already_shredded is ledgered.
-- Precedence of deferrals: legal hold, then missing retention policy, then running retention period.
CREATE FUNCTION privacy.process_erasure_request(p_tenant uuid, p_key uuid, p_actor_type text, p_actor_ref text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_state   text;
  v_holds   text[];
  v_missing text[] := ARRAY[]::text[];
  v_until   timestamptz;
  v_this    timestamptz;
  v_months  int;
  v_rec     record;
  v_today   date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  PERFORM privacy.require_bound_tenant(p_tenant);
  SELECT k.state INTO v_state FROM privacy.subject_key AS k WHERE k.id = p_key AND k.tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF v_state = 'shredded' THEN
    RETURN 'already_shredded';
  END IF;

  SELECT coalesce(array_agg(h.id::text ORDER BY h.id), ARRAY[]::text[]) INTO v_holds
    FROM privacy.legal_hold AS h
   WHERE h.tenant_id = p_tenant AND h.released_at IS NULL
     AND (coalesce((h.scope ->> 'all')::boolean, false) OR (h.scope -> 'subject_key_ids') @> to_jsonb(p_key::text));
  IF cardinality(v_holds) > 0 THEN
    PERFORM ledger.append_event_jcs(p_tenant, 'privacy.erasure.deferred', p_actor_type, p_actor_ref,
              jsonb_build_object('key_id', p_key::text, 'reason', 'legal_hold', 'hold_ids', to_jsonb(v_holds)));
    RETURN 'deferred_legal_hold';
  END IF;

  FOR v_rec IN
    SELECT e.country::text AS country, max(e.created_at) AS last_at
      FROM core.legal_entity AS e
     WHERE e.tenant_id = p_tenant AND e.vat_id_key_id = p_key
     GROUP BY e.country
  LOOP
    SELECT rp.retention_months INTO v_months
      FROM privacy.retention_policy AS rp
     WHERE rp.jurisdiction = v_rec.country AND rp.data_class = 'tax_record'
       AND rp.valid_from <= v_today AND (rp.valid_to IS NULL OR rp.valid_to >= v_today)
     ORDER BY rp.valid_from DESC LIMIT 1;
    IF NOT FOUND THEN
      v_missing := v_missing || v_rec.country;
    ELSE
      v_this := ((v_rec.last_at AT TIME ZONE 'UTC') + make_interval(months => v_months)) AT TIME ZONE 'UTC';
      IF v_this > now() AND (v_until IS NULL OR v_this > v_until) THEN
        v_until := v_this;
      END IF;
    END IF;
  END LOOP;

  IF cardinality(v_missing) > 0 THEN
    SELECT array_agg(c ORDER BY c) INTO v_missing FROM unnest(v_missing) AS c;
    PERFORM ledger.append_event_jcs(p_tenant, 'privacy.erasure.deferred', p_actor_type, p_actor_ref,
              jsonb_build_object('key_id', p_key::text, 'reason', 'no_retention_policy', 'jurisdictions', to_jsonb(v_missing)));
    RETURN 'deferred_no_retention_policy';
  END IF;
  IF v_until IS NOT NULL THEN
    PERFORM ledger.append_event_jcs(p_tenant, 'privacy.erasure.deferred', p_actor_type, p_actor_ref,
              jsonb_build_object('key_id', p_key::text, 'reason', 'retention',
                                 'retain_until', to_char(v_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
    RETURN 'deferred_retention';
  END IF;

  -- crypto-shred: the wrapped DEK is the only thing that can decrypt the subject's ciphertext. The table CHECK
  -- ((state = 'active') = (wrapped_dek IS NOT NULL)) makes shredding without nulling the key impossible.
  UPDATE privacy.subject_key SET state = 'shredded', wrapped_dek = NULL, shredded_at = now()
   WHERE id = p_key AND tenant_id = p_tenant;
  PERFORM ledger.append_event_jcs(p_tenant, 'privacy.erasure.shredded', p_actor_type, p_actor_ref,
            jsonb_build_object('key_id', p_key::text));
  RETURN 'shredded';
END $$;

-- ---------------------------------------------------------------- retention purge
-- Deletes expired source batches (and their records) of ONE tenant for one jurisdiction, skipping batches covered by an
-- active legal hold. A batch is expired when coalesce(period_end, created_at::date) is before today minus the policy's
-- retention_months. Returns one row: outcome ('purged' | 'held' | 'nothing_expired' | 'refused_no_retention_policy'),
-- batches purged, records purged, batches skipped because of holds. Ledgered whenever anything was purged, held or refused.
CREATE FUNCTION privacy.purge_expired_batches(p_tenant uuid, p_jurisdiction text, p_actor_type text, p_actor_ref text)
RETURNS TABLE (outcome text, batches_purged int, records_purged bigint, batches_held int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_today  date := (now() AT TIME ZONE 'UTC')::date;
  v_pol    uuid;
  v_months int;
  v_cutoff date;
  v_ids    uuid[];
  v_held   bigint;
  v_nrec   bigint := 0;
BEGIN
  PERFORM privacy.require_bound_tenant(p_tenant);
  IF p_jurisdiction IS NULL OR p_jurisdiction !~ '^[A-Za-z0-9_-]{1,16}$' THEN
    RAISE EXCEPTION 'invalid jurisdiction';
  END IF;

  SELECT rp.id, rp.retention_months INTO v_pol, v_months
    FROM privacy.retention_policy AS rp
   WHERE rp.jurisdiction = p_jurisdiction AND rp.data_class = 'tax_record'
     AND rp.valid_from <= v_today AND (rp.valid_to IS NULL OR rp.valid_to >= v_today)
   ORDER BY rp.valid_from DESC LIMIT 1;
  IF NOT FOUND THEN
    PERFORM ledger.append_event_jcs(p_tenant, 'privacy.purge.refused', p_actor_type, p_actor_ref,
              jsonb_build_object('jurisdiction', p_jurisdiction, 'reason', 'no_retention_policy'));
    RETURN QUERY SELECT 'refused_no_retention_policy'::text, 0, 0::bigint, 0;
    RETURN;
  END IF;

  v_cutoff := (v_today - make_interval(months => v_months))::date;

  WITH cand AS (
    SELECT b.id,
           EXISTS (SELECT 1 FROM privacy.legal_hold AS h
                    WHERE h.tenant_id = p_tenant AND h.released_at IS NULL
                      AND (coalesce((h.scope ->> 'all')::boolean, false)
                           OR (h.scope -> 'batch_ids') @> to_jsonb(b.id::text))) AS is_held
      FROM ingest.source_batch AS b
     WHERE b.tenant_id = p_tenant
       AND coalesce(b.period_end, (b.created_at AT TIME ZONE 'UTC')::date) < v_cutoff
  )
  SELECT coalesce(array_agg(cand.id ORDER BY cand.id) FILTER (WHERE NOT cand.is_held), ARRAY[]::uuid[]),
         count(*) FILTER (WHERE cand.is_held)
    INTO v_ids, v_held
    FROM cand;

  IF cardinality(v_ids) > 0 THEN
    DELETE FROM ingest.source_record WHERE tenant_id = p_tenant AND batch_id = ANY (v_ids);
    GET DIAGNOSTICS v_nrec = ROW_COUNT;
    DELETE FROM ingest.source_batch WHERE tenant_id = p_tenant AND id = ANY (v_ids);
  END IF;

  IF cardinality(v_ids) > 0 OR v_held > 0 THEN
    PERFORM ledger.append_event_jcs(p_tenant, 'privacy.purge.executed', p_actor_type, p_actor_ref,
              jsonb_build_object('jurisdiction', p_jurisdiction, 'data_class', 'tax_record', 'policy_id', v_pol::text,
                                 'cutoff', to_char(v_cutoff, 'YYYY-MM-DD'),
                                 'batches_purged', cardinality(v_ids), 'records_purged', v_nrec,
                                 'batches_held', v_held));
  END IF;

  RETURN QUERY SELECT
    CASE WHEN cardinality(v_ids) > 0 THEN 'purged' WHEN v_held > 0 THEN 'held' ELSE 'nothing_expired' END,
    cardinality(v_ids), v_nrec, v_held::int;
END $$;

-- ---------------------------------------------------------------- grants
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'w_retention') THEN
    CREATE ROLE w_retention NOLOGIN;
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION ledger.jcs_text(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ledger.append_event_jcs(uuid, text, text, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION privacy.require_bound_tenant(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION privacy.place_legal_hold(uuid, jsonb, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION privacy.release_legal_hold(uuid, uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION privacy.process_erasure_request(uuid, uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION privacy.purge_expired_batches(uuid, text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION privacy.place_legal_hold(uuid, jsonb, text, text, text, text) TO w_cmd;
GRANT EXECUTE ON FUNCTION privacy.release_legal_hold(uuid, uuid, text, text) TO w_cmd;
GRANT EXECUTE ON FUNCTION privacy.process_erasure_request(uuid, uuid, text, text) TO w_cmd;

GRANT USAGE ON SCHEMA core, privacy TO w_retention;
GRANT EXECUTE ON FUNCTION core.list_tenant_ids() TO w_retention;
GRANT EXECUTE ON FUNCTION privacy.purge_expired_batches(uuid, text, text, text) TO w_retention;

-- state changes on privacy tables are possible only through the functions above
REVOKE UPDATE ON privacy.subject_key, privacy.legal_hold FROM w_cmd;
REVOKE INSERT, UPDATE ON privacy.retention_policy FROM w_cmd;
