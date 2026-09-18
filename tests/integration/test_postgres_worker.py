from __future__ import annotations

import os
import unittest
from datetime import datetime, timezone
from uuid import uuid4

import psycopg

from payment_integrity.domain.payment_events import PaymentEvent, payload_hash
from payment_integrity.infrastructure.postgres_event_store import PostgresEventStore
from payment_integrity.worker.payment_processor import PaymentEventProcessor
from payment_integrity.worker.worker import PostgresEventWorker


@unittest.skipUnless(os.getenv("RUN_PYTHON_DB_TESTS") == "true", "RUN_PYTHON_DB_TESTS=true required")
class PostgresWorkerIntegrationTests(unittest.TestCase):
    database_url = os.getenv("DATABASE_URL", "postgresql://integrity:integrity_dev@localhost:5438/payment_integrity")

    def test_authorization_updates_payment_and_outbox(self) -> None:
        suffix = str(uuid4())
        now = datetime.now(timezone.utc).isoformat()
        data: dict[str, object] = {"paymentId": f"pay:worker:{suffix}", "externalPaymentId": f"ext:worker:{suffix}", "amountMinor": 1200, "currency": "BRL"}
        event = PaymentEvent.from_mapping(
            {
                "eventId": f"evt:worker:{suffix}",
                "eventType": "payment.authorized",
                "schemaVersion": 1,
                "tenantId": "tenant_worker_test",
                "provider": "simulator",
                "providerAccountId": "account_worker_test",
                "externalPaymentId": data["externalPaymentId"],
                "externalEventId": f"provider:worker:{suffix}",
                "occurredAt": now,
                "receivedAt": now,
                "traceId": f"trace:worker:{suffix}",
                "payloadHash": payload_hash(data),
                "data": data,
            }
        )
        PostgresEventStore(self.database_url).receive(event)
        with psycopg.connect(self.database_url) as connection, connection.transaction(), connection.cursor() as cursor:
            cursor.execute("UPDATE event_outbox SET available_at = '2020-01-01T00:00:00Z'::timestamptz WHERE event_id = %s", (event.event_id,))

        result = PostgresEventWorker(self.database_url, handler=PaymentEventProcessor("test-worker"), projector=None).process_next(
            datetime(2020, 1, 1, 0, 0, 2, tzinfo=timezone.utc)
        )

        with psycopg.connect(self.database_url) as connection, connection.cursor() as cursor:
            cursor.execute("SELECT state FROM payments WHERE id = %s", (data["paymentId"],))
            payment_state = cursor.fetchone()
            cursor.execute("SELECT status FROM event_inbox WHERE event_id = %s", (event.event_id,))
            inbox_status = cursor.fetchone()
            cursor.execute("SELECT status FROM event_outbox WHERE event_id = %s", (event.event_id,))
            outbox_status = cursor.fetchone()

        self.assertEqual(result.status, "APPLIED")
        self.assertEqual(payment_state, ("AUTHORIZED",))
        self.assertEqual(inbox_status, ("APPLIED",))
        self.assertEqual(outbox_status, ("PUBLISHED",))


if __name__ == "__main__":
    unittest.main()
