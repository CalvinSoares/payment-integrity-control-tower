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

    def requeue_dead_letter(self, outbox_id: str, tenant_id: str, available_at: str | None = None) -> dict[str, str]:
        return {"status": "REQUEUED", "outboxId": outbox_id, "tenantId": tenant_id, "availableAt": available_at or "now"}


class FakeQueries:
    def get_payment_timeline(self, payment_id: str, tenant_id: str) -> dict[str, object]:
        return {"payment": {"id": payment_id, "tenantId": tenant_id}, "events": [], "ledger": [], "audit": [], "settlementItems": [], "exceptions": []}

    def get_payment_ledger(self, payment_id: str, tenant_id: str) -> list[dict[str, object]]:
        return [{"journalId": "journal_1", "tenantId": tenant_id, "paymentId": payment_id}]

    def list_exceptions(self, tenant_id: str, status: str | None, category: str | None, limit: int) -> list[dict[str, object]]:
        return [{"tenantId": tenant_id, "status": status, "category": category, "limit": limit}]


class FakeSettlement:
    def receive_csv(self, **input_data: str) -> dict[str, object]:
        return {"status": "RECEIVED", "tenantId": input_data["tenant_id"], "rowCount": 1}

    def reconcile(self, batch_id: str, tenant_id: str, rule_version: str, idempotency_key: str, requested_at: str) -> dict[str, object]:
        return {"run": {"batchId": batch_id, "tenantId": tenant_id, "ruleVersion": rule_version, "idempotencyKey": idempotency_key}}

    def resolve_exception(
        self, exception_id: str, tenant_id: str, actor_id: str, reason: str, evidence: list[str], resolved_at: str
    ) -> dict[str, object]:
        return {"exceptionId": exception_id, "tenantId": tenant_id, "status": "RESOLVED", "actorId": actor_id, "evidence": evidence}

    def reprocess_exception(self, exception_id: str, tenant_id: str, actor_id: str, requested_at: str) -> dict[str, object]:
        return {"exceptionId": exception_id, "tenantId": tenant_id, "resolved": True, "actorId": actor_id}


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

    def test_replays_dead_letter_through_event_store_port(self) -> None:
        client = TestClient(create_app(FakeEventStore(), settings=settings()))

        response = client.post(
            "/v1/events/dead-letter/outbox_1/replay",
            headers={"Authorization": "Bearer test-token"},
            json={"availableAt": "2026-09-18T10:00:00Z"},
        )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json()["status"], "REQUEUED")
        self.assertEqual(response.json()["outboxId"], "outbox_1")

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

    def test_exposes_tenant_scoped_read_routes_through_query_port(self) -> None:
        client = TestClient(create_app(FakeEventStore(), settings=settings(), queries=FakeQueries()))
        headers = {"Authorization": "Bearer test-token"}

        timeline = client.get("/v1/payments/pay_api/timeline", headers=headers)
        ledger = client.get("/v1/payments/pay_api/ledger", headers=headers)
        exceptions = client.get("/v1/exceptions?status=OPEN&category=AMOUNT_MISMATCH&limit=7", headers=headers)

        self.assertEqual(timeline.status_code, 200)
        self.assertEqual(timeline.json()["payment"]["tenantId"], "tenant_api")
        self.assertEqual(ledger.json()["journals"][0]["paymentId"], "pay_api")
        self.assertEqual(exceptions.json()["exceptions"][0]["limit"], 7)

    def test_exposes_settlement_routes_through_service_port(self) -> None:
        client = TestClient(create_app(FakeEventStore(), settings=settings(), settlement=FakeSettlement()))
        headers = {"Authorization": "Bearer test-token"}
        csv_content = "settlement_id,external_payment_id,settled_at,gross_amount_minor,fee_amount_minor,net_amount_minor,currency\nset_1,ext_1,2026-09-18T10:00:00Z,1000,50,950,BRL\n"

        imported = client.post(
            "/v1/settlements/imports",
            headers=headers,
            json={
                "provider": "simulator",
                "providerAccountId": "account_1",
                "fileName": "settlement.csv",
                "periodStart": "2026-09-18T00:00:00Z",
                "periodEnd": "2026-09-18T23:59:59Z",
                "receivedAt": "2026-09-18T10:01:00Z",
                "content": csv_content,
            },
        )
        reconciliation = client.post(
            "/v1/reconciliation-runs",
            headers=headers,
            json={"batchId": "batch_1", "ruleVersion": "v1", "idempotencyKey": "run_1", "requestedAt": "2026-09-18T10:02:00Z"},
        )
        resolved = client.post(
            "/v1/exceptions/exception_1/resolve",
            headers=headers,
            json={"reason": "corrigido", "evidence": ["audit_1"], "resolvedAt": "2026-09-18T10:03:00Z"},
        )
        reprocessed = client.post(
            "/v1/exceptions/exception_1/reprocess",
            headers=headers,
            json={"requestedAt": "2026-09-18T10:04:00Z"},
        )

        self.assertEqual(imported.status_code, 202)
        self.assertEqual(reconciliation.status_code, 201)
        self.assertEqual(resolved.status_code, 200)
        self.assertEqual(reprocessed.status_code, 200)


if __name__ == "__main__":
    unittest.main()
