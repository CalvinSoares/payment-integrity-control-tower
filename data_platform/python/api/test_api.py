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


class FakeQueries:
    def get_payment_timeline(self, payment_id: str, tenant_id: str):
        return {"payment": {"id": payment_id, "tenantId": tenant_id}, "events": [], "ledger": [], "audit": [], "settlementItems": [], "exceptions": []}

    def get_payment_ledger(self, payment_id: str, tenant_id: str):
        return []

    def list_exceptions(self, tenant_id: str, status: str | None, category: str | None, limit: int):
        return [{"tenantId": tenant_id, "status": status, "category": category, "limit": limit}]


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
        client = TestClient(create_app(FakeStore(), "test-token", tenant_id="tenant_api"))
        response = client.post("/v1/events", json=valid_event())
        self.assertEqual(response.status_code, 401)


    def test_accepts_valid_event(self):
        store = FakeStore()
        client = TestClient(create_app(store, "test-token", tenant_id="tenant_api"))
        response = client.post("/v1/events", headers={"Authorization": "Bearer test-token"}, json=valid_event())
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json()["status"], "RECEIVED")
        self.assertEqual(len(store.received), 1)


    def test_rejects_tampered_payload(self):
        event = valid_event()
        event["data"]["amountMinor"] = 999
        client = TestClient(create_app(FakeStore(), "test-token", tenant_id="tenant_api"))
        response = client.post("/v1/events", headers={"Authorization": "Bearer test-token"}, json=event)
        self.assertEqual(response.status_code, 422)

    def test_rejects_event_from_another_tenant(self):
        event = valid_event()
        event["tenantId"] = "tenant_other"
        client = TestClient(create_app(FakeStore(), "test-token", tenant_id="tenant_api"))
        response = client.post("/v1/events", headers={"Authorization": "Bearer test-token"}, json=event)
        self.assertEqual(response.status_code, 403)

    def test_exposes_control_tower_queries_and_metrics(self):
        client = TestClient(create_app(FakeStore(), "test-token", tenant_id="tenant_api", queries=FakeQueries()))
        headers = {"Authorization": "Bearer test-token"}
        timeline = client.get("/v1/payments/pay_api/timeline", headers=headers)
        self.assertEqual(timeline.status_code, 200)
        self.assertEqual(timeline.json()["payment"]["tenantId"], "tenant_api")
        exceptions = client.get("/v1/exceptions?status=OPEN&category=AMOUNT_MISMATCH&limit=7", headers=headers)
        self.assertEqual(exceptions.status_code, 200)
        self.assertEqual(exceptions.json()["exceptions"][0]["limit"], 7)
        metrics = client.get("/v1/metrics")
        self.assertEqual(metrics.status_code, 200)
        self.assertIn("http_requests_total", metrics.text)

    def test_enforces_read_and_write_scopes(self):
        read_client = TestClient(create_app(FakeStore(), "test-token", tenant_id="tenant_api", scopes={"control_tower:read"}))
        headers = {"Authorization": "Bearer test-token"}
        self.assertEqual(read_client.get("/v1/health/live").status_code, 200)
        self.assertEqual(read_client.post("/v1/events", headers=headers, json=valid_event()).status_code, 403)

    def test_returns_contract_error_for_invalid_credentials(self):
        response = TestClient(create_app(FakeStore(), "test-token", tenant_id="tenant_api")).get(
            "/v1/payments/pay_api/timeline", headers={"Authorization": "Bearer wrong-token"}
        )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["code"], "unauthorized")
