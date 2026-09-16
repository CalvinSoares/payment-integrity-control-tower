CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  external_payment_id TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  state TEXT NOT NULL CHECK (state IN (
    'CREATED', 'AUTHORIZED', 'CAPTURED', 'SETTLED', 'PAID_OUT',
    'CANCELED', 'VOIDED', 'REFUNDED', 'CHARGEBACK'
  )),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, external_payment_id)
);

CREATE INDEX IF NOT EXISTS payments_tenant_state_idx ON payments (tenant_id, state);
CREATE INDEX IF NOT EXISTS payments_created_at_idx ON payments (created_at);

CREATE TABLE IF NOT EXISTS ledger_journals (
  journal_id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  line_id TEXT PRIMARY KEY,
  journal_id TEXT NOT NULL REFERENCES ledger_journals (journal_id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reference_type TEXT NOT NULL,
  reference_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ledger_entries_reference_idx
  ON ledger_entries (reference_type, reference_id);
CREATE INDEX IF NOT EXISTS ledger_entries_journal_idx
  ON ledger_entries (journal_id);

CREATE TABLE IF NOT EXISTS idempotency_records (
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_json JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'FAILED')),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, actor_id, operation, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idempotency_expiration_idx
  ON idempotency_records (expires_at);

CREATE TABLE IF NOT EXISTS audit_events (
  audit_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  source_event_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS audit_events_entity_idx
  ON audit_events (entity_type, entity_id, occurred_at);
CREATE INDEX IF NOT EXISTS audit_events_tenant_idx
  ON audit_events (tenant_id, occurred_at);

INSERT INTO app_metadata (key, value)
VALUES ('financial_core_version', 'phase-1')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
