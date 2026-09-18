from __future__ import annotations

import os
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.responses import PlainTextResponse

from .metrics import MetricsRegistry
from .models import IngestionReceipt, PaymentEvent
from .queries import PostgresControlTowerQueries
from ..settlement import PostgresSettlementService, SettlementError, SettlementNotFound
from .store import (
    EventConflict,
    EventNotFound,
    EventReplayConflict,
    EventStore,
    EventTenantConflict,
    PostgresEventStore,
)


def create_app(
    store: EventStore | None = None,
    api_token: str | None = None,
    tenant_id: str | None = None,
    queries: PostgresControlTowerQueries | None = None,
    settlement: PostgresSettlementService | None = None,
) -> FastAPI:
    token = api_token or os.getenv("CONTROL_TOWER_API_TOKEN", "local-dev-token")
    configured_tenant = tenant_id or os.getenv("CONTROL_TOWER_API_TENANT_ID", "tenant_local")
    database_url = os.getenv("DATABASE_URL", "postgresql://integrity:integrity_dev@localhost:5438/payment_integrity")
    event_store = store or PostgresEventStore(
        database_url,
        os.getenv("CONTROL_TOWER_API_ACTOR_ID", "system:ingestion"),
    )
    app = FastAPI(title="Payment Integrity Control Tower", version="0.1.0")
    bearer = HTTPBearer(auto_error=False)
    metrics = MetricsRegistry()
    control_tower_queries = queries or (PostgresControlTowerQueries(database_url) if isinstance(event_store, PostgresEventStore) else None)
    settlement_service = settlement or (PostgresSettlementService(database_url) if isinstance(event_store, PostgresEventStore) else None)

    def require_token(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> str:
        if credentials is None or credentials.scheme.lower() != "bearer" or credentials.credentials != token:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unauthorized")
        return configured_tenant

    @app.middleware("http")
    async def count_requests(request: Any, call_next: Any) -> Any:
        metrics.increment("http_requests_total")
        response = await call_next(request)
        metrics.increment(f"http_responses_{response.status_code}_total")
        return response

    @app.get("/v1/health/live")
    def live() -> dict[str, str]:
        return {"status": "ok", "service": "payment-integrity-python"}

    @app.get("/v1/health/ready")
    def ready() -> dict[str, str]:
        if not event_store.ready():
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="database_unavailable")
        return {"status": "ready", "service": "payment-integrity-python"}

    @app.get("/metrics", response_class=PlainTextResponse)
    @app.get("/v1/metrics", response_class=PlainTextResponse)
    def metrics_endpoint() -> str:
        return metrics.to_prometheus() + "\n"

    @app.post("/v1/events", response_model=IngestionReceipt, status_code=status.HTTP_202_ACCEPTED)
    def receive(event: PaymentEvent, authenticated_tenant: str = Depends(require_token)) -> IngestionReceipt:
        if event.tenantId != authenticated_tenant:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="tenant_forbidden")
        try:
            return event_store.receive(event)
        except EventConflict as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    @app.post("/v1/events/dead-letter/{outbox_id}/replay", status_code=status.HTTP_202_ACCEPTED)
    def replay_dead_letter(outbox_id: str, body: dict[str, Any] | None = None, authenticated_tenant: str = Depends(require_token)) -> dict[str, str]:
        try:
            return event_store.requeue_dead_letter(outbox_id, authenticated_tenant, (body or {}).get("availableAt"))
        except EventNotFound as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
        except EventTenantConflict as error:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
        except EventReplayConflict as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    @app.get("/v1/payments/{payment_id}/timeline")
    def payment_timeline(payment_id: str, _: str = Depends(require_token)) -> dict[str, Any]:
        if control_tower_queries is None:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="queries_unavailable")
        result = control_tower_queries.get_payment_timeline(payment_id, configured_tenant)
        if result is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="payment_not_found")
        return result

    @app.get("/v1/payments/{payment_id}/ledger")
    def payment_ledger(payment_id: str, _: str = Depends(require_token)) -> dict[str, Any]:
        if control_tower_queries is None:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="queries_unavailable")
        result = control_tower_queries.get_payment_ledger(payment_id, configured_tenant)
        if result is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="payment_not_found")
        return {"paymentId": payment_id, "journals": result}

    @app.get("/v1/exceptions")
    def exceptions(
        status_filter: str | None = Query(default=None, alias="status"),
        category: str | None = None,
        limit: int = 50,
        _: str = Depends(require_token),
    ) -> dict[str, Any]:
        if control_tower_queries is None:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="queries_unavailable")
        return {"exceptions": control_tower_queries.list_exceptions(configured_tenant, status_filter, category, limit)}

    @app.post("/v1/settlements/imports", status_code=status.HTTP_202_ACCEPTED)
    def settlement_import(body: dict[str, Any], authenticated_tenant: str = Depends(require_token)) -> dict[str, Any]:
        if settlement_service is None:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="settlement_unavailable")
        try:
            return settlement_service.receive_csv(
                tenant_id=authenticated_tenant,
                provider=str(body.get("provider", "")),
                provider_account_id=str(body.get("providerAccountId", "")),
                file_name=str(body.get("fileName", "")),
                period_start=str(body.get("periodStart", "")),
                period_end=str(body.get("periodEnd", "")),
                received_at=str(body.get("receivedAt", "")),
                content=str(body.get("content", "")),
            )
        except SettlementError as error:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error

    @app.post("/v1/reconciliation-runs", status_code=status.HTTP_201_CREATED)
    def reconciliation_run(body: dict[str, Any], authenticated_tenant: str = Depends(require_token)) -> dict[str, Any]:
        if settlement_service is None:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="settlement_unavailable")
        try:
            return settlement_service.reconcile(
                batch_id=str(body.get("batchId", "")),
                tenant_id=authenticated_tenant,
                rule_version=str(body.get("ruleVersion", "")),
                idempotency_key=str(body.get("idempotencyKey", "")),
                requested_at=str(body.get("requestedAt", "")),
            )
        except SettlementNotFound as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
        except SettlementError as error:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error

    @app.post("/v1/exceptions/{exception_id}/resolve")
    def resolve_exception(exception_id: str, body: dict[str, Any], authenticated_tenant: str = Depends(require_token)) -> dict[str, Any]:
        if settlement_service is None:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="settlement_unavailable")
        evidence = body.get("evidence")
        if not isinstance(evidence, list) or any(not isinstance(item, str) for item in evidence):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="evidence deve ser uma lista de textos.")
        try:
            return settlement_service.resolve_exception(
                exception_id=exception_id,
                tenant_id=authenticated_tenant,
                actor_id=os.getenv("CONTROL_TOWER_API_ACTOR_ID", "system:ingestion"),
                reason=str(body.get("reason", "")),
                evidence=evidence,
                resolved_at=str(body.get("resolvedAt", "")),
            )
        except SettlementNotFound as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
        except SettlementError as error:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error

    return app


app = create_app()
