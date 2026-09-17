from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, model_validator

from ..normalize_events import payload_hash


class PaymentEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    eventId: str
    eventType: str
    schemaVersion: Literal[1]
    tenantId: str
    provider: str
    providerAccountId: str
    externalPaymentId: str
    externalEventId: str
    occurredAt: str
    receivedAt: str
    traceId: str
    payloadHash: str
    data: dict[str, Any]

    @model_validator(mode="after")
    def validate_contract(self) -> "PaymentEvent":
        text_fields = (
            "eventId", "eventType", "tenantId", "provider", "providerAccountId",
            "externalPaymentId", "externalEventId", "traceId", "payloadHash",
        )
        for field in text_fields:
            if not getattr(self, field).strip():
                raise ValueError(f"{field} é obrigatório")
        for field in ("occurredAt", "receivedAt"):
            try:
                datetime.fromisoformat(getattr(self, field).replace("Z", "+00:00"))
            except ValueError as error:
                raise ValueError(f"{field} deve ser uma data ISO válida") from error
        if self.data.get("externalPaymentId") != self.externalPaymentId:
            raise ValueError("externalPaymentId do envelope e dos dados deve ser igual")
        amount = self.data.get("amountMinor")
        if amount is not None and (not isinstance(amount, int) or isinstance(amount, bool) or amount <= 0):
            raise ValueError("amountMinor deve ser um inteiro positivo")
        currency = self.data.get("currency")
        if amount is not None and (not isinstance(currency, str) or len(currency) != 3 or currency != currency.upper()):
            raise ValueError("currency deve ser uma moeda ISO de 3 letras maiúsculas")
        if self.payloadHash != payload_hash(self.data):
            raise ValueError("payloadHash não corresponde aos dados canônicos")
        return self


class IngestionReceipt(BaseModel):
    status: Literal["RECEIVED", "REPLAYED"]
    eventId: str
    inboxId: str
    outboxId: str
