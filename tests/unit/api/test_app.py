from __future__ import annotations

import unittest

from fastapi.testclient import TestClient

from payment_integrity.api.app import create_app
from payment_integrity.api.settings import ApiSettings
from payment_integrity.domain.payment_events import PaymentEvent, payload_hash
from payment_integrity.domain.receipts import IngestionReceipt


class FakeEventStore:
    def __init__(self) -> None:
        self.received: list[PaymentEvent] = []

    def receive(self, event: PaymentEvent) -> IngestionReceipt:
        self.received.append(event)
        return IngestionReceipt("RECEIVED", event.event_id, f"inbox:{event.event_id}", f"outbox:{event.event_id}")

    def ready(self) -> bool:
        return True


def settings() -> ApiSettings:
    return ApiSettings(
        database_url="postgresql://unused",
        api_token="test-token",
        tenant_id="tenant_api",
        actor_id="test-actor",
        scopes=frozenset({"control_tower:read", "control_tower:write"}),
        max_body_bytes=1024 * 1024,
    )


def valid_event() -> dict[str, object]:
    data: dict[str, object] = {
        "amountMinor": 1000,
        "currency": "BRL",
        "externalPaymentId": "external_api",
        "paymentId": "pay_api",
    }
    return {
        "eventId": "evt:python:new-api",
        "eventType": "payment.captured",
        "schemaVersion": 1,
        "tenantId": "tenant_api",
        "provider": "simulator",
        "providerAccountId": "account_api",
        "externalPaymentId": "external_api",
        "externalEventId": "external_evt_api",
        "occurredAt": "2026-09-18T10:00:00Z",
        "receivedAt": "2026-09-18T10:00:01Z",
        "traceId": "trace:python:new-api",
        "payloadHash": payload_hash(data),
        "data": data,
    }


class NewApiTests(unittest.TestCase):
    def test_requires_bearer_token(self) -> None:
        response = TestClient(create_app(FakeEventStore(), settings=settings())).post("/v1/events", json=valid_event())

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["code"], "unauthorized")

    def test_valid_event_uses_application_port(self) -> None:
        store = FakeEventStore()
        client = TestClient(create_app(store, settings=settings()))

        response = client.post("/v1/events", headers={"Authorization": "Bearer test-token"}, json=valid_event())

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json()["status"], "RECEIVED")
        self.assertEqual([event.event_id for event in store.received], ["evt:python:new-api"])

    def test_rejects_another_tenant_before_persistence(self) -> None:
        store = FakeEventStore()
        event = valid_event()
        event["tenantId"] = "tenant_other"

        response = TestClient(create_app(store, settings=settings())).post(
            "/v1/events", headers={"Authorization": "Bearer test-token"}, json=event
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(store.received, [])

    def test_exposes_liveness_and_metrics(self) -> None:
        client = TestClient(create_app(FakeEventStore(), settings=settings()))

        self.assertEqual(client.get("/v1/health/live").status_code, 200)
        self.assertIn("http_requests_total", client.get("/v1/metrics").text)


if __name__ == "__main__":
    unittest.main()
