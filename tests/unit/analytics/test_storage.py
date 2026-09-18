from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import duckdb

from payment_integrity.analytics.lake import write_parquet
from payment_integrity.analytics.warehouse import build_warehouse


class AnalyticsStorageTests(unittest.TestCase):
    def test_builds_parquet_and_duckdb_warehouse(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = root / "events.ndjson"
            parquet = root / "events.parquet"
            database = root / "warehouse.duckdb"
            source.write_text(
                '{"eventId":"evt_1","eventType":"payment.captured","schemaVersion":1,"tenantId":"tenant_1","provider":"simulator","providerAccountId":"account_1","externalPaymentId":"ext_1","externalEventId":"external_1","occurredAt":"2026-09-18T10:00:00+00:00","receivedAt":"2026-09-18T10:00:01+00:00","traceId":"trace_1","payloadHash":"sha256:test","data":{"paymentId":"pay_1"},"normalizationVersion":"python-local-v1"}\n',
                encoding="utf-8",
            )

            write_parquet(source, parquet)
            build_warehouse(parquet, database)

            with duckdb.connect(str(database), read_only=True) as connection:
                row = connection.execute("SELECT event_id, tenant_id, event_type FROM payment_events").fetchone()

            self.assertEqual(row, ("evt_1", "tenant_1", "payment.captured"))


if __name__ == "__main__":
    unittest.main()
