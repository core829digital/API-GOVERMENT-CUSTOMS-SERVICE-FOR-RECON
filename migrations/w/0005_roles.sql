-- target: w
-- Group roles (NOLOGIN). Deployment grants membership to login roles. Application roles own no objects (R-DB-12).
-- Superseding DatabaseInfo.md §6 detail: RLS is ENABLEd (not FORCEd) on tenant tables; safe because no application role
-- is a table owner. A CI grant test asserts that.

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['w_admin','w_cmd','w_worker','w_anchor','w_verifier'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
  END LOOP;
END $$;

REVOKE ALL ON SCHEMA core, ingest, recon, rules, ledger, privacy, ops, api FROM PUBLIC;

-- w_admin: tenant creation only
GRANT USAGE ON SCHEMA core TO w_admin;
GRANT EXECUTE ON FUNCTION core.create_tenant(text) TO w_admin;

-- w_cmd: command handlers
GRANT USAGE ON SCHEMA core, ingest, recon, rules, ledger, privacy, api TO w_cmd;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA core, ingest, recon, privacy, api TO w_cmd;
GRANT SELECT ON ALL TABLES IN SCHEMA rules TO w_cmd;
GRANT SELECT ON ledger.audit_event TO w_cmd;
GRANT EXECUTE ON FUNCTION ledger.append_event(uuid, text, text, text, jsonb, bytea) TO w_cmd;

-- w_worker: everything w_cmd can do + tenant iteration
GRANT w_cmd TO w_worker;
GRANT EXECUTE ON FUNCTION core.list_tenant_ids() TO w_worker, w_anchor, w_verifier;

-- w_anchor: timestamp anchoring
GRANT USAGE ON SCHEMA core, ledger TO w_anchor;
GRANT SELECT, INSERT ON ledger.chain_anchor TO w_anchor;
GRANT SELECT ON ledger.audit_event TO w_anchor;

-- w_verifier: read everything replicated, write verdicts
GRANT USAGE ON SCHEMA core, ingest, recon, rules, ledger, privacy, ops TO w_verifier;
GRANT SELECT ON ALL TABLES IN SCHEMA core, ingest, recon, rules, ledger, privacy, ops TO w_verifier;
GRANT INSERT ON ops.fidelity_check TO w_verifier;
