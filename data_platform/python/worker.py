from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

import psycopg

from .api.models import PaymentEvent


logger = logging.getLogger("payment-integrity.worker")
EventHandler = Callable[[PaymentEvent, psycopg.Connection[Any]], None]


@dataclass(frozen=True)
class WorkerResult:
    status: str
    event_id: str | None = None
    error: str | None = None
    next_attempt_at: str | None = None
    attempts: int | None = None


def retry_delay_ms(attempts: int, base_delay_ms: int, max_delay_ms: int) -> int:
    exponent = max(attempts - 1, 0)
    return min(max_delay_ms, base_delay_ms * 2**exponent)


class PostgresEventWorker:
    def __init__(
        self,
        database_url: str,
        handler: EventHandler | None = None,
        max_attempts: int = 3,
        base_delay_ms: int = 1_000,
        max_delay_ms: int = 60_000,
        lease_ms: int = 5 * 60 * 1_000,
    ) -> None:
        if max_attempts <= 0:
            raise ValueError("max_attempts deve ser positivo")
        if base_delay_ms < 0 or max_delay_ms < base_delay_ms or lease_ms <= 0:
            raise ValueError("política de retry/lease inválida")
        self.database_url = database_url
        self.handler = handler or self.log_event
        self.max_attempts = max_attempts
        self.base_delay_ms = base_delay_ms
        self.max_delay_ms = max_delay_ms
        self.lease_ms = lease_ms

    @staticmethod
    def log_event(event: PaymentEvent, _connection: psycopg.Connection[Any]) -> None:
        logger.info(
            "event_processed event_id=%s event_type=%s tenant_id=%s",
            event.eventId,
            event.eventType,
            event.tenantId,
        )

    def process_next(self, now: datetime | None = None) -> WorkerResult:
        current_time = now or datetime.now(timezone.utc)
        now_iso = current_time.isoformat()
        with psycopg.connect(self.database_url) as connection:
            with connection.transaction():
                self._recover_stale_processing(connection, now_iso)
                message = self._claim_next(connection, now_iso)
                if message is None:
                    return WorkerResult(status="IDLE")

                outbox_id, event_id, event_json, attempts = message
                event = PaymentEvent.model_validate(event_json)
                inbox = self._find_inbox(connection, event_id)
                if inbox is None:
                    error = "Inbox ausente para a mensagem do outbox."
                    self._mark_outbox_failed(connection, outbox_id, error)
                    return WorkerResult(status="REJECTED", event_id=event_id, error=error, attempts=attempts)

                inbox_id = inbox[0]
                self._mark_inbox_processing(connection, inbox_id)
                try:
                    self.handler(event, connection)
                except Exception as error:  # noqa: BLE001 - falha do handler precisa entrar no retry
                    return self._schedule_failure(connection, outbox_id, inbox_id, event_id, now_iso, attempts, error)

                processed_at = datetime.now(timezone.utc).isoformat()
                self._mark_inbox_applied(connection, inbox_id, processed_at)
                self._mark_outbox_published(connection, outbox_id, processed_at)
                return WorkerResult(status="APPLIED", event_id=event_id, attempts=attempts)

    def run_forever(self, poll_ms: int = 250, stop_requested: Callable[[], bool] | None = None) -> None:
        if poll_ms < 0:
            raise ValueError("poll_ms deve ser não negativo")
        should_stop = stop_requested or (lambda: False)
        while not should_stop():
            result = self.process_next()
            logger.info("worker_result status=%s event_id=%s attempts=%s", result.status, result.event_id, result.attempts)
            if result.status in {"IDLE", "RETRY_SCHEDULED"}:
                time.sleep(poll_ms / 1_000)

    def _schedule_failure(
        self,
        connection: psycopg.Connection[Any],
        outbox_id: str,
        inbox_id: str,
        event_id: str,
        now_iso: str,
        attempts: int,
        error: Exception,
    ) -> WorkerResult:
        error_text = str(error) or error.__class__.__name__
        if attempts >= self.max_attempts:
            self._mark_inbox_rejected(connection, inbox_id, error_text)
            self._schedule_outbox(connection, outbox_id, now_iso, error_text, dead_letter=True)
            return WorkerResult(status="REJECTED", event_id=event_id, error=error_text, attempts=attempts)

        delay_ms = retry_delay_ms(attempts, self.base_delay_ms, self.max_delay_ms)
        next_attempt = (datetime.fromisoformat(now_iso) + timedelta(milliseconds=delay_ms)).isoformat()
        self._mark_inbox_received(connection, inbox_id, error_text)
        self._schedule_outbox(connection, outbox_id, next_attempt, error_text, dead_letter=False)
        return WorkerResult(
            status="RETRY_SCHEDULED",
            event_id=event_id,
            error=error_text,
            next_attempt_at=next_attempt,
            attempts=attempts,
        )

    def _recover_stale_processing(self, connection: psycopg.Connection[Any], now_iso: str) -> None:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE event_outbox
                   SET status = 'PENDING', available_at = %s::timestamptz,
                       processing_started_at = NULL,
                       last_error = 'Lease de processamento expirado.'
                 WHERE status = 'PROCESSING'
                   AND processing_started_at <= (%s::timestamptz - (%s::text || ' milliseconds')::interval)
                """,
                (now_iso, now_iso, self.lease_ms),
            )

    @staticmethod
    def _claim_next(connection: psycopg.Connection[Any], now_iso: str) -> tuple[str, str, dict[str, Any], int] | None:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                WITH next_message AS (
                    SELECT outbox_id
                      FROM event_outbox
                     WHERE status = 'PENDING' AND available_at <= %s::timestamptz
                     ORDER BY available_at, outbox_id
                     FOR UPDATE SKIP LOCKED
                     LIMIT 1
                )
                UPDATE event_outbox AS outbox
                   SET status = 'PROCESSING', attempts = outbox.attempts + 1,
                       processing_started_at = %s::timestamptz
                  FROM next_message
                 WHERE outbox.outbox_id = next_message.outbox_id
                RETURNING outbox.outbox_id, outbox.event_id, outbox.event_json, outbox.attempts
                """,
                (now_iso, now_iso),
            )
            row = cursor.fetchone()
        return None if row is None else (row[0], row[1], row[2], row[3])

    @staticmethod
    def _find_inbox(connection: psycopg.Connection[Any], event_id: str) -> tuple[str] | None:
        with connection.cursor() as cursor:
            cursor.execute("SELECT inbox_id FROM event_inbox WHERE event_id = %s", (event_id,))
            row = cursor.fetchone()
        return None if row is None else (row[0],)

    @staticmethod
    def _mark_inbox_processing(connection: psycopg.Connection[Any], inbox_id: str) -> None:
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE event_inbox SET status = 'PROCESSING', attempts = attempts + 1 WHERE inbox_id = %s",
                (inbox_id,),
            )

    @staticmethod
    def _mark_inbox_applied(connection: psycopg.Connection[Any], inbox_id: str, processed_at: str) -> None:
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE event_inbox SET status = 'APPLIED', processed_at = %s::timestamptz WHERE inbox_id = %s",
                (processed_at, inbox_id),
            )

    @staticmethod
    def _mark_inbox_received(connection: psycopg.Connection[Any], inbox_id: str, error: str) -> None:
        with connection.cursor() as cursor:
            cursor.execute("UPDATE event_inbox SET status = 'RECEIVED', last_error = %s WHERE inbox_id = %s", (error, inbox_id))

    @staticmethod
    def _mark_inbox_rejected(connection: psycopg.Connection[Any], inbox_id: str, error: str) -> None:
        with connection.cursor() as cursor:
            cursor.execute("UPDATE event_inbox SET status = 'REJECTED', last_error = %s WHERE inbox_id = %s", (error, inbox_id))

    @staticmethod
    def _mark_outbox_published(connection: psycopg.Connection[Any], outbox_id: str, published_at: str) -> None:
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE event_outbox SET status = 'PUBLISHED', published_at = %s::timestamptz, processing_started_at = NULL WHERE outbox_id = %s",
                (published_at, outbox_id),
            )

    @staticmethod
    def _mark_outbox_failed(connection: psycopg.Connection[Any], outbox_id: str, error: str) -> None:
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE event_outbox SET status = 'FAILED', last_error = %s, processing_started_at = NULL WHERE outbox_id = %s",
                (error, outbox_id),
            )

    @staticmethod
    def _schedule_outbox(connection: psycopg.Connection[Any], outbox_id: str, available_at: str, error: str, dead_letter: bool) -> None:
        status = "DEAD_LETTER" if dead_letter else "PENDING"
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE event_outbox SET status = %s, available_at = %s::timestamptz, last_error = %s, processing_started_at = NULL WHERE outbox_id = %s",
                (status, available_at, error, outbox_id),
            )


def default_database_url() -> str:
    return os.getenv("DATABASE_URL", "postgresql://integrity:integrity_dev@localhost:5438/payment_integrity")
