-- target: r
-- R: replicated schemas (no api) + derived schemas proj/vec/fidelity
-- Generated from DatabaseInfo.md DDL blocks (validated on PostgreSQL 18.6, see Progress.md §7). Edit DatabaseInfo.md first, then regenerate.

-- ===== schemas (W). R creates the same replicated schemas except `api`, plus proj, vec, fidelity =====
CREATE SCHEMA core; CREATE SCHEMA ingest; CREATE SCHEMA recon; CREATE SCHEMA rules;
CREATE SCHEMA ledger; CREATE SCHEMA privacy; CREATE SCHEMA ops; 

-- ===== core =====
CREATE TABLE core.tenant (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  name          text NOT NULL,
  data_region   text NOT NULL CHECK (data_region IN ('eu')),  -- extendable only via ADR
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- privacy.subject_key is defined here (not under "privacy" below) because core.legal_entity references it
CREATE TABLE privacy.subject_key (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES core.tenant(id),
  wrapped_dek bytea,                       -- wrapped by EU KMS KEK; useless without KMS; NULL once shredded
  kek_ref text NOT NULL,
  state text NOT NULL CHECK (state IN ('active','shredded')),
  shredded_at timestamptz,
  CHECK ((state = 'active') = (wrapped_dek IS NOT NULL))
);

CREATE TABLE core.legal_entity (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES core.tenant(id),
  country       char(2) NOT NULL,
  vat_id_ct     bytea,            -- ciphertext, envelope-encrypted
  vat_id_key_id uuid REFERENCES privacy.subject_key(id),
  vat_id_hmac   bytea,            -- keyed HMAC for exact-match lookups without decryption
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ===== ingest =====
CREATE TABLE ingest.source_batch (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES core.tenant(id),
  source_type   text NOT NULL,                -- 'erp_ledger','kseF_status','vat_return',...
  period_start  date, period_end date,
  object_uri    text NOT NULL,                -- EU object storage
  sha256        bytea NOT NULL CHECK (octet_length(sha256)=32),
  status        text NOT NULL CHECK (status IN ('registered','parsing','parsed','failed')),
  failure_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_type, sha256)     -- same file twice = same batch
);

CREATE TABLE ingest.source_record (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL,
  batch_id      uuid NOT NULL REFERENCES ingest.source_batch(id),
  record_kind   text NOT NULL,                -- 'invoice','return_box','customs_line',...
  canonical     jsonb NOT NULL,               -- no direct PII; refs to core.*
  record_sha256 bytea NOT NULL CHECK (octet_length(record_sha256)=32),
  UNIQUE (batch_id, record_sha256)
);
CREATE INDEX ON ingest.source_record (tenant_id, record_kind);

-- ===== rules =====
CREATE TABLE rules.rule_pack (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  name text NOT NULL, jurisdiction text NOT NULL,       -- 'EU','RO','PL',...
  version text NOT NULL,                                -- semver
  content_sha256 bytea NOT NULL,
  valid_from date NOT NULL, valid_to date,
  last_reviewed date NOT NULL, reviewed_by text NOT NULL,
  UNIQUE (name, jurisdiction, version)
);
CREATE TABLE rules.rule (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  pack_id uuid NOT NULL REFERENCES rules.rule_pack(id),
  code text NOT NULL,
  source_ref text NOT NULL,       -- CELEX/ELI or official URL
  article text NOT NULL,
  accessed_on date NOT NULL,
  UNIQUE (pack_id, code)
);   -- NOT NULL on source_ref/article/accessed_on = no uncited rules (Rules R-DOC-1)

CREATE TABLE rules.legal_source (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  jurisdiction text NOT NULL, citation text NOT NULL,
  url text NOT NULL, accessed_on date NOT NULL, language char(2) NOT NULL,
  UNIQUE (citation, language)
);
CREATE TABLE rules.legal_chunk (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  source_id uuid NOT NULL REFERENCES rules.legal_source(id),
  ordinal int NOT NULL, text text NOT NULL,
  text_sha256 bytea NOT NULL,
  UNIQUE (source_id, ordinal)
);

-- ===== recon =====
CREATE TABLE recon.run (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES core.tenant(id),
  rule_pack_id uuid NOT NULL REFERENCES rules.rule_pack(id),
  input_batch_ids uuid[] NOT NULL,
  min_seq bigint NOT NULL,                  -- tenant ledger seq the engine waited for on R (bridge token)
  status text NOT NULL CHECK (status IN ('queued','running','done','failed')),
  started_at timestamptz, finished_at timestamptz
);
CREATE TABLE recon.finding (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES recon.run(id),
  check_code text NOT NULL,                 -- 'C1'..'C8'
  rule_id uuid NOT NULL REFERENCES rules.rule(id),
  severity text NOT NULL CHECK (severity IN ('info','low','medium','high')),
  subject_ref uuid,                         -- opaque; no PII
  input_record_ids uuid[] NOT NULL,
  input_hashes bytea[] NOT NULL,            -- determinism + evidence
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON recon.finding (tenant_id, check_code, severity);

-- ===== ledger (append-only) =====
CREATE TABLE ledger.chain_head (
  tenant_id uuid PRIMARY KEY REFERENCES core.tenant(id),
  last_seq  bigint NOT NULL DEFAULT 0,
  last_hash bytea  NOT NULL DEFAULT decode(repeat('00',32),'hex')
);

CREATE TABLE ledger.audit_event (
  tenant_id      uuid   NOT NULL REFERENCES core.tenant(id),
  seq            bigint NOT NULL,
  id             uuid   NOT NULL DEFAULT uuidv7(),
  event_type     text   NOT NULL,
  actor_type     text   NOT NULL CHECK (actor_type IN ('user','api_key','system')),
  actor_ref      text   NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  payload        jsonb  NOT NULL,                        -- NO PII; opaque refs only
  payload_sha256 bytea  NOT NULL CHECK (octet_length(payload_sha256)=32),
  prev_hash      bytea  NOT NULL CHECK (octet_length(prev_hash)=32),
  hash           bytea  NOT NULL CHECK (octet_length(hash)=32),
  PRIMARY KEY (tenant_id, seq),
  UNIQUE (id)
);

CREATE TABLE ledger.chain_anchor (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid   NOT NULL,
  to_seq      bigint NOT NULL,
  anchor_hash bytea  NOT NULL CHECK (octet_length(anchor_hash)=32),  -- = audit_event.hash at to_seq
  tst         bytea  NOT NULL,                                       -- RFC 3161 TimeStampToken (DER)
  tsa_name    text   NOT NULL,
  qualified   boolean NOT NULL,
  anchored_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, to_seq) REFERENCES ledger.audit_event(tenant_id, seq)
);

-- Immutability: privileges AND triggers
CREATE FUNCTION ledger.deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ledger is append-only (% on %)', TG_OP, TG_TABLE_NAME; END $$;
CREATE TRIGGER audit_event_no_update BEFORE UPDATE OR DELETE ON ledger.audit_event
  FOR EACH ROW EXECUTE FUNCTION ledger.deny_mutation();
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON ledger.audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.deny_mutation();
CREATE TRIGGER chain_anchor_no_update BEFORE UPDATE OR DELETE ON ledger.chain_anchor
  FOR EACH ROW EXECUTE FUNCTION ledger.deny_mutation();
CREATE TRIGGER chain_anchor_no_truncate BEFORE TRUNCATE ON ledger.chain_anchor
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.deny_mutation();

-- ===== privacy =====
CREATE TABLE privacy.retention_policy (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  jurisdiction text NOT NULL,              -- 'RO','DE',...
  data_class  text NOT NULL,               -- 'tax_record', 'ledger', ...
  retention_months int NOT NULL CHECK (retention_months > 0),
  source_ref text NOT NULL, accessed_on date NOT NULL,
  valid_from date NOT NULL, valid_to date,
  UNIQUE (jurisdiction, data_class, valid_from)
);
CREATE TABLE privacy.legal_hold (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL, scope jsonb NOT NULL,
  reason text NOT NULL, placed_by text NOT NULL,
  placed_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz
);

-- ===== ops =====
CREATE TABLE ops.fidelity_check (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  checked_at timestamptz NOT NULL DEFAULT now(),
  table_name text NOT NULL, kind text NOT NULL CHECK (kind IN ('chain_head','range_hash','schema')),
  range_from text, range_to text,
  w_digest bytea, r_digest bytea,
  verdict text NOT NULL CHECK (verdict IN ('match','mismatch_transient','mismatch_persistent'))
);


-- owned by w_migrator; EXECUTE granted to w_cmd / w_worker; search_path pinned
CREATE FUNCTION ledger.append_event(
  p_tenant uuid, p_event_type text, p_actor_type text, p_actor_ref text,
  p_payload jsonb, p_payload_sha256 bytea          -- sha256(JCS(payload)), RFC 8785, computed by app
) RETURNS TABLE (seq bigint, hash bytea)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ledger AS $$
DECLARE h ledger.chain_head%ROWTYPE; v_id uuid := uuidv7(); v_at timestamptz := clock_timestamp(); v_hash bytea;
BEGIN
  SELECT * INTO h FROM ledger.chain_head WHERE tenant_id = p_tenant FOR UPDATE;  -- per-tenant serialisation
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown tenant chain %', p_tenant; END IF;
  v_hash := sha256(
      h.last_hash || uuid_send(p_tenant) || int8send(h.last_seq + 1) || uuid_send(v_id)
   || int4send(octet_length(convert_to(p_event_type,'UTF8'))) || convert_to(p_event_type,'UTF8')
   || int4send(octet_length(convert_to(p_actor_type,'UTF8'))) || convert_to(p_actor_type,'UTF8')
   || int4send(octet_length(convert_to(p_actor_ref ,'UTF8'))) || convert_to(p_actor_ref ,'UTF8')
   || int8send((extract(epoch FROM v_at) * 1000000)::bigint) || p_payload_sha256);
  INSERT INTO ledger.audit_event(tenant_id, seq, id, event_type, actor_type, actor_ref, occurred_at,
                                 payload, payload_sha256, prev_hash, hash)
  VALUES (p_tenant, h.last_seq + 1, v_id, p_event_type, p_actor_type, p_actor_ref, v_at,
          p_payload, p_payload_sha256, h.last_hash, v_hash);
  UPDATE ledger.chain_head SET last_seq = h.last_seq + 1, last_hash = v_hash WHERE tenant_id = p_tenant;
  RETURN QUERY SELECT h.last_seq + 1, v_hash;
END $$;
REVOKE EXECUTE ON FUNCTION ledger.append_event(uuid,text,text,text,jsonb,bytea) FROM PUBLIC;  -- functions are PUBLIC-executable by default

CREATE SCHEMA proj; CREATE SCHEMA vec; CREATE SCHEMA fidelity;
-- proj
CREATE TABLE proj.checkpoint (
  projector text PRIMARY KEY,
  tenant_id uuid NOT NULL, last_seq bigint NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);  -- (projector, tenant_id) composite in the real DDL
CREATE TABLE proj.finding_view (
  finding_id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  check_code text NOT NULL, severity text NOT NULL,
  period daterange, jurisdiction text, summary text NOT NULL,
  rule_citation text NOT NULL, created_at timestamptz NOT NULL
);
CREATE INDEX ON proj.finding_view (tenant_id, created_at DESC);

