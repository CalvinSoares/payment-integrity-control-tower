from __future__ import annotations

import unittest

from payment_integrity.domain.payment_events import PaymentEvent, payload_hash
from payment_integrity.infrastructure.postgres_event_store import PostgresEventStore


def valid_event() -> PaymentEvent:
    data: dict[str, object] = {"paymentId": "pay_123", "externalPaymentId": "ext_123"}
    return PaymentEvent.from_mapping(
        {
            "eventId": "evt_123",
            "eventType": "payment.captured",
            "schemaVersion": 1,
            "tenantId": "tenant_123",
            "provider": "generic_gateway",
            "providerAccountId": "account_123",
            "externalPaymentId": "ext_123",
            "externalEventId": "provider_evt_123",
            "occurredAt": "2026-09-18T10:00:00Z",
            "receivedAt": "2026-09-18T10:00:01Z",
            "traceId": "trace_123",
            "payloadHash": payload_hash(data),
            "data": data,
        }
    )


class PostgresEventStoreTests(unittest.TestCase):
    def test_deduplication_key_is_stable_and_provider_agnostic(self) -> None:
        event = valid_event()

        self.assertEqual(
            PostgresEventStore._deduplication_key(event),
            '["generic_gateway","account_123","provider_evt_123"]',
        )


if __name__ == "__main__":
    unittest.main()
