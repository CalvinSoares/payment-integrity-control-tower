from __future__ import annotations

import os
import unittest
from datetime import datetime, timezone
from uuid import uuid4

from payment_integrity.infrastructure.postgres_settlement import PostgresSettlementService


@unittest.skipUnless(os.getenv("RUN_PYTHON_DB_TESTS") == "true", "RUN_PYTHON_DB_TESTS=true required")
class PostgresSettlementIntegrationTests(unittest.TestCase):
    database_url = os.getenv("DATABASE_URL", "postgresql://integrity:integrity_dev@localhost:5438/payment_integrity")

    def test_import_reconcile_replay_reprocess_and_resolve(self) -> None:
        service = PostgresSettlementService(self.database_url)
        suffix = str(uuid4())
        content = (
            "settlement_id,external_payment_id,settled_at,gross_amount_minor,fee_amount_minor,net_amount_minor,currency\n"
            f"settlement:{suffix},missing:{suffix},2026-09-18T00:00:00Z,1000,20,980,BRL\n"
        )
        input_data = {
            "tenant_id": "tenant_native_settlement_test",
            "provider": "simulator",
            "provider_account_id": f"account:{suffix}",
            "file_name": f"settlement-{suffix}.csv",
            "period_start": "2026-09-17T00:00:00Z",
            "period_end": "2026-09-18T00:00:00Z",
            "received_at": datetime.now(timezone.utc).isoformat(),
            "content": content,
        }

        received = service.receive_csv(**input_data)
        replayed_file = service.receive_csv(**input_data)
        result = service.reconcile(
            batch_id=str(received["batchId"]),
            tenant_id="tenant_native_settlement_test",
            rule_version="rules-v1",
            idempotency_key=f"run:{suffix}",
            requested_at=datetime.now(timezone.utc).isoformat(),
        )
        replayed_run = service.reconcile(
            batch_id=str(received["batchId"]),
            tenant_id="tenant_native_settlement_test",
            rule_version="rules-v1",
            idempotency_key=f"run:{suffix}",
            requested_at=datetime.now(timezone.utc).isoformat(),
        )
        exception_id = str(result["exceptions"][0]["exceptionId"])
        reprocessed = service.reprocess_exception(
            exception_id=exception_id,
            tenant_id="tenant_native_settlement_test",
            actor_id="test",
            requested_at=datetime.now(timezone.utc).isoformat(),
        )
        resolved = service.resolve_exception(
            exception_id=exception_id,
            tenant_id="tenant_native_settlement_test",
            actor_id="test",
            reason="validado manualmente",
            evidence=["evidence:test"],
            resolved_at=datetime.now(timezone.utc).isoformat(),
        )

        self.assertEqual(received["status"], "RECEIVED")
        self.assertEqual(replayed_file["status"], "REPLAYED")
        self.assertEqual(result["run"]["status"], "EXCEPTION")
        self.assertEqual(result["exceptions"][0]["category"], "MISSING_PAYMENT")
        self.assertEqual(replayed_run["run"]["runId"], result["run"]["runId"])
        self.assertFalse(reprocessed["resolved"])
        self.assertEqual(resolved["status"], "RESOLVED")


if __name__ == "__main__":
    unittest.main()
