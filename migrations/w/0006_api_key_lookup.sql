-- target: w
-- API-key authentication reads W by design: the `api` schema (secret hashes) is never replicated to R.
-- RLS on api.api_key is keyed by tenant, but the tenant is only known AFTER the key is resolved, so the lookup is a
-- narrow SECURITY DEFINER function (returns only the fields needed to verify and authorise; never lists keys).
CREATE FUNCTION api.lookup_api_key(p_prefix text)
RETURNS TABLE (id uuid, tenant_id uuid, secret_hash bytea, scopes text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, api AS $$
  SELECT k.id, k.tenant_id, k.secret_hash, k.scopes
    FROM api.api_key k
   WHERE k.prefix = p_prefix AND k.revoked_at IS NULL
$$;
REVOKE EXECUTE ON FUNCTION api.lookup_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.lookup_api_key(text) TO w_cmd;
