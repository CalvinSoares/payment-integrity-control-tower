from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from .api.models import PaymentEvent


class PaymentProcessingError(Exception):
    pass


TARGET_STATES = {
    "payment.authorized": "AUTHORIZED",
    "payment.captured": "CAPTURED",
    "payment.settled": "SETTLED",
    "payment.paid_out": "PAID_OUT",
    "payment.canceled": "CANCELED",
    "payment.voided": "VOIDED",
    "payment.refunded": "REFUNDED",
    "payment.chargeback": "CHARGEBACK",
}

ALLOWED_TRANSITIONS = {
    "CREATED": {"AUTHORIZED", "CANCELED"},
    "AUTHORIZED": {"CAPTURED", "VOIDED", "CANCELED"},
    "CAPTURED": {"SETTLED", "REFUNDED", "CHARGEBACK"},
    "SETTLED": {"PAID_OUT", "REFUNDED", "CHARGEBACK"},
    "PAID_OUT": {"REFUNDED", "CHARGEBACK"},
    "CANCELED": set(),
    "VOIDED": set(),
    "REFUNDED": set(),
    "CHARGEBACK": set(),
}


class PaymentEventProcessor:
    def __init__(self, actor_id: str = "system:processor") -> None:
        self.actor_id = actor_id

    def __call__(self, event: PaymentEvent, connection: psycopg.Connection[Any]) -> None:
        payment = self._find_payment(connection, event)
        if payment is None:
            if event.eventType != "payment.authorized":
                raise PaymentProcessingError(
                    f"Pagamento não encontrado para o evento {event.eventId}: {event.data['paymentId']}"
                )
            payment = self._create_from_authorization(connection, event)

        if event.eventType == "provider.timeout":
            self._append_audit(
                connection,
                audit_id=f"audit:payment-timeout:{event.eventId}",
                tenant_id=event.tenantId,
                action="PROVIDER_TIMEOUT",
                entity_id=payment[0],
                event=event,
                metadata={"state": payment[3]},
            )
            return

        self._assert_event_matches_payment(payment, event)
        target_state = TARGET_STATES[event.eventType]
        current_state = payment[3]
        if target_state not in ALLOWED_TRANSITIONS.get(current_state, set()):
            raise PaymentProcessingError(f"Transição de pagamento inválida: {current_state} → {target_state}.")

        amount_minor = payment[4]
        currency = payment[5].strip()
        if event.eventType == "payment.captured":
            self._append_capture_journal(connection, event, amount_minor, currency)

        self._update_payment(connection, payment[0], target_state, event.occurredAt)
        self._append_audit(
            connection,
            audit_id=f"audit:payment-transition:{event.eventId}",
            tenant_id=event.tenantId,
            action=f"PAYMENT_{target_state}",
            entity_id=payment[0],
            event=event,
            metadata={"previousState": current_state, "targetState": target_state},
        )

    @staticmethod
    def _find_payment(connection: psycopg.Connection[Any], event: PaymentEvent) -> tuple[Any, ...] | None:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, tenant_id, external_payment_id, state, amount_minor, currency
                  FROM payments
                 WHERE tenant_id = %s AND id = %s
                 FOR UPDATE
                """,
                (event.tenantId, event.data["paymentId"]),
            )
            return cursor.fetchone()

    def _create_from_authorization(self, connection: psycopg.Connection[Any], event: PaymentEvent) -> tuple[Any, ...]:
        amount_minor = event.data.get("amountMinor")
        currency = event.data.get("currency")
        if not isinstance(amount_minor, int) or isinstance(amount_minor, bool) or amount_minor <= 0:
            raise PaymentProcessingError("Evento de autorização precisa informar amountMinor positivo.")
        if not isinstance(currency, str) or len(currency) != 3 or currency != currency.upper():
            raise PaymentProcessingError("Evento de autorização precisa informar currency ISO em maiúsculas.")

        payment_id = event.data["paymentId"]
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO payments
                  (id, tenant_id, external_payment_id, amount_minor, currency, state, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, 'CREATED', %s::timestamptz, %s::timestamptz)
                """,
                (payment_id, event.tenantId, event.externalPaymentId, amount_minor, currency, event.occurredAt, event.occurredAt),
            )
        payment = (payment_id, event.tenantId, event.externalPaymentId, "CREATED", amount_minor, currency)
        self._append_audit(
            connection,
            audit_id=f"audit:payment-created:{event.eventId}",
            tenant_id=event.tenantId,
            action="PAYMENT_CREATED",
            entity_id=payment_id,
            event=event,
            metadata={"state": "CREATED", "amountMinor": amount_minor, "currency": currency},
        )
        return payment

    @staticmethod
    def _assert_event_matches_payment(payment: tuple[Any, ...], event: PaymentEvent) -> None:
        if payment[2] != event.externalPaymentId:
            raise PaymentProcessingError("externalPaymentId do evento não corresponde ao pagamento.")
        amount_minor = event.data.get("amountMinor")
        if amount_minor is not None and amount_minor != payment[4]:
            raise PaymentProcessingError("amountMinor do evento não corresponde ao pagamento.")
        currency = event.data.get("currency")
        if currency is not None and currency != payment[5].strip():
            raise PaymentProcessingError("currency do evento não corresponde ao pagamento.")

    @staticmethod
    def _update_payment(connection: psycopg.Connection[Any], payment_id: str, state: str, occurred_at: str) -> None:
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE payments SET state = %s, updated_at = %s::timestamptz WHERE id = %s",
                (state, occurred_at, payment_id),
            )
            if cursor.rowcount != 1:
                raise PaymentProcessingError(f"Pagamento ausente: {payment_id}")

    @staticmethod
    def _append_capture_journal(connection: psycopg.Connection[Any], event: PaymentEvent, amount_minor: int, currency: str) -> None:
        journal_id = f"journal:event:{event.eventId}"
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO ledger_journals (journal_id, source_event_id, created_at)
                VALUES (%s, %s, %s::timestamptz)
                ON CONFLICT (source_event_id) DO NOTHING
                """,
                (journal_id, event.eventId, event.occurredAt),
            )
            cursor.execute(
                """
                INSERT INTO ledger_entries
                  (line_id, journal_id, account_id, direction, amount_minor, currency, reference_type, reference_id)
                VALUES
                  (%s, %s, 'acquirer_receivable', 'DEBIT', %s, %s, 'Payment', %s),
                  (%s, %s, 'merchant_obligation', 'CREDIT', %s, %s, 'Payment', %s)
                ON CONFLICT (line_id) DO NOTHING
                """,
                (
                    f"{journal_id}:line:1", journal_id, amount_minor, currency, event.data["paymentId"],
                    f"{journal_id}:line:2", journal_id, amount_minor, currency, event.data["paymentId"],
                ),
            )

    def _append_audit(
        self,
        connection: psycopg.Connection[Any],
        audit_id: str,
        tenant_id: str,
        action: str,
        entity_id: str,
        event: PaymentEvent,
        metadata: dict[str, object],
    ) -> None:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO audit_events
                  (audit_id, tenant_id, actor_id, action, entity_type, entity_id, source_event_id, occurred_at, metadata)
                VALUES (%s, %s, %s, %s, 'Payment', %s, %s, %s::timestamptz, %s)
                ON CONFLICT (audit_id) DO NOTHING
                """,
                (audit_id, tenant_id, self.actor_id, action, entity_id, event.eventId, event.occurredAt, Jsonb(metadata)),
            )


def processor_now() -> str:
    return datetime.now(timezone.utc).isoformat()
