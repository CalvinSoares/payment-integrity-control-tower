"""FastAPI composition root for the new Python package."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from payment_integrity.application.ingest_events import IngestPaymentEvent
from payment_integrity.application.ports import EventStore
from payment_integrity.domain.payment_events import PaymentEventValidationError
from payment_integrity.infrastructure.postgres_event_store import EventConflict, PostgresEventStore

from .metrics import MetricsRegistry
from .models import IngestionReceiptResponse, PaymentEventRequest
from .settings import ApiSettings


def create_app(event_store: EventStore | None = None, settings: ApiSettings | None = None) -> FastAPI:
    configured = settings or ApiSettings.from_env()
    store = event_store or PostgresEventStore(configured.database_url, configured.actor_id)
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

    return app


app = create_app()
