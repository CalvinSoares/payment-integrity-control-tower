ALTER TABLE event_outbox DROP CONSTRAINT IF EXISTS event_outbox_status_check;
ALTER TABLE event_outbox
  ADD CONSTRAINT event_outbox_status_check
  CHECK (status IN ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED', 'DEAD_LETTER'));

ALTER TABLE event_outbox ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS event_outbox_processing_lease_idx
  ON event_outbox (processing_started_at)
  WHERE status = 'PROCESSING';

CREATE INDEX IF NOT EXISTS event_outbox_dead_letter_idx
  ON event_outbox (status, available_at)
  WHERE status = 'DEAD_LETTER';

INSERT INTO app_metadata (key, value)
VALUES ('operations_version', 'phase-5')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
