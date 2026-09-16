CREATE TABLE IF NOT EXISTS settlement_batches (
  batch_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_checksum TEXT NOT NULL,
  file_key TEXT NOT NULL UNIQUE,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  rows_json JSONB NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS settlement_batches_tenant_period_idx
  ON settlement_batches (tenant_id, period_start, period_end);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  run_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES settlement_batches (batch_id) ON DELETE RESTRICT,
  rule_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'EXCEPTION')),
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  item_count INTEGER NOT NULL CHECK (item_count >= 0),
  exception_count INTEGER NOT NULL CHECK (exception_count >= 0),
  UNIQUE (batch_id, rule_version, idempotency_key)
);

CREATE INDEX IF NOT EXISTS reconciliation_runs_tenant_idx
  ON reconciliation_runs (tenant_id, created_at);

CREATE TABLE IF NOT EXISTS reconciliation_items (
  item_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES reconciliation_runs (run_id) ON DELETE RESTRICT,
  batch_id TEXT NOT NULL REFERENCES settlement_batches (batch_id) ON DELETE RESTRICT,
  row_number INTEGER NOT NULL CHECK (row_number > 1),
  settlement_id TEXT NOT NULL,
  external_payment_id TEXT NOT NULL,
  payment_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('MATCHED', 'EXCEPTION')),
  category TEXT CHECK (category IN ('MISSING_PAYMENT', 'DUPLICATE_SETTLEMENT', 'AMOUNT_MISMATCH', 'FEE_MISMATCH', 'SETTLEMENT_DELAYED')),
  severity TEXT CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH')),
  expected_minor BIGINT,
  observed_minor BIGINT,
  difference_minor BIGINT,
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  evidence_json JSONB NOT NULL,
  rule_version TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS reconciliation_items_run_idx ON reconciliation_items (run_id, status);
CREATE INDEX IF NOT EXISTS reconciliation_items_payment_idx ON reconciliation_items (external_payment_id);

CREATE TABLE IF NOT EXISTS exception_cases (
  exception_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES reconciliation_runs (run_id) ON DELETE RESTRICT,
  item_id TEXT NOT NULL REFERENCES reconciliation_items (item_id) ON DELETE RESTRICT,
  batch_id TEXT NOT NULL REFERENCES settlement_batches (batch_id) ON DELETE RESTRICT,
  category TEXT NOT NULL CHECK (category IN ('MISSING_PAYMENT', 'DUPLICATE_SETTLEMENT', 'AMOUNT_MISMATCH', 'FEE_MISMATCH', 'SETTLEMENT_DELAYED')),
  severity TEXT NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH')),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'REPROCESSING', 'RESOLVED')),
  expected_minor BIGINT,
  observed_minor BIGINT,
  difference_minor BIGINT,
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  evidence_json JSONB NOT NULL,
  rule_version TEXT NOT NULL,
  reprocessable BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolution TEXT
);

CREATE INDEX IF NOT EXISTS exception_cases_tenant_status_idx
  ON exception_cases (tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS exception_cases_batch_idx ON exception_cases (batch_id, category);

INSERT INTO app_metadata (key, value)
VALUES ('settlement_version', 'phase-3')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
