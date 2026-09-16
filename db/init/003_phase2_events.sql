CREATE TABLE IF NOT EXISTS event_inbox (
  inbox_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  deduplication_key TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  payload_hash TEXT NOT NULL,
  event_json JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RECEIVED', 'PROCESSING', 'APPLIED', 'REJECTED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  received_at TIMESTAMPTZ NOT NULL,
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS event_inbox_status_idx ON event_inbox (status, received_at);
CREATE INDEX IF NOT EXISTS event_inbox_tenant_idx ON event_inbox (tenant_id, received_at);

CREATE TABLE IF NOT EXISTS event_outbox (
  outbox_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  event_json JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL,
  last_error TEXT,
  published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS event_outbox_claim_idx
  ON event_outbox (status, available_at, outbox_id);

INSERT INTO app_metadata (key, value)
VALUES ('events_version', 'phase-2')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
