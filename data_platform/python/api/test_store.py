from __future__ import annotations

import os
import unittest
from uuid import uuid4

import psycopg

from .models import PaymentEvent
from .store import PostgresEventStore
from .test_api import valid_event


@unittest.skipUnless(os.getenv("RUN_PYTHON_DB_TESTS") == "true", "RUN_PYTHON_DB_TESTS=true required")
class PostgresStoreTest(unittest.TestCase):
    def test_persists_and_replays_without_duplicate_audit(self):
        event_id = f"evt:python:integration:{uuid4()}"
        event_payload = valid_event()
        event_payload["eventId"] = event_id
        event_payload["externalEventId"] = f"external_evt_python_{uuid4()}"
        event = PaymentEvent.model_validate(event_payload)
        store = PostgresEventStore(os.getenv("DATABASE_URL", "postgresql://integrity:integrity_dev@localhost:5438/payment_integrity"))

        first = store.receive(event)
        replay = store.receive(event)

        self.assertEqual(first.status, "RECEIVED")
        self.assertEqual(replay.status, "REPLAYED")
        with psycopg.connect(store.database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT COUNT(*) FROM event_inbox WHERE event_id = %s", (event_id,))
                self.assertEqual(cursor.fetchone()[0], 1)
                cursor.execute("SELECT COUNT(*) FROM event_outbox WHERE event_id = %s", (event_id,))
                self.assertEqual(cursor.fetchone()[0], 1)
                cursor.execute("SELECT COUNT(*) FROM audit_events WHERE source_event_id = %s", (event_id,))
                self.assertEqual(cursor.fetchone()[0], 1)
