from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import duckdb

from .analytics_projection import EventAnalyticsProjector
from .api.test_api import valid_event
from .api.models import PaymentEvent


class AnalyticsProjectionTest(unittest.TestCase):
    def test_projects_event_idempotently_to_parquet_and_duckdb(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            event = PaymentEvent.model_validate(valid_event())
            projector = EventAnalyticsProjector(root / "lake", root / "warehouse" / "payment_integrity.duckdb")
            self.assertTrue(projector.project(event))
            self.assertFalse(projector.project(event))
            with duckdb.connect(str(root / "warehouse" / "payment_integrity.duckdb")) as connection:
                row = connection.execute("SELECT event_id, tenant_id FROM payment_events").fetchone()
            self.assertEqual(row, (event.eventId, event.tenantId))
