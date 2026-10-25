-- target: r
-- Group roles (NOLOGIN). The subscription owner is created by deployment (it must be the only writer of replicated tables).
-- r_api has SELECT only and is never granted any write privilege; ReadStore also opens READ ONLY transactions.

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['r_api','r_projector','r_verifier'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
  END LOOP;
END $$;

REVOKE ALL ON SCHEMA core, ingest, recon, rules, ledger, privacy, ops, proj, vec, fidelity FROM PUBLIC;

-- r_api: queries. No access to privacy (key material) or ops.
GRANT USAGE ON SCHEMA core, ingest, recon, rules, ledger, proj, vec TO r_api;
GRANT SELECT ON ALL TABLES IN SCHEMA core, ingest, recon, rules, ledger, proj, vec TO r_api;

-- r_projector: reads replicated data, writes derived schemas only
GRANT USAGE ON SCHEMA core, ingest, recon, rules, ledger, proj, vec TO r_projector;
GRANT SELECT ON ALL TABLES IN SCHEMA core, ingest, recon, rules, ledger TO r_projector;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA proj, vec TO r_projector;
GRANT EXECUTE ON FUNCTION core.list_tenant_ids() TO r_projector, r_verifier;

-- r_verifier: reads all replicated schemas, writes only its scratch schema
GRANT USAGE ON SCHEMA core, ingest, recon, rules, ledger, privacy, ops, fidelity TO r_verifier;
GRANT SELECT ON ALL TABLES IN SCHEMA core, ingest, recon, rules, ledger, privacy, ops TO r_verifier;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA fidelity TO r_verifier;
