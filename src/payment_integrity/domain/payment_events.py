"""Canonical payment event model and validation rules.

This module is intentionally independent from HTTP frameworks, databases and
provider SDKs. Provider adapters should translate their payloads into this
model before handing events to the application layer.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
from typing import Mapping


SUPPORTED_EVENT_TYPES = frozenset(
    {
        "payment.authorized",
        "payment.captured",
        "payment.settled",
        "payment.paid_out",
        "payment.canceled",
        "payment.voided",
        "payment.refunded",
        "payment.chargeback",
        "provider.timeout",
    }
)


class PaymentEventValidationError(ValueError):
    """Raised when an event does not satisfy the canonical contract."""


def canonical_json(value: Mapping[str, object]) -> str:
    """Serialize payloads deterministically for hashing and deduplication."""

    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def payload_hash(data: Mapping[str, object]) -> str:
    digest = hashlib.sha256(canonical_json(data).encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def _required_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PaymentEventValidationError(f"{field} é obrigatório")
    return value


def _validate_timestamp(value: object, field: str) -> str:
    timestamp = _required_text(value, field)
    try:
        datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError as error:
        raise PaymentEventValidationError(f"{field} deve ser uma data ISO válida") from error
    return timestamp


@dataclass(frozen=True, slots=True)
class PaymentEvent:
    """Provider-agnostic immutable representation of a payment event."""

    event_id: str
    event_type: str
    schema_version: int
    tenant_id: str
    provider: str
    provider_account_id: str
    external_payment_id: str
    external_event_id: str
    occurred_at: str
    received_at: str
    trace_id: str
    payload_hash: str
    data: Mapping[str, object]

    @classmethod
    def from_mapping(cls, raw: Mapping[str, object]) -> "PaymentEvent":
        required = (
            "eventId",
            "eventType",
            "schemaVersion",
            "tenantId",
            "provider",
            "providerAccountId",
            "externalPaymentId",
            "externalEventId",
            "occurredAt",
            "receivedAt",
            "traceId",
            "payloadHash",
            "data",
        )
        missing = [field for field in required if field not in raw]
        if missing:
            raise PaymentEventValidationError(f"campos ausentes: {', '.join(missing)}")

        schema_version = raw["schemaVersion"]
        if schema_version != 1:
            raise PaymentEventValidationError("schemaVersion deve ser 1")

        data = raw["data"]
        if not isinstance(data, Mapping):
            raise PaymentEventValidationError("data deve ser um objeto")
        copied_data = dict(data)

        event_type = _required_text(raw["eventType"], "eventType")
        if event_type not in SUPPORTED_EVENT_TYPES:
            raise PaymentEventValidationError(f"Tipo de evento não suportado: {event_type}")

        payment_id = copied_data.get("paymentId")
        _required_text(payment_id, "paymentId")
        external_payment_id = _required_text(raw["externalPaymentId"], "externalPaymentId")
        if copied_data.get("externalPaymentId") != external_payment_id:
            raise PaymentEventValidationError("externalPaymentId do envelope e dos dados deve ser igual")

        amount = copied_data.get("amountMinor")
        if amount is not None and (not isinstance(amount, int) or isinstance(amount, bool) or amount <= 0):
            raise PaymentEventValidationError("amountMinor deve ser um inteiro positivo")
        currency = copied_data.get("currency")
        if amount is not None and (not isinstance(currency, str) or len(currency) != 3 or currency != currency.upper()):
            raise PaymentEventValidationError("currency deve ser uma moeda ISO de 3 letras maiúsculas")

        declared_hash = _required_text(raw["payloadHash"], "payloadHash")
        if declared_hash != payload_hash(copied_data):
            raise PaymentEventValidationError("payloadHash não corresponde aos dados canônicos")

        return cls(
            event_id=_required_text(raw["eventId"], "eventId"),
            event_type=event_type,
            schema_version=1,
            tenant_id=_required_text(raw["tenantId"], "tenantId"),
            provider=_required_text(raw["provider"], "provider"),
            provider_account_id=_required_text(raw["providerAccountId"], "providerAccountId"),
            external_payment_id=external_payment_id,
            external_event_id=_required_text(raw["externalEventId"], "externalEventId"),
            occurred_at=_validate_timestamp(raw["occurredAt"], "occurredAt"),
            received_at=_validate_timestamp(raw["receivedAt"], "receivedAt"),
            trace_id=_required_text(raw["traceId"], "traceId"),
            payload_hash=declared_hash,
            data=copied_data,
        )

    def to_mapping(self) -> dict[str, object]:
        """Return the canonical wire representation used by adapters."""

        return {
            "eventId": self.event_id,
            "eventType": self.event_type,
            "schemaVersion": self.schema_version,
            "tenantId": self.tenant_id,
            "provider": self.provider,
            "providerAccountId": self.provider_account_id,
            "externalPaymentId": self.external_payment_id,
            "externalEventId": self.external_event_id,
            "occurredAt": self.occurred_at,
            "receivedAt": self.received_at,
            "traceId": self.trace_id,
            "payloadHash": self.payload_hash,
            "data": dict(self.data),
        }
