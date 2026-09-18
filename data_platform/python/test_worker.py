from __future__ import annotations

import os
import unittest
from datetime import datetime, timezone
from uuid import uuid4

import psycopg

from .api.models import PaymentEvent
from .api.test_api import valid_event
from .api.store import PostgresEventStore
from .api.store import EventReplayConflict
from .worker import PostgresEventWorker


@unittest.skipUnless(os.getenv("RUN_PYTHON_DB_TESTS") == "true", "RUN_PYTHON_DB_TESTS=true required")
class PostgresWorkerTest(unittest.TestCase):
    database_url = os.getenv("DATABASE_URL", "postgresql://integrity:integrity_dev@localhost:5438/payment_integrity")

    def create_event(self) -> PaymentEvent:
        payload = valid_event()
        payload["eventId"] = f"evt:python:worker:{uuid4()}"
        payload["externalEventId"] = f"external_evt_worker_{uuid4()}"
        return PaymentEvent.model_validate(payload)

    def make_available_first(self, event: PaymentEvent) -> None:
        with psycopg.connect(self.database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE event_outbox SET available_at = '2020-01-01T00:00:00Z'::timestamptz WHERE event_id = %s",
                    (event.eventId,),
                )

    def test_applies_event_and_updates_inbox_and_outbox(self):
        event = self.create_event()
        PostgresEventStore(self.database_url).receive(event)
        self.make_available_first(event)
        processed: list[str] = []
        result = PostgresEventWorker(self.database_url, lambda received, _connection: processed.append(received.eventId)).process_next(
            datetime(2020, 1, 1, 0, 0, 2, tzinfo=timezone.utc)
        )
        self.assertEqual(result.status, "APPLIED")
        self.assertEqual(processed, [event.eventId])
        with psycopg.connect(self.database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT status, attempts FROM event_inbox WHERE event_id = %s", (event.eventId,))
                self.assertEqual(cursor.fetchone(), ("APPLIED", 1))
                cursor.execute("SELECT status, attempts FROM event_outbox WHERE event_id = %s", (event.eventId,))
                self.assertEqual(cursor.fetchone(), ("PUBLISHED", 1))

    def test_retries_then_dead_letters_failed_event(self):
        event = self.create_event()
        PostgresEventStore(self.database_url).receive(event)
        self.make_available_first(event)

        def fail(_event: PaymentEvent, _connection: object) -> None:
            raise RuntimeError("falha simulada")

        worker = PostgresEventWorker(self.database_url, fail, max_attempts=2, base_delay_ms=1)
        first = worker.process_next(datetime(2020, 1, 1, 0, 0, 2, tzinfo=timezone.utc))
        second = worker.process_next(datetime(2020, 1, 1, 0, 0, 3, tzinfo=timezone.utc))
        self.assertEqual(first.status, "RETRY_SCHEDULED")
        self.assertEqual(second.status, "REJECTED")
        with psycopg.connect(self.database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT status, attempts FROM event_inbox WHERE event_id = %s", (event.eventId,))
                self.assertEqual(cursor.fetchone(), ("REJECTED", 2))
                cursor.execute("SELECT status, attempts FROM event_outbox WHERE event_id = %s", (event.eventId,))
                self.assertEqual(cursor.fetchone(), ("DEAD_LETTER", 2))

        receipt = PostgresEventStore(self.database_url).requeue_dead_letter(
            f"outbox:{event.eventId}", event.tenantId, "2020-01-01T00:00:00Z"
        )
        self.assertEqual(receipt["status"], "REQUEUED")
        with psycopg.connect(self.database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT status, attempts, last_error FROM event_outbox WHERE event_id = %s", (event.eventId,))
                self.assertEqual(cursor.fetchone(), ("PENDING", 0, None))
        with self.assertRaises(EventReplayConflict):
            PostgresEventStore(self.database_url).requeue_dead_letter(f"outbox:{event.eventId}", event.tenantId)
        self.assertEqual(
            PostgresEventWorker(self.database_url, lambda _event, _connection: None).process_next(
                datetime(2020, 1, 1, 0, 0, 1, tzinfo=timezone.utc)
            ).status,
            "APPLIED",
        )
