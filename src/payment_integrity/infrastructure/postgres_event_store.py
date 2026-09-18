"""PostgreSQL adapter for the canonical event store.

This is an infrastructure implementation of the application ``EventStore``
port. SQL, psycopg and JSONB details stay in this module; callers exchange
only domain events and receipts.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import psycopg
from psycopg.types.json import Jsonb

from payment_integrity.domain.payment_events import PaymentEvent
from payment_integrity.domain.receipts import IngestionReceipt


class EventStoreError(Exception):
    """Base exception for event-store adapter failures."""


class EventConflict(EventStoreError):
    """The same external identity was received with different content."""


class EventNotFound(EventStoreError):
    """An outbox message could not be found."""


class EventTenantConflict(EventStoreError):
    """An event or outbox message belongs to another tenant."""


class EventReplayConflict(EventStoreError):
    """An outbox message is not eligible for replay."""


class PostgresEventStore:
    """Persist canonical events using PostgreSQL inbox/outbox tables."""

    def __init__(self, database_url: str, actor_id: str = "system:ingestion") -> None:
        self.database_url = database_url
        self.actor_id = actor_id

    def receive(self, event: PaymentEvent) -> IngestionReceipt:
        event_json = event.to_mapping()
        deduplication_key = self._deduplication_key(event)
        with psycopg.connect(self.database_url) as connection:
            with connection.transaction():
                existing = self._find_by_deduplication_key(connection, deduplication_key)
                if existing:
                    return self._replay_or_conflict(existing, event)

                event_id = event.event_id
                inbox_id = f"inbox:{event_id}"
                outbox_id = f"outbox:{event_id}"
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        INSERT INTO event_inbox
                          (inbox_id, event_id, deduplication_key, tenant_id, provider,
                           provider_account_id, external_event_id, event_type, schema_version,
                           payload_hash, event_json, status, attempts, received_at)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'RECEIVED', 0, %s::timestamptz)
                        ON CONFLICT DO NOTHING
                        """,
                        (
                            inbox_id,
                            event_id,
                            deduplication_key,
                            event.tenant_id,
                            event.provider,
                            event.provider_account_id,
                            event.external_event_id,
                            event.event_type,
                            event.schema_version,
                            event.payload_hash,
                            Jsonb(event_json),
                            event.received_at,
                        ),
                    )

                existing = self._find_by_deduplication_key(connection, deduplication_key)
                if existing is None or existing["event_id"] != event_id:
                    raise EventConflict("eventId já existe com outra chave de deduplicação")

                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        INSERT INTO event_outbox
                          (outbox_id, event_id, topic, event_json, status, attempts, available_at)
                        VALUES (%s, %s, 'payment-events.v1', %s, 'PENDING', 0, %s::timestamptz)
                        ON CONFLICT DO NOTHING
                        """,
                        (outbox_id, event_id, Jsonb(event_json), event.received_at),
                    )
                    cursor.execute(
                        """
                        INSERT INTO audit_events
                          (audit_id, tenant_id, actor_id, action, entity_type, entity_id,
                           source_event_id, occurred_at, metadata)
                        VALUES (%s, %s, %s, 'EVENT_RECEIVED', 'PaymentEvent', %s, %s, %s::timestamptz, %s)
                        ON CONFLICT (audit_id) DO NOTHING
                        """,
                        (
                            f"audit:{event_id}",
                            event.tenant_id,
                            self.actor_id,
                            event_id,
                            event_id,
                            event.occurred_at,
                            Jsonb({"eventType": event.event_type, "provider": event.provider, "deduplicationKey": deduplication_key}),
                        ),
                    )

        return IngestionReceipt("RECEIVED", event_id, inbox_id, outbox_id)

    def ready(self) -> bool:
        try:
            with psycopg.connect(self.database_url) as connection:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT 1")
                    cursor.fetchone()
            return True
        except psycopg.Error:
            return False

    def requeue_dead_letter(self, outbox_id: str, tenant_id: str, available_at: str | None = None) -> dict[str, str]:
        requested_at = available_at or datetime.now(timezone.utc).isoformat()
        with psycopg.connect(self.database_url) as connection:
            with connection.transaction():
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT outbox_id, event_id, event_json, status FROM event_outbox WHERE outbox_id = %s FOR UPDATE",
                        (outbox_id,),
                    )
                    row = cursor.fetchone()
                    if row is None:
                        raise EventNotFound("Mensagem não encontrada.")
                    event = PaymentEvent.from_mapping(row[2])
                    if event.tenant_id != tenant_id:
                        raise EventTenantConflict("A mensagem não pertence ao tenant autenticado.")
                    if row[3] != "DEAD_LETTER":
                        raise EventReplayConflict("A mensagem não está na DLQ.")
                    cursor.execute(
                        """
                        UPDATE event_outbox
                        SET status = 'PENDING', attempts = 0, available_at = %s::timestamptz,
                            processing_started_at = NULL, last_error = NULL
                        WHERE outbox_id = %s
                        """,
                        (requested_at, outbox_id),
                    )

        return {
            "status": "REQUEUED",
            "outboxId": outbox_id,
            "eventId": event.event_id,
            "deduplicationKey": self._deduplication_key(event),
            "availableAt": requested_at,
        }

    @staticmethod
    def _deduplication_key(event: PaymentEvent) -> str:
        return json.dumps(
            [event.provider, event.provider_account_id, event.external_event_id],
            ensure_ascii=False,
            separators=(",", ":"),
        )

    @staticmethod
    def _find_by_deduplication_key(connection: psycopg.Connection[object], key: str) -> dict[str, str] | None:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT inbox_id, event_id, event_type, payload_hash FROM event_inbox WHERE deduplication_key = %s",
                (key,),
            )
            row = cursor.fetchone()
        if row is None:
            return None
        return {"inbox_id": row[0], "event_id": row[1], "event_type": row[2], "payload_hash": row[3]}

    @staticmethod
    def _replay_or_conflict(existing: dict[str, str], event: PaymentEvent) -> IngestionReceipt:
        if existing["payload_hash"] != event.payload_hash or existing["event_type"] != event.event_type:
            raise EventConflict("O evento externo já foi recebido com outro payload.")
        return IngestionReceipt("REPLAYED", existing["event_id"], existing["inbox_id"], f"outbox:{existing['event_id']}")
