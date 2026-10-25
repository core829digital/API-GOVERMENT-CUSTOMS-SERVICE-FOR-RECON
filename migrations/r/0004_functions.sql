-- target: r
-- Tenant iteration helper for projector/verifier without BYPASSRLS.
CREATE FUNCTION core.list_tenant_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, core AS $$
  SELECT id FROM core.tenant ORDER BY id
$$;
REVOKE EXECUTE ON FUNCTION core.list_tenant_ids() FROM PUBLIC;
