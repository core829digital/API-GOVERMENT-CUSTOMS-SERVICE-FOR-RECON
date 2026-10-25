-- target: w
-- Row-level security on every tenant table (R-SEC-3)
-- Generated from DatabaseInfo.md DDL blocks (validated on PostgreSQL 18.6, see Progress.md §7). Edit DatabaseInfo.md first, then regenerate.

ALTER TABLE core.tenant ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.tenant USING (id = current_setting('app.tenant_id')::uuid);
ALTER TABLE privacy.subject_key ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON privacy.subject_key USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE core.legal_entity ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.legal_entity USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE ingest.source_batch ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ingest.source_batch USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE ingest.source_record ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ingest.source_record USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE recon.run ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON recon.run USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE recon.finding ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON recon.finding USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE ledger.chain_head ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger.chain_head USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE ledger.audit_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger.audit_event USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE ledger.chain_anchor ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger.chain_anchor USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE privacy.legal_hold ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON privacy.legal_hold USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE api.idempotency_key ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api.idempotency_key USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE api.api_key ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api.api_key USING (tenant_id = current_setting('app.tenant_id')::uuid);
