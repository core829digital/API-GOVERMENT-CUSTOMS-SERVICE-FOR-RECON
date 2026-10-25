-- target: w
-- Tenant bootstrap and cross-tenant iteration helpers (SECURITY DEFINER, owner bypasses RLS by design).
-- Every tenant MUST have a ledger chain head: create_tenant() is the only supported way to create one.

CREATE FUNCTION core.create_tenant(p_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, core, ledger AS $$
DECLARE v_id uuid := uuidv7();
BEGIN
  INSERT INTO core.tenant(id, name, data_region) VALUES (v_id, p_name, 'eu');
  INSERT INTO ledger.chain_head(tenant_id) VALUES (v_id);
  -- JCS of {} is "{}"; payload carries no business data by design (R-PRIV-1)
  PERFORM ledger.append_event(v_id, 'tenant.created', 'system', 'core.create_tenant', '{}'::jsonb, sha256('{}'::bytea));
  RETURN v_id;
END $$;

-- Workers/verifiers iterate tenants without BYPASSRLS: they list ids here, then bind app.tenant_id per transaction.
CREATE FUNCTION core.list_tenant_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, core AS $$
  SELECT id FROM core.tenant ORDER BY id
$$;

REVOKE EXECUTE ON FUNCTION core.create_tenant(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.list_tenant_ids() FROM PUBLIC;
