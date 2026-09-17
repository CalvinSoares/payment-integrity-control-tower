import unittest

from fastapi.testclient import TestClient

from ..normalize_events import payload_hash
from .app import create_app
from .models import IngestionReceipt, PaymentEvent


class FakeStore:
    def __init__(self):
        self.received = []

    def receive(self, event: PaymentEvent) -> IngestionReceipt:
        self.received.append(event)
        return IngestionReceipt(status="RECEIVED", eventId=event.eventId, inboxId=f"inbox:{event.eventId}", outboxId=f"outbox:{event.eventId}")

    def ready(self) -> bool:
        return True


def valid_event():
    data = {"amountMinor": 1000, "currency": "BRL", "externalPaymentId": "external_api", "paymentId": "pay_api"}
    return {
        "eventId": "evt:python:api", "eventType": "payment.captured", "schemaVersion": 1,
        "tenantId": "tenant_api", "provider": "simulator", "providerAccountId": "account_api",
        "externalPaymentId": "external_api", "externalEventId": "external_evt_api",
        "occurredAt": "2026-09-17T20:00:00Z", "receivedAt": "2026-09-17T20:00:01Z",
        "traceId": "trace:python:api", "payloadHash": payload_hash(data), "data": data,
    }


class PythonApiTest(unittest.TestCase):
    def test_requires_bearer_token(self):
        client = TestClient(create_app(FakeStore(), "test-token"))
        response = client.post("/v1/events", json=valid_event())
        self.assertEqual(response.status_code, 401)


    def test_accepts_valid_event(self):
        store = FakeStore()
        client = TestClient(create_app(store, "test-token"))
        response = client.post("/v1/events", headers={"Authorization": "Bearer test-token"}, json=valid_event())
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json()["status"], "RECEIVED")
        self.assertEqual(len(store.received), 1)


    def test_rejects_tampered_payload(self):
        event = valid_event()
        event["data"]["amountMinor"] = 999
        client = TestClient(create_app(FakeStore(), "test-token"))
        response = client.post("/v1/events", headers={"Authorization": "Bearer test-token"}, json=event)
        self.assertEqual(response.status_code, 422)
