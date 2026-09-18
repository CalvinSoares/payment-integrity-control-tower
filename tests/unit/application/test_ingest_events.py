from __future__ import annotations

import unittest

from payment_integrity.application.ingest_events import IngestPaymentEvent
from payment_integrity.domain.payment_events import PaymentEvent, PaymentEventValidationError, payload_hash
from payment_integrity.domain.receipts import IngestionReceipt


class FakeEventStore:
    def __init__(self) -> None:
        self.received: list[PaymentEvent] = []

    def receive(self, event: PaymentEvent) -> IngestionReceipt:
        self.received.append(event)
        return IngestionReceipt("RECEIVED", event.event_id, f"inbox:{event.event_id}", f"outbox:{event.event_id}")


def valid_event() -> dict[str, object]:
    data: dict[str, object] = {"paymentId": "pay_123", "externalPaymentId": "ext_123"}
    return {
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


class IngestPaymentEventTests(unittest.TestCase):
    def test_validates_then_delegates_to_port(self) -> None:
        store = FakeEventStore()
        receipt = IngestPaymentEvent(store).execute(valid_event())

        self.assertEqual(receipt.status, "RECEIVED")
        self.assertEqual([event.event_id for event in store.received], ["evt_123"])

    def test_does_not_call_port_when_event_is_invalid(self) -> None:
        store = FakeEventStore()
        raw = valid_event()
        raw["payloadHash"] = "sha256:tampered"

        with self.assertRaises(PaymentEventValidationError):
            IngestPaymentEvent(store).execute(raw)

        self.assertEqual(store.received, [])


if __name__ == "__main__":
    unittest.main()
