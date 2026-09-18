"""FastAPI composition root for the new Python package."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from payment_integrity.application.ingest_events import IngestPaymentEvent
from payment_integrity.application.ports import EventStore
from payment_integrity.application.query_ports import ControlTowerQueries
from payment_integrity.application.settlement_ports import SettlementService
from payment_integrity.domain.payment_events import PaymentEventValidationError
from payment_integrity.domain.settlements import SettlementError, SettlementNotFound
from payment_integrity.infrastructure.postgres_event_store import (
    EventConflict,
    EventNotFound,
    EventReplayConflict,
    EventTenantConflict,
    PostgresEventStore,
)
from payment_integrity.infrastructure.postgres_queries import PostgresControlTowerQueries
from payment_integrity.infrastructure.postgres_settlement import PostgresSettlementService

from .metrics import MetricsRegistry
from .models import (
    DeadLetterReplayRequest,
    ExceptionReprocessRequest,
    ExceptionResolutionRequest,
    IngestionReceiptResponse,
    PaymentEventRequest,
    ReconciliationRunRequest,
    SettlementImportRequest,
)
from .settings import ApiSettings


def create_app(
    event_store: EventStore | None = None,
    settings: ApiSettings | None = None,
    queries: ControlTowerQueries | None = None,
    settlement: SettlementService | None = None,
) -> FastAPI:
    configured = settings or ApiSettings.from_env()
    store = event_store or PostgresEventStore(configured.database_url, configured.actor_id)
    read_queries = queries or (PostgresControlTowerQueries(configured.database_url) if event_store is None else None)
    settlement_service = settlement or (PostgresSettlementService(configured.database_url, configured.actor_id) if event_store is None else None)
    ingest = IngestPaymentEvent(store)
    metrics = MetricsRegistry()
    bearer = HTTPBearer(auto_error=False)
    app = FastAPI(title="Payment Integrity Control Tower", version="0.1.0")

    def require_scope(scope: str) -> Callable[..., str]:
        def dependency(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> str:
            if credentials is None or credentials.scheme.lower() != "bearer" or credentials.credentials != configured.api_token:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Credenciais ausentes ou inválidas.")
            if scope not in configured.scopes and "*" not in configured.scopes:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="forbidden")
            return configured.tenant_id

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

    @app.exception_handler(PaymentEventValidationError)
    async def domain_error(_request: Request, error: PaymentEventValidationError) -> Response:
        return JSONResponse(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, content={"detail": str(error), "code": "invalid_event"})

    @app.middleware("http")
    async def count_requests(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        metrics.increment("http_requests_total")
        content_length = request.headers.get("content-length")
        if content_length is not None and content_length.isdigit() and int(content_length) > configured.max_body_bytes:
            metrics.increment("http_responses_413_total")
            return JSONResponse(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                content={"error": "Payload muito grande.", "code": "payload_too_large"},
            )
        response = await call_next(request)
        metrics.increment(f"http_responses_{response.status_code}_total")
        return response

    @app.get("/v1/health/live")
    def live() -> dict[str, str]:
        return {"status": "ok", "service": "payment-integrity-python"}

    @app.get("/v1/health/ready")
    def ready() -> dict[str, str]:
        if not store.ready():
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="database_unavailable")
        return {"status": "ready", "service": "payment-integrity-python"}

    @app.get("/metrics", response_class=PlainTextResponse)
    @app.get("/v1/metrics", response_class=PlainTextResponse)
    def metrics_endpoint() -> str:
        return metrics.to_prometheus() + "\n"

    @app.post("/v1/events", response_model=IngestionReceiptResponse, status_code=status.HTTP_202_ACCEPTED)
    @app.post("/v1/payments/events", response_model=IngestionReceiptResponse, status_code=status.HTTP_202_ACCEPTED)
    def receive(event: PaymentEventRequest, authenticated_tenant: str = Depends(require_scope("control_tower:write"))) -> IngestionReceiptResponse:
        domain_event = event.to_domain()
        if domain_event.tenant_id != authenticated_tenant:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="tenant_forbidden")
        try:
            return IngestionReceiptResponse.from_domain(ingest.execute(domain_event.to_mapping()))
        except EventConflict as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    @app.post("/v1/events/dead-letter/{outbox_id}/replay", status_code=status.HTTP_202_ACCEPTED)
    def replay_dead_letter(
        outbox_id: str,
        body: DeadLetterReplayRequest | None = None,
        authenticated_tenant: str = Depends(require_scope("control_tower:write")),
    ) -> dict[str, str]:
        try:
            return store.requeue_dead_letter(outbox_id, authenticated_tenant, None if body is None else body.availableAt)
        except EventNotFound as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
        except EventTenantConflict as error:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
        except EventReplayConflict as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    @app.get("/v1/payments/{payment_id}/timeline")
    def payment_timeline(payment_id: str, authenticated_tenant: str = Depends(require_scope("control_tower:read"))) -> dict[str, object]:
        if read_queries is None:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="queries_unavailable")
        result = read_queries.get_payment_timeline(payment_id, authenticated_tenant)
        if result is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="payment_not_found")
        return result

    @app.get("/v1/payments/{payment_id}/ledger")
    def payment_ledger(payment_id: str, authenticated_tenant: str = Depends(require_scope("control_tower:read"))) -> dict[str, object]:
        if read_queries is None:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="queries_unavailable")
        result = read_queries.get_payment_ledger(payment_id, authenticated_tenant)
        if result is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="payment_not_found")
        return {"paymentId": payment_id, "journals": result}

    @app.get("/v1/exceptions")
    def exceptions(
        status_filter: str | None = Query(default=None, alias="status"),
        category: str | None = None,
        limit: int = 50,
        authenticated_tenant: str = Depends(require_scope("control_tower:read")),
    ) -> dict[str, object]:
        if read_queries is None:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="queries_unavailable")
        return {"exceptions": read_queries.list_exceptions(authenticated_tenant, status_filter, category, limit)}

    @app.post("/v1/settlements/imports", status_code=status.HTTP_202_ACCEPTED)
    def settlement_import(body: SettlementImportRequest, authenticated_tenant: str = Depends(require_scope("control_tower:write"))) -> dict[str, object]:
        if settlement_service is None:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="settlement_unavailable")
        try:
            return settlement_service.receive_csv(
                tenant_id=authenticated_tenant,
                provider=body.provider,
                provider_account_id=body.providerAccountId,
                file_name=body.fileName,
                period_start=body.periodStart,
                period_end=body.periodEnd,
                received_at=body.receivedAt,
                content=body.content,
            )
        except SettlementError as error:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error

    @app.post("/v1/reconciliation-runs", status_code=status.HTTP_201_CREATED)
    def reconciliation_run(body: ReconciliationRunRequest, authenticated_tenant: str = Depends(require_scope("control_tower:write"))) -> dict[str, object]:
        if settlement_service is None:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="settlement_unavailable")
        try:
            return settlement_service.reconcile(
                batch_id=body.batchId,
                tenant_id=authenticated_tenant,
                rule_version=body.ruleVersion,
                idempotency_key=body.idempotencyKey,
                requested_at=body.requestedAt,
            )
        except SettlementNotFound as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
        except SettlementError as error:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error

    @app.post("/v1/exceptions/{exception_id}/resolve")
    def resolve_exception(
        exception_id: str,
        body: ExceptionResolutionRequest,
        authenticated_tenant: str = Depends(require_scope("control_tower:write")),
    ) -> dict[str, object]:
        if settlement_service is None:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="settlement_unavailable")
        try:
            return settlement_service.resolve_exception(
                exception_id=exception_id,
                tenant_id=authenticated_tenant,
                actor_id=configured.actor_id,
                reason=body.reason,
                evidence=body.evidence,
                resolved_at=body.resolvedAt,
            )
        except SettlementNotFound as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
        except SettlementError as error:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error

    @app.post("/v1/exceptions/{exception_id}/reprocess")
    def reprocess_exception(
        exception_id: str,
        body: ExceptionReprocessRequest,
        authenticated_tenant: str = Depends(require_scope("control_tower:write")),
    ) -> dict[str, object]:
        if settlement_service is None:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="settlement_unavailable")
        try:
            return settlement_service.reprocess_exception(
                exception_id=exception_id,
                tenant_id=authenticated_tenant,
                actor_id=configured.actor_id,
                requested_at=body.requestedAt,
            )
        except SettlementNotFound as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
        except SettlementError as error:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error

    return app


app = create_app()
