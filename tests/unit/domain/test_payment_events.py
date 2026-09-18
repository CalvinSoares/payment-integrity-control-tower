from __future__ import annotations

import unittest

from payment_integrity.domain.payment_events import (
    PaymentEvent,
    PaymentEventValidationError,
    payload_hash,
)


def valid_event() -> dict[str, object]:
    data: dict[str, object] = {
        "paymentId": "pay_123",
        "externalPaymentId": "ext_123",
        "amountMinor": 1990,
        "currency": "BRL",
    }
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


class PaymentEventTests(unittest.TestCase):
    def test_builds_immutable_provider_agnostic_event(self) -> None:
        event = PaymentEvent.from_mapping(valid_event())

        self.assertEqual(event.event_id, "evt_123")
        self.assertEqual(event.data["amountMinor"], 1990)
        self.assertEqual(event.to_mapping()["externalPaymentId"], "ext_123")
        with self.assertRaises((AttributeError, TypeError)):
            event.event_id = "changed"  # type: ignore[misc]

    def test_rejects_tampered_payload_hash(self) -> None:
        raw = valid_event()
        raw["data"] = {**raw["data"], "amountMinor": 2990}  # type: ignore[arg-type]

        with self.assertRaisesRegex(PaymentEventValidationError, "payloadHash"):
            PaymentEvent.from_mapping(raw)

    def test_rejects_mismatched_external_payment_id(self) -> None:
        raw = valid_event()
        raw["data"] = {**raw["data"], "externalPaymentId": "other_ext"}  # type: ignore[arg-type]
        raw["payloadHash"] = payload_hash(raw["data"])  # type: ignore[arg-type]

        with self.assertRaisesRegex(PaymentEventValidationError, "externalPaymentId"):
            PaymentEvent.from_mapping(raw)

    def test_rejects_unsupported_event_type(self) -> None:
        raw = valid_event()
        raw["eventType"] = "unknown.event"

        with self.assertRaisesRegex(PaymentEventValidationError, "não suportado"):
            PaymentEvent.from_mapping(raw)


if __name__ == "__main__":
    unittest.main()
