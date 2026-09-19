from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import duckdb

from payment_integrity.analytics.local_pipeline import run
from payment_integrity.domain.payment_events import payload_hash


class LocalPipelineTests(unittest.TestCase):
    def test_deduplicates_events_and_builds_warehouse(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = {"amountMinor": 1000, "currency": "BRL", "externalPaymentId": "external_pipeline", "paymentId": "pay_pipeline"}
            event = {
                "eventId": "evt:pipeline:001", "eventType": "payment.captured", "schemaVersion": 1,
                "tenantId": "tenant_pipeline", "provider": "simulator", "providerAccountId": "account_pipeline",
                "externalPaymentId": "external_pipeline", "externalEventId": "external_evt_pipeline",
                "occurredAt": "2026-09-17T20:00:00Z", "receivedAt": "2026-09-17T20:00:01Z",
                "traceId": "trace:pipeline", "payloadHash": payload_hash(data), "data": data,
            }
            input_path = root / "events.ndjson"
            input_path.write_text(json.dumps(event) + "\n" + json.dumps(event) + "\n", encoding="utf-8")

            report = run(input_path, root / "lake", root / "warehouse" / "payment_integrity.duckdb")

            self.assertEqual(report["input"], 2)
            self.assertEqual(report["unique"], 1)
            self.assertEqual(report["duplicates"], 1)
            self.assertTrue(Path(report["parquet"]).exists())
            self.assertTrue(Path(report["warehouse"]).exists())
            with duckdb.connect(report["warehouse"], read_only=True) as connection:
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM payment_events").fetchone(), (1,))


if __name__ == "__main__":
    unittest.main()
