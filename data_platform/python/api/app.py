from __future__ import annotations

import os
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.responses import JSONResponse, PlainTextResponse, Response

from ..config import Environment, load_environment
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
    scopes: set[str] | None = None,
    max_body_bytes: int | None = None,
) -> FastAPI:
    environment: Environment = load_environment()
    token = api_token or environment.api_token
    configured_tenant = tenant_id or environment.api_tenant_id
    configured_scopes = scopes or set(environment.api_scopes)
    body_limit = max_body_bytes or environment.max_body_bytes
    database_url = environment.database_url
    event_store = store or PostgresEventStore(
        database_url,
        environment.api_actor_id,
    )
    app = FastAPI(title="Payment Integrity Control Tower", version="0.1.0")
    bearer = HTTPBearer(auto_error=False)
    metrics = MetricsRegistry()
    control_tower_queries = queries or (PostgresControlTowerQueries(database_url) if isinstance(event_store, PostgresEventStore) else None)
    settlement_service = settlement or (PostgresSettlementService(database_url) if isinstance(event_store, PostgresEventStore) else None)

    def require_token(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> str:
        if credentials is None or credentials.scheme.lower() != "bearer" or credentials.credentials != token:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Credenciais ausentes ou inválidas.")
        return configured_tenant

    def require_scope(scope: str):
        def dependency(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> str:
            if credentials is None or credentials.scheme.lower() != "bearer" or credentials.credentials != token:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Credenciais ausentes ou inválidas.")
            if scope not in configured_scopes and "*" not in configured_scopes:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="forbidden")
            return configured_tenant

        return dependency

    @app.exception_handler(HTTPException)
    async def http_error(_request: Request, error: HTTPException) -> Response:
        if error.status_code == status.HTTP_401_UNAUTHORIZED:
            return JSONResponse(
                status_code=error.status_code,
                content={"error": "Credenciais ausentes ou inválidas.", "code": "unauthorized"},
                headers={"WWW-Authenticate": "Bearer"},
            )
        return JSONResponse(status_code=error.status_code, content={"detail": error.detail})

    @app.middleware("http")
    async def count_requests(request: Any, call_next: Any) -> Any:
        metrics.increment("http_requests_total")
        content_length = request.headers.get("content-length")
        if content_length is not None and content_length.isdigit() and int(content_length) > body_limit:
            response = JSONResponse(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, content={"error": "Payload muito grande.", "code": "payload_too_large"})
            metrics.increment("http_responses_413_total")
            return response
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
    @app.post("/v1/payments/events", response_model=IngestionReceipt, status_code=status.HTTP_202_ACCEPTED)
    def receive(event: PaymentEvent, authenticated_tenant: str = Depends(require_scope("control_tower:write"))) -> IngestionReceipt:
        if event.tenantId != authenticated_tenant:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="tenant_forbidden")
        try:
            return event_store.receive(event)
        except EventConflict as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    @app.post("/v1/events/dead-letter/{outbox_id}/replay", status_code=status.HTTP_202_ACCEPTED)
    def replay_dead_letter(outbox_id: str, body: dict[str, Any] | None = None, authenticated_tenant: str = Depends(require_scope("control_tower:write"))) -> dict[str, str]:
        try:
            return event_store.requeue_dead_letter(outbox_id, authenticated_tenant, (body or {}).get("availableAt"))
        except EventNotFound as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
        except EventTenantConflict as error:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
        except EventReplayConflict as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    @app.get("/v1/payments/{payment_id}/timeline")
    def payment_timeline(payment_id: str, _: str = Depends(require_scope("control_tower:read"))) -> dict[str, Any]:
        if control_tower_queries is None:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="queries_unavailable")
        result = control_tower_queries.get_payment_timeline(payment_id, configured_tenant)
        if result is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="payment_not_found")
        return result

    @app.get("/v1/payments/{payment_id}/ledger")
    def payment_ledger(payment_id: str, _: str = Depends(require_scope("control_tower:read"))) -> dict[str, Any]:
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
        _: str = Depends(require_scope("control_tower:read")),
    ) -> dict[str, Any]:
        if control_tower_queries is None:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="queries_unavailable")
        return {"exceptions": control_tower_queries.list_exceptions(configured_tenant, status_filter, category, limit)}

    @app.post("/v1/settlements/imports", status_code=status.HTTP_202_ACCEPTED)
    def settlement_import(body: dict[str, Any], authenticated_tenant: str = Depends(require_scope("control_tower:write"))) -> dict[str, Any]:
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
    def reconciliation_run(body: dict[str, Any], authenticated_tenant: str = Depends(require_scope("control_tower:write"))) -> dict[str, Any]:
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
    def resolve_exception(exception_id: str, body: dict[str, Any], authenticated_tenant: str = Depends(require_scope("control_tower:write"))) -> dict[str, Any]:
        if settlement_service is None:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="settlement_unavailable")
        evidence = body.get("evidence")
        if not isinstance(evidence, list) or any(not isinstance(item, str) for item in evidence):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="evidence deve ser uma lista de textos.")
        try:
            return settlement_service.resolve_exception(
                exception_id=exception_id,
                tenant_id=authenticated_tenant,
                actor_id=environment.api_actor_id,
                reason=str(body.get("reason", "")),
                evidence=evidence,
                resolved_at=str(body.get("resolvedAt", "")),
            )
        except SettlementNotFound as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
        except SettlementError as error:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error

    @app.post("/v1/exceptions/{exception_id}/reprocess")
    def reprocess_exception(exception_id: str, body: dict[str, Any], authenticated_tenant: str = Depends(require_scope("control_tower:write"))) -> dict[str, Any]:
        if settlement_service is None:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="settlement_unavailable")
        try:
            return settlement_service.reprocess_exception(
                exception_id=exception_id,
                tenant_id=authenticated_tenant,
                actor_id=environment.api_actor_id,
                requested_at=str(body.get("requestedAt", "")),
            )
        except SettlementNotFound as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
        except SettlementError as error:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error

    return app


app = create_app()
