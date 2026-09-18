from __future__ import annotations

from typing import Any

import psycopg


def _iso_date(value: Any) -> str:
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _minor(value: Any, field: str) -> int:
    parsed = int(value)
    if abs(parsed) > 9_007_199_254_740_991:
        raise ValueError(f"{field} excede o limite seguro")
    return parsed


def _map_payment(row: tuple[Any, ...]) -> dict[str, Any]:
    return {
        "id": row[0],
        "tenantId": row[1],
        "externalPaymentId": row[2],
        "amountMinor": _minor(row[3], "amountMinor"),
        "currency": str(row[4]).strip(),
        "state": row[5],
        "createdAt": _iso_date(row[6]),
        "updatedAt": _iso_date(row[7]),
    }


def _map_journals(rows: list[tuple[Any, ...]]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    for row in rows:
        journal_id = row[0]
        journal = grouped.setdefault(
            journal_id,
            {
                "journalId": journal_id,
                "sourceEventId": row[1],
                "createdAt": _iso_date(row[2]),
                "lines": [],
            },
        )
        journal["lines"].append(
            {
                "lineId": row[3],
                "accountId": row[4],
                "direction": row[5],
                "amountMinor": _minor(row[6], "amountMinor"),
                "currency": str(row[7]).strip(),
                "referenceType": row[8],
                "referenceId": row[9],
            }
        )
    return list(grouped.values())


def _map_exception(row: tuple[Any, ...]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "exceptionId": row[0],
        "tenantId": row[1],
        "runId": row[2],
        "itemId": row[3],
        "batchId": row[4],
        "category": row[5],
        "severity": row[6],
        "status": row[7],
        "currency": str(row[11]).strip(),
        "evidence": row[12],
        "ruleVersion": row[13],
        "reprocessable": row[14],
        "createdAt": _iso_date(row[15]),
    }
    for key, index in (("expectedMinor", 8), ("observedMinor", 9), ("differenceMinor", 10)):
        if row[index] is not None:
            result[key] = _minor(row[index], key)
    if row[16] is not None:
        result["resolvedAt"] = _iso_date(row[16])
    if row[17] is not None:
        result["resolution"] = row[17]
    return result


class PostgresControlTowerQueries:
    def __init__(self, database_url: str) -> None:
        self.database_url = database_url

    def _payment(self, cursor: psycopg.Cursor[Any], payment_id: str, tenant_id: str) -> dict[str, Any] | None:
        cursor.execute(
            """
            SELECT id, tenant_id, external_payment_id, amount_minor, currency, state, created_at, updated_at
            FROM payments WHERE id = %s AND tenant_id = %s
            """,
            (payment_id, tenant_id),
        )
        row = cursor.fetchone()
        return None if row is None else _map_payment(row)

    @staticmethod
    def _ledger(cursor: psycopg.Cursor[Any], payment_id: str) -> list[dict[str, Any]]:
        cursor.execute(
            """
            SELECT j.journal_id, j.source_event_id, j.created_at,
                   e.line_id, e.account_id, e.direction, e.amount_minor, e.currency,
                   e.reference_type, e.reference_id
            FROM ledger_journals j
            INNER JOIN ledger_entries e ON e.journal_id = j.journal_id
            WHERE e.reference_type = 'Payment' AND e.reference_id = %s
            ORDER BY j.created_at, e.line_id
            """,
            (payment_id,),
        )
        return _map_journals(cursor.fetchall())

    @staticmethod
    def _exceptions_for_payment(cursor: psycopg.Cursor[Any], tenant_id: str, external_payment_id: str, payment_id: str) -> list[dict[str, Any]]:
        cursor.execute(
            """
            SELECT exception_id, tenant_id, run_id, item_id, batch_id, category, severity, status,
                   expected_minor, observed_minor, difference_minor, currency, evidence_json, rule_version,
                   reprocessable, created_at, resolved_at, resolution
            FROM exception_cases
            WHERE tenant_id = %s AND (item_id IN (
              SELECT item_id FROM reconciliation_items WHERE external_payment_id = %s
            ) OR item_id IN (
              SELECT item_id FROM reconciliation_items WHERE payment_id = %s
            ))
            ORDER BY created_at, exception_id
            """,
            (tenant_id, external_payment_id, payment_id),
        )
        return [_map_exception(row) for row in cursor.fetchall()]

    def get_payment_timeline(self, payment_id: str, tenant_id: str) -> dict[str, Any] | None:
        with psycopg.connect(self.database_url) as connection, connection.cursor() as cursor:
            payment = self._payment(cursor, payment_id, tenant_id)
            if payment is None:
                return None
            cursor.execute(
                """
                SELECT event_id, event_type, (event_json->>'occurredAt')::timestamptz,
                       provider, status
                FROM event_inbox
                WHERE tenant_id = %s AND (event_json->'data'->>'paymentId' = %s OR external_event_id = %s)
                ORDER BY (event_json->>'occurredAt')::timestamptz, event_id
                """,
                (tenant_id, payment_id, payment_id),
            )
            events = [
                {
                    "eventId": row[0],
                    "eventType": row[1],
                    "occurredAt": _iso_date(row[2]),
                    "provider": row[3],
                    "status": row[4],
                }
                for row in cursor.fetchall()
            ]
            cursor.execute(
                """
                SELECT audit_id, action, actor_id, occurred_at, metadata
                FROM audit_events WHERE entity_type = 'Payment' AND entity_id = %s
                ORDER BY occurred_at, audit_id
                """,
                (payment_id,),
            )
            audit = [
                {"auditId": row[0], "action": row[1], "actorId": row[2], "occurredAt": _iso_date(row[3]), "metadata": row[4]}
                for row in cursor.fetchall()
            ]
            cursor.execute(
                """
                SELECT item_id, status, category, run_id, evidence_json
                FROM reconciliation_items WHERE external_payment_id = %s ORDER BY item_id
                """,
                (payment["externalPaymentId"],),
            )
            settlement_items = [
                {"itemId": row[0], "status": row[1], **({} if row[2] is None else {"category": row[2]}), "runId": row[3], "evidence": row[4]}
                for row in cursor.fetchall()
            ]
            return {
                "payment": payment,
                "events": events,
                "ledger": self._ledger(cursor, payment_id),
                "audit": audit,
                "settlementItems": settlement_items,
                "exceptions": self._exceptions_for_payment(cursor, tenant_id, payment["externalPaymentId"], payment_id),
            }

    def get_payment_ledger(self, payment_id: str, tenant_id: str) -> list[dict[str, Any]] | None:
        with psycopg.connect(self.database_url) as connection, connection.cursor() as cursor:
            if self._payment(cursor, payment_id, tenant_id) is None:
                return None
            return self._ledger(cursor, payment_id)

    def list_exceptions(self, tenant_id: str, status: str | None, category: str | None, limit: int) -> list[dict[str, Any]]:
        safe_limit = min(max(limit, 1), 100)
        conditions = ["tenant_id = %s"]
        values: list[Any] = [tenant_id]
        if status is not None:
            conditions.append("status = %s")
            values.append(status)
        if category is not None:
            conditions.append("category = %s")
            values.append(category)
        values.append(safe_limit)
        with psycopg.connect(self.database_url) as connection, connection.cursor() as cursor:
            cursor.execute(
                f"""
                SELECT exception_id, tenant_id, run_id, item_id, batch_id, category, severity, status,
                       expected_minor, observed_minor, difference_minor, currency, evidence_json, rule_version,
                       reprocessable, created_at, resolved_at, resolution
                FROM exception_cases WHERE {' AND '.join(conditions)}
                ORDER BY created_at DESC, exception_id DESC LIMIT %s
                """,
                values,
            )
            return [_map_exception(row) for row in cursor.fetchall()]
