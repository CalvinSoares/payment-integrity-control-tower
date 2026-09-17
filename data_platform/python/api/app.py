from __future__ import annotations

import os
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .models import IngestionReceipt, PaymentEvent
from .store import EventConflict, EventStore, PostgresEventStore


def create_app(store: EventStore | None = None, api_token: str | None = None) -> FastAPI:
    token = api_token or os.getenv("CONTROL_TOWER_API_TOKEN", "local-dev-token")
    event_store = store or PostgresEventStore(
        os.getenv("DATABASE_URL", "postgresql://integrity:integrity_dev@localhost:5438/payment_integrity"),
        os.getenv("CONTROL_TOWER_API_ACTOR_ID", "system:ingestion"),
    )
    app = FastAPI(title="Payment Integrity Control Tower", version="0.1.0")
    bearer = HTTPBearer(auto_error=False)

    def require_token(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> None:
        if credentials is None or credentials.scheme.lower() != "bearer" or credentials.credentials != token:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unauthorized")

    @app.get("/v1/health/live")
    def live() -> dict[str, str]:
        return {"status": "ok", "service": "payment-integrity-python"}

    @app.get("/v1/health/ready")
    def ready() -> dict[str, str]:
        if not event_store.ready():
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="database_unavailable")
        return {"status": "ready", "service": "payment-integrity-python"}

    @app.post("/v1/events", response_model=IngestionReceipt, status_code=status.HTTP_202_ACCEPTED)
    def receive(event: PaymentEvent, _: Any = Depends(require_token)) -> IngestionReceipt:
        try:
            return event_store.receive(event)
        except EventConflict as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    return app


app = create_app()
