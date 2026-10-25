-- Grants for the logical-replication login `repl_r` on cluster W (DatabaseInfo.md §6: "REPLICATION; SELECT on published tables").
--
-- Single source of truth: used by the Helm migration Job (ConfigMap built from this file) AND mounted by
-- infra/compose/docker-compose.yml. Idempotent; runs as the database owner AFTER `recon-migrate up --target w`
-- and BEFORE `recon-migrate subscribe`. Re-run on every upgrade so tables added by new migrations are covered.
--
-- The schema list is exactly the publication in migrations/w/0001_init.sql:
--   CREATE PUBLICATION recon_pub FOR TABLES IN SCHEMA core, ingest, recon, rules, ledger, privacy, ops;
-- (`api` is intentionally absent: API-key hashes must never reach R.)
-- The role itself (LOGIN REPLICATION, password from a Secret) is created by the deployment, not by migrations:
--   Kubernetes: infra/k8s/cnpg/w-cluster.yaml spec.managed.roles; compose: infra/compose/init/roles.sh.

GRANT USAGE ON SCHEMA core, ingest, recon, rules, ledger, privacy, ops TO repl_r;
GRANT SELECT ON ALL TABLES IN SCHEMA core, ingest, recon, rules, ledger, privacy, ops TO repl_r;
