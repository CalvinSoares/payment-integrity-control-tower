from __future__ import annotations

import json
from typing import Protocol

import psycopg
from psycopg.types.json import Jsonb

from .models import IngestionReceipt, PaymentEvent


class EventConflict(Exception):
    pass


class EventStore(Protocol):
    def receive(self, event: PaymentEvent) -> IngestionReceipt: ...

    def ready(self) -> bool: ...


class PostgresEventStore:
    def __init__(self, database_url: str, actor_id: str = "system:ingestion") -> None:
        self.database_url = database_url
        self.actor_id = actor_id

    def receive(self, event: PaymentEvent) -> IngestionReceipt:
        event_json = event.model_dump(mode="json")
        deduplication_key = json.dumps(
            [event.provider, event.providerAccountId, event.externalEventId],
            ensure_ascii=False,
            separators=(",", ":"),
        )
        with psycopg.connect(self.database_url) as connection:
            with connection.transaction():
                existing = self._find_by_deduplication_key(connection, deduplication_key)
                if existing:
                    return self._replay_or_conflict(existing, event)

                event_id = event.eventId
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
                        (inbox_id, event_id, deduplication_key, event.tenantId, event.provider,
                         event.providerAccountId, event.externalEventId, event.eventType,
                         event.schemaVersion, event.payloadHash, Jsonb(event_json), event.receivedAt),
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
                        (outbox_id, event_id, Jsonb(event_json), event.receivedAt),
                    )
                    cursor.execute(
                        """
                        INSERT INTO audit_events
                          (audit_id, tenant_id, actor_id, action, entity_type, entity_id,
                           source_event_id, occurred_at, metadata)
                        VALUES (%s, %s, %s, 'EVENT_RECEIVED', 'PaymentEvent', %s, %s, %s::timestamptz, %s)
                        ON CONFLICT (audit_id) DO NOTHING
                        """,
                        (f"audit:{event_id}", event.tenantId, self.actor_id, event_id, event_id,
                         event.occurredAt, Jsonb({"eventType": event.eventType, "provider": event.provider, "deduplicationKey": deduplication_key})),
                    )
        return IngestionReceipt(status="RECEIVED", eventId=event_id, inboxId=inbox_id, outboxId=outbox_id)

    def ready(self) -> bool:
        try:
            with psycopg.connect(self.database_url) as connection:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT 1")
                    cursor.fetchone()
            return True
        except psycopg.Error:
            return False

    @staticmethod
    def _find_by_deduplication_key(connection: psycopg.Connection, key: str) -> dict[str, str] | None:
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
        if existing["payload_hash"] != event.payloadHash or existing["event_type"] != event.eventType:
            raise EventConflict("O evento externo já foi recebido com outro payload.")
        return IngestionReceipt(
            status="REPLAYED",
            eventId=existing["event_id"],
            inboxId=existing["inbox_id"],
            outboxId=f"outbox:{existing['event_id']}",
        )
