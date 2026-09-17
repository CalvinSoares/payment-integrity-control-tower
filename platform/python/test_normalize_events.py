import unittest

from normalize_events import normalize, payload_hash, validate_event


class NormalizeEventsTest(unittest.TestCase):
    def event(self):
        data = {"amountMinor": 10000, "currency": "BRL", "externalPaymentId": "external_py", "paymentId": "pay_py"}
        return {
            "eventId": "evt:python:001", "eventType": "payment.captured", "schemaVersion": 1,
            "tenantId": "tenant_local", "provider": "simulator", "providerAccountId": "account_py",
            "externalPaymentId": "external_py", "externalEventId": "external_evt_py",
            "occurredAt": "2026-09-17T20:00:00Z", "receivedAt": "2026-09-17T20:00:01Z",
            "traceId": "trace:python", "payloadHash": payload_hash(data), "data": data,
        }

    def test_accepts_hash_valid_event(self):
        event = self.event()
        self.assertEqual(validate_event(event), [])
        self.assertEqual(normalize(event)["normalizationVersion"], "python-local-v1")

    def test_rejects_tampered_payload(self):
        event = self.event()
        event["data"]["amountMinor"] = 999
        self.assertIn("payloadHash não corresponde a data", validate_event(event))


if __name__ == "__main__":
    unittest.main()
