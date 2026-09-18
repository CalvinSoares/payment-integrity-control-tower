"""Native PostgreSQL settlement and reconciliation adapter."""

from __future__ import annotations

from datetime import datetime
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from payment_integrity.domain.settlements import SettlementError, SettlementNotFound, parse_settlement_csv


SEVERITY = {
    "MISSING_PAYMENT": "HIGH",
    "AMOUNT_MISMATCH": "HIGH",
    "DUPLICATE_SETTLEMENT": "HIGH",
    "FEE_MISMATCH": "MEDIUM",
    "SETTLEMENT_DELAYED": "MEDIUM",
}


def _evidence(batch_id: str, row: dict[str, Any], payment: tuple[Any, ...] | None) -> list[str]:
    return [f"settlement:{batch_id}:{row['rowNumber']}", f"settlement-record:{row['settlementId']}", *([] if payment is None else [f"payment:{payment[0]}"])]


def _map_run(row: tuple[Any, ...]) -> dict[str, Any]:
    return {
        "runId": row[0], "tenantId": row[1], "batchId": row[2], "ruleVersion": row[3], "idempotencyKey": row[4],
        "status": row[5], "createdAt": row[6].isoformat(), "completedAt": row[7].isoformat(), "itemCount": row[8], "exceptionCount": row[9],
    }


def _map_item(row: tuple[Any, ...]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "itemId": row[0], "runId": row[1], "batchId": row[2], "rowNumber": row[3], "settlementId": row[4],
        "externalPaymentId": row[5], "status": row[7], "currency": str(row[13]).strip(), "evidence": row[14], "ruleVersion": row[15],
    }
    if row[6] is not None:
        result["paymentId"] = row[6]
    if row[8] is not None:
        result["category"] = row[8]
    if row[9] is not None:
        result["severity"] = row[9]
    for key, index in (("expectedMinor", 10), ("observedMinor", 11), ("differenceMinor", 12)):
        if row[index] is not None:
            result[key] = int(row[index])
    return result


def _map_exception(row: tuple[Any, ...]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "exceptionId": row[0], "tenantId": row[1], "runId": row[2], "itemId": row[3], "batchId": row[4],
        "category": row[5], "severity": row[6], "status": row[7], "currency": str(row[11]).strip(), "evidence": row[12],
        "ruleVersion": row[13], "reprocessable": row[14], "createdAt": row[15].isoformat(),
    }
    for key, index in (("expectedMinor", 8), ("observedMinor", 9), ("differenceMinor", 10)):
        if row[index] is not None:
            result[key] = int(row[index])
    if row[16] is not None:
        result["resolvedAt"] = row[16].isoformat()
    if row[17] is not None:
        result["resolution"] = row[17]
    return result


class PostgresSettlementService:
    """Persist settlement imports and reconciliation runs in PostgreSQL."""

    def __init__(self, database_url: str, actor_id: str = "system:settlement") -> None:
        self.database_url = database_url
        self.actor_id = actor_id

    def receive_csv(self, **input_data: str) -> dict[str, Any]:
        batch = parse_settlement_csv(**input_data)
        rows = [row.to_mapping() for row in batch.rows]
        with psycopg.connect(self.database_url) as connection, connection.transaction(), connection.cursor() as cursor:
            cursor.execute("SELECT rows_json FROM settlement_batches WHERE file_key = %s", (batch.file_key,))
            existing = cursor.fetchone()
            if existing is not None:
                return {"status": "REPLAYED", "batchId": batch.batch_id, "rowCount": len(existing[0])}
            cursor.execute(
                """
                INSERT INTO settlement_batches
                  (batch_id, tenant_id, provider, provider_account_id, file_name, file_checksum, file_key,
                   period_start, period_end, received_at, rows_json, row_count)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                (batch.batch_id, batch.tenant_id, batch.provider, batch.provider_account_id, batch.file_name, batch.file_checksum,
                 batch.file_key, batch.period_start, batch.period_end, batch.received_at, Jsonb(rows), len(rows)),
            )
        return {"status": "RECEIVED", "batchId": batch.batch_id, "rowCount": len(rows)}

    def reconcile(self, batch_id: str, tenant_id: str, rule_version: str, idempotency_key: str, requested_at: str) -> dict[str, Any]:
        with psycopg.connect(self.database_url) as connection, connection.transaction(), connection.cursor() as cursor:
            cursor.execute(
                "SELECT run_id, tenant_id, batch_id, rule_version, idempotency_key, status, created_at, completed_at, item_count, exception_count FROM reconciliation_runs WHERE batch_id=%s AND rule_version=%s AND idempotency_key=%s",
                (batch_id, rule_version, idempotency_key),
            )
            existing = cursor.fetchone()
            if existing is not None:
                return self._result_for_run(cursor, existing)
            cursor.execute("SELECT tenant_id, rows_json FROM settlement_batches WHERE batch_id=%s", (batch_id,))
            batch_row = cursor.fetchone()
            if batch_row is None or batch_row[0] != tenant_id:
                raise SettlementNotFound("Lote de settlement não encontrado.")
            run_id = f"recon:{batch_id}:{rule_version}:{idempotency_key}"
            cursor.execute(
                "INSERT INTO reconciliation_runs (run_id,tenant_id,batch_id,rule_version,idempotency_key,status,created_at,completed_at,item_count,exception_count) VALUES (%s,%s,%s,%s,%s,'COMPLETED',%s,%s,0,0)",
                (run_id, tenant_id, batch_id, rule_version, idempotency_key, requested_at, requested_at),
            )
            items: list[dict[str, Any]] = []
            exceptions: list[dict[str, Any]] = []
            seen_settlements: set[str] = set()
            seen_payments: set[str] = set()
            for row in batch_row[1]:
                cursor.execute("SELECT id, amount_minor, currency, updated_at FROM payments WHERE tenant_id=%s AND external_payment_id=%s", (tenant_id, row["externalPaymentId"]))
                payment = cursor.fetchone()
                issues: list[dict[str, Any]] = []
                if row["settlementId"] in seen_settlements or row["externalPaymentId"] in seen_payments:
                    issues.append({"category": "DUPLICATE_SETTLEMENT", "observedMinor": row["grossAmountMinor"], "differenceMinor": 0})
                seen_settlements.add(row["settlementId"])
                seen_payments.add(row["externalPaymentId"])
                if payment is None and not issues:
                    issues.append({"category": "MISSING_PAYMENT", "observedMinor": row["grossAmountMinor"]})
                if payment is not None and not issues:
                    if int(payment[1]) != row["grossAmountMinor"]:
                        issues.append({"category": "AMOUNT_MISMATCH", "expectedMinor": int(payment[1]), "observedMinor": row["grossAmountMinor"], "differenceMinor": row["grossAmountMinor"] - int(payment[1])})
                    if row["netAmountMinor"] + row["feeAmountMinor"] != row["grossAmountMinor"]:
                        observed = row["netAmountMinor"] + row["feeAmountMinor"]
                        issues.append({"category": "FEE_MISMATCH", "expectedMinor": row["grossAmountMinor"], "observedMinor": observed, "differenceMinor": observed - row["grossAmountMinor"]})
                    settled = datetime.fromisoformat(row["settledAt"])
                    updated = payment[3] if hasattr(payment[3], "tzinfo") else datetime.fromisoformat(str(payment[3]))
                    if (settled - updated).total_seconds() > 48 * 60 * 60:
                        issues.append({"category": "SETTLEMENT_DELAYED", "differenceMinor": 0})
                evidence = _evidence(batch_id, row, payment)
                for issue in issues or [{"category": None}]:
                    category = issue["category"]
                    item_id = f"{run_id}:{row['rowNumber']}:{category or 'MATCHED'}"
                    item: dict[str, Any] = {
                        "itemId": item_id, "runId": run_id, "batchId": batch_id, "rowNumber": row["rowNumber"], "settlementId": row["settlementId"],
                        "externalPaymentId": row["externalPaymentId"], "status": "EXCEPTION" if category else "MATCHED", "currency": row["currency"], "evidence": evidence, "ruleVersion": rule_version,
                    }
                    if payment is not None:
                        item["paymentId"] = payment[0]
                    if category is not None:
                        item.update({"category": category, "severity": SEVERITY[category], **{key: value for key, value in issue.items() if key != "category"}})
                    cursor.execute(
                        "INSERT INTO reconciliation_items (item_id,run_id,batch_id,row_number,settlement_id,external_payment_id,payment_id,status,category,severity,expected_minor,observed_minor,difference_minor,currency,evidence_json,rule_version) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                        (item_id, run_id, batch_id, row["rowNumber"], row["settlementId"], row["externalPaymentId"], item.get("paymentId"), item["status"], category, item.get("severity"), item.get("expectedMinor"), item.get("observedMinor"), item.get("differenceMinor"), row["currency"], Jsonb(evidence), rule_version),
                    )
                    items.append(item)
                    if category is not None:
                        exception: dict[str, Any] = {"exceptionId": f"exception:{item_id}", "tenantId": tenant_id, "runId": run_id, "itemId": item_id, "batchId": batch_id, "category": category, "severity": SEVERITY[category], "status": "OPEN", "currency": row["currency"], "evidence": evidence, "ruleVersion": rule_version, "reprocessable": True, "createdAt": requested_at, **{key: value for key, value in issue.items() if key != "category"}}
                        cursor.execute(
                            "INSERT INTO exception_cases (exception_id,tenant_id,run_id,item_id,batch_id,category,severity,status,expected_minor,observed_minor,difference_minor,currency,evidence_json,rule_version,reprocessable,created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,'OPEN',%s,%s,%s,%s,%s,%s,%s,%s)",
                            (exception["exceptionId"], tenant_id, run_id, item_id, batch_id, category, SEVERITY[category], exception.get("expectedMinor"), exception.get("observedMinor"), exception.get("differenceMinor"), row["currency"], Jsonb(evidence), rule_version, True, requested_at),
                        )
                        exceptions.append(exception)
            status = "EXCEPTION" if exceptions else "COMPLETED"
            cursor.execute("UPDATE reconciliation_runs SET status=%s, completed_at=%s, item_count=%s, exception_count=%s WHERE run_id=%s", (status, requested_at, len(items), len(exceptions), run_id))
            run = {"runId": run_id, "tenantId": tenant_id, "batchId": batch_id, "ruleVersion": rule_version, "idempotencyKey": idempotency_key, "status": status, "createdAt": requested_at, "completedAt": requested_at, "itemCount": len(items), "exceptionCount": len(exceptions)}
            return {"run": run, "items": items, "exceptions": exceptions}

    def _result_for_run(self, cursor: psycopg.Cursor[Any], run: tuple[Any, ...]) -> dict[str, Any]:
        cursor.execute("SELECT item_id,run_id,batch_id,row_number,settlement_id,external_payment_id,payment_id,status,category,severity,expected_minor,observed_minor,difference_minor,currency,evidence_json,rule_version FROM reconciliation_items WHERE run_id=%s ORDER BY row_number,item_id", (run[0],))
        items = [_map_item(row) for row in cursor.fetchall()]
        cursor.execute("SELECT exception_id,tenant_id,run_id,item_id,batch_id,category,severity,status,expected_minor,observed_minor,difference_minor,currency,evidence_json,rule_version,reprocessable,created_at,resolved_at,resolution FROM exception_cases WHERE run_id=%s ORDER BY exception_id", (run[0],))
        return {"run": _map_run(run), "items": items, "exceptions": [_map_exception(row) for row in cursor.fetchall()]}

    def resolve_exception(self, exception_id: str, tenant_id: str, actor_id: str, reason: str, evidence: list[str], resolved_at: str) -> dict[str, Any]:
        if not reason.strip() or not evidence:
            raise SettlementError("reason e evidence são obrigatórios.")
        with psycopg.connect(self.database_url) as connection, connection.transaction(), connection.cursor() as cursor:
            cursor.execute("SELECT tenant_id,status,category FROM exception_cases WHERE exception_id=%s FOR UPDATE", (exception_id,))
            row = cursor.fetchone()
            if row is None or row[0] != tenant_id:
                raise SettlementNotFound("Exceção não encontrada.")
            if row[1] != "RESOLVED":
                cursor.execute("UPDATE exception_cases SET status='RESOLVED', resolved_at=%s, resolution=%s WHERE exception_id=%s", (resolved_at, f"{reason} | evidências: {', '.join(evidence)}", exception_id))
                cursor.execute("INSERT INTO audit_events (audit_id,tenant_id,actor_id,action,entity_type,entity_id,occurred_at,metadata) VALUES (%s,%s,%s,'EXCEPTION_RESOLVED','ExceptionCase',%s,%s,%s)", (f"audit:exception-resolve:{exception_id}:{resolved_at}", tenant_id, actor_id, exception_id, resolved_at, Jsonb({"reason": reason, "evidence": evidence, "category": row[2]})))
            cursor.execute("SELECT exception_id,tenant_id,run_id,item_id,batch_id,category,severity,status,expected_minor,observed_minor,difference_minor,currency,evidence_json,rule_version,reprocessable,created_at,resolved_at,resolution FROM exception_cases WHERE exception_id=%s", (exception_id,))
            return _map_exception(cursor.fetchone())

    def reprocess_exception(self, exception_id: str, tenant_id: str, actor_id: str, requested_at: str) -> dict[str, Any]:
        with psycopg.connect(self.database_url) as connection, connection.transaction(), connection.cursor() as cursor:
            cursor.execute("SELECT exception_id, tenant_id, batch_id, item_id, category, rule_version, status, reprocessable FROM exception_cases WHERE exception_id=%s FOR UPDATE", (exception_id,))
            exception = cursor.fetchone()
            if exception is None or exception[1] != tenant_id:
                raise SettlementNotFound("Exceção não encontrada.")
            if not exception[7]:
                raise SettlementError("Exceção não pode ser reprocessada.")
            cursor.execute("UPDATE exception_cases SET status='REPROCESSING' WHERE exception_id=%s", (exception_id,))
        try:
            result = self.reconcile(exception[2], tenant_id, exception[5], f"reprocess:{exception_id}:{requested_at}", requested_at)
            location = ":".join(str(exception[3]).split(":")[-2:])
            remains_open = any(current.get("category") == exception[4] and str(current.get("itemId", "")).endswith(f":{location}") for current in result["exceptions"])
            with psycopg.connect(self.database_url) as connection, connection.transaction(), connection.cursor() as cursor:
                cursor.execute("UPDATE exception_cases SET status=%s, resolved_at=%s, resolution=%s WHERE exception_id=%s", ("OPEN" if remains_open else "RESOLVED", None if remains_open else requested_at, None if remains_open else f"Reprocessado por {actor_id}.", exception_id))
                cursor.execute("INSERT INTO audit_events (audit_id, tenant_id, actor_id, action, entity_type, entity_id, occurred_at, metadata) VALUES (%s,%s,%s,'EXCEPTION_REPROCESSED','ExceptionCase',%s,%s,%s) ON CONFLICT (audit_id) DO NOTHING", (f"audit:exception-reprocess:{exception_id}:{requested_at}", tenant_id, actor_id, exception_id, requested_at, Jsonb({"newRunId": result["run"]["runId"], "resolved": not remains_open, "category": exception[4]})))
            return {**result, "resolved": not remains_open}
        except Exception:
            with psycopg.connect(self.database_url) as connection, connection.transaction(), connection.cursor() as cursor:
                cursor.execute("UPDATE exception_cases SET status='OPEN' WHERE exception_id=%s AND status='REPROCESSING'", (exception_id,))
            raise
