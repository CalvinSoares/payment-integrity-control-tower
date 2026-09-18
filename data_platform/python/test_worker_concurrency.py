from __future__ import annotations

import os
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from uuid import uuid4

import psycopg

from .api.store import PostgresEventStore
from .api.test_api import valid_event
from .api.models import PaymentEvent
from .worker import PostgresEventWorker


@unittest.skipUnless(os.getenv("RUN_PYTHON_DB_TESTS") == "true", "RUN_PYTHON_DB_TESTS=true required")
class PostgresWorkerConcurrencyTest(unittest.TestCase):
    database_url = os.getenv("DATABASE_URL", "postgresql://integrity:integrity_dev@localhost:5438/payment_integrity")
    process_time = datetime(2020, 1, 1, 0, 0, 2, tzinfo=timezone.utc)

    def create_event(self) -> PaymentEvent:
        payload = valid_event()
        payload["eventId"] = f"evt:python:concurrency:{uuid4()}"
        payload["externalEventId"] = f"external_concurrency_{uuid4()}"
        return PaymentEvent.model_validate(payload)

    def make_available_first(self, event: PaymentEvent) -> None:
        with psycopg.connect(self.database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE event_outbox SET available_at = '2020-01-01T00:00:00Z'::timestamptz WHERE event_id = %s",
                    (event.eventId,),
                )

    def test_skip_locked_allows_only_one_worker_to_claim_message(self):
        event = self.create_event()
        PostgresEventStore(self.database_url).receive(event)
        self.make_available_first(event)
        handler_started = threading.Event()
        release_handler = threading.Event()

        def slow_handler(_event: PaymentEvent, _connection: object) -> None:
            handler_started.set()
            if not release_handler.wait(timeout=5):
                raise RuntimeError("handler não foi liberado pelo teste")

        worker = PostgresEventWorker(self.database_url, slow_handler)
        with ThreadPoolExecutor(max_workers=1) as executor:
            first_future = executor.submit(worker.process_next, self.process_time)
            self.assertTrue(handler_started.wait(timeout=5))
            second = PostgresEventWorker(self.database_url, lambda _event, _connection: None).process_next(self.process_time)
            release_handler.set()
            first = first_future.result(timeout=5)

        self.assertEqual(first.status, "APPLIED")
        self.assertEqual(second.status, "IDLE")
        with psycopg.connect(self.database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT status, attempts FROM event_outbox WHERE event_id = %s", (event.eventId,))
                self.assertEqual(cursor.fetchone(), ("PUBLISHED", 1))

    def test_recovers_stale_processing_lease(self):
        event = self.create_event()
        PostgresEventStore(self.database_url).receive(event)
        with psycopg.connect(self.database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE event_outbox
                       SET status = 'PROCESSING', attempts = 1,
                           processing_started_at = '2019-12-31T23:00:00Z'::timestamptz
                     WHERE event_id = %s
                    """,
                    (event.eventId,),
                )
                cursor.execute("UPDATE event_inbox SET status = 'PROCESSING', attempts = 1 WHERE event_id = %s", (event.eventId,))

        processed: list[str] = []
        result = PostgresEventWorker(self.database_url, lambda received, _connection: processed.append(received.eventId), lease_ms=60_000).process_next(
            self.process_time
        )

        self.assertEqual(result.status, "APPLIED")
        self.assertEqual(processed, [event.eventId])
        with psycopg.connect(self.database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT status, attempts, processing_started_at FROM event_outbox WHERE event_id = %s", (event.eventId,))
                status, attempts, processing_started_at = cursor.fetchone()
                self.assertEqual(status, "PUBLISHED")
                self.assertEqual(attempts, 2)
                self.assertIsNone(processing_started_at)
