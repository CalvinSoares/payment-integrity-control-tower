"""HTTP request and response models for the API boundary."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

from payment_integrity.domain.payment_events import PaymentEvent
from payment_integrity.domain.receipts import IngestionReceipt


class PaymentEventRequest(BaseModel):
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
    data: dict[str, object]

    def to_domain(self) -> PaymentEvent:
        return PaymentEvent.from_mapping(self.model_dump(mode="python"))


class IngestionReceiptResponse(BaseModel):
    status: Literal["RECEIVED", "REPLAYED"]
    eventId: str
    inboxId: str
    outboxId: str

    @classmethod
    def from_domain(cls, receipt: IngestionReceipt) -> "IngestionReceiptResponse":
        return cls(**receipt.to_mapping())


class SettlementImportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str
    providerAccountId: str
    fileName: str
    periodStart: str
    periodEnd: str
    receivedAt: str
    content: str


class ReconciliationRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    batchId: str
    ruleVersion: str
    idempotencyKey: str
    requestedAt: str


class ExceptionResolutionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str
    evidence: list[str]
    resolvedAt: str


class ExceptionReprocessRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    requestedAt: str
