from __future__ import annotations

import os
import unittest
from datetime import datetime, timezone
from uuid import uuid4

import psycopg

from .api.models import PaymentEvent
from .api.store import PostgresEventStore
from .api.test_api import valid_event
from .payment_processor import PaymentEventProcessor
from .api.queries import PostgresControlTowerQueries
from .worker import PostgresEventWorker


@unittest.skipUnless(os.getenv("RUN_PYTHON_DB_TESTS") == "true", "RUN_PYTHON_DB_TESTS=true required")
class PostgresPaymentProcessorTest(unittest.TestCase):
    database_url = os.getenv("DATABASE_URL", "postgresql://integrity:integrity_dev@localhost:5438/payment_integrity")

    def event(self, event_type: str, payment_id: str, external_payment_id: str, occurred_at: str) -> PaymentEvent:
        data = {
            "amountMinor": 1000,
            "currency": "BRL",
            "externalPaymentId": external_payment_id,
            "paymentId": payment_id,
        }
        payload = valid_event()
        payload.update(
            {
                "eventId": f"evt:processor:{uuid4()}",
                "eventType": event_type,
                "externalPaymentId": external_payment_id,
                "externalEventId": f"external_processor_{uuid4()}",
                "occurredAt": occurred_at,
                "receivedAt": occurred_at,
                "data": data,
            }
        )
        from .normalize_events import payload_hash

        payload["payloadHash"] = payload_hash(data)
        return PaymentEvent.model_validate(payload)

    def make_available_first(self, event: PaymentEvent) -> None:
        with psycopg.connect(self.database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE event_outbox SET available_at = '2020-01-01T00:00:00Z'::timestamptz WHERE event_id = %s",
                    (event.eventId,),
                )

    def test_authorization_bootstraps_payment_and_capture_writes_balanced_journal(self):
        payment_id = f"pay:processor:{uuid4()}"
        external_payment_id = f"external_processor_payment_{uuid4()}"
        store = PostgresEventStore(self.database_url)
        processor = PaymentEventProcessor()
        worker = PostgresEventWorker(self.database_url, processor)

        authorized = self.event("payment.authorized", payment_id, external_payment_id, "2026-09-18T20:00:00Z")
        store.receive(authorized)
        self.make_available_first(authorized)
        authorized_result = worker.process_next(datetime(2020, 1, 1, 0, 0, 2, tzinfo=timezone.utc))
        self.assertEqual(authorized_result.status, "APPLIED")

        captured = self.event("payment.captured", payment_id, external_payment_id, "2026-09-18T20:01:00Z")
        store.receive(captured)
        self.make_available_first(captured)
        captured_result = worker.process_next(datetime(2020, 1, 1, 0, 0, 3, tzinfo=timezone.utc))
        self.assertEqual(captured_result.status, "APPLIED")

        with psycopg.connect(self.database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT state FROM payments WHERE id = %s", (payment_id,))
                self.assertEqual(cursor.fetchone()[0], "CAPTURED")
                cursor.execute(
                    "SELECT COUNT(*) FROM ledger_entries WHERE reference_type = 'Payment' AND reference_id = %s",
                    (payment_id,),
                )
                self.assertEqual(cursor.fetchone()[0], 2)
                cursor.execute("SELECT status FROM event_outbox WHERE event_id = %s", (captured.eventId,))
                self.assertEqual(cursor.fetchone()[0], "PUBLISHED")

        queries = PostgresControlTowerQueries(self.database_url)
        timeline = queries.get_payment_timeline(payment_id, authorized.tenantId)
        self.assertIsNotNone(timeline)
        self.assertEqual(timeline["payment"]["state"], "CAPTURED")
        self.assertEqual(len(timeline["events"]), 2)
        self.assertEqual(len(timeline["ledger"]), 1)
        self.assertIsNone(queries.get_payment_timeline(payment_id, "tenant_other"))
