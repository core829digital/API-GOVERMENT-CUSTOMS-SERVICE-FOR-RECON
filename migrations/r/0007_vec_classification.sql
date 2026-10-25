-- target: r
-- Column classification for vec schema
-- Generated from DatabaseInfo.md DDL blocks (validated on PostgreSQL 18.6, see Progress.md §7). Edit DatabaseInfo.md first, then regenerate.

COMMENT ON COLUMN vec.model.id IS 'class=internal;basis=gdpr_6_1_f;retention=operational;encrypted=none';
COMMENT ON COLUMN vec.model.name IS 'class=internal;basis=gdpr_6_1_f;retention=operational;encrypted=none';
COMMENT ON COLUMN vec.model.version IS 'class=internal;basis=gdpr_6_1_f;retention=operational;encrypted=none';
COMMENT ON COLUMN vec.model.dims IS 'class=internal;basis=gdpr_6_1_f;retention=operational;encrypted=none';
COMMENT ON COLUMN vec.model.hosting IS 'class=internal;basis=gdpr_6_1_f;retention=operational;encrypted=none';
COMMENT ON COLUMN vec.model.dpa_ref IS 'class=internal;basis=gdpr_6_1_f;retention=operational;encrypted=none';
COMMENT ON COLUMN vec.legal_chunk_emb_v1.chunk_id IS 'class=internal;basis=gdpr_6_1_f;retention=operational;encrypted=none';
COMMENT ON COLUMN vec.legal_chunk_emb_v1.model_id IS 'class=internal;basis=gdpr_6_1_f;retention=operational;encrypted=none';
COMMENT ON COLUMN vec.legal_chunk_emb_v1.jurisdiction IS 'class=internal;basis=gdpr_6_1_f;retention=operational;encrypted=none';
COMMENT ON COLUMN vec.legal_chunk_emb_v1.embedding IS 'class=internal;basis=gdpr_6_1_f;retention=operational;encrypted=none';
