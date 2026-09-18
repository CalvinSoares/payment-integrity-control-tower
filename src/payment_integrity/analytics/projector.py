"""Derived analytics projection for applied payment events."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from threading import Lock

from payment_integrity.domain.payment_events import PaymentEvent

logger = logging.getLogger("payment-integrity.analytics")


class EventAnalyticsProjector:
    """Materialize applied events into local lake, Parquet, DuckDB and MinIO."""

    _lock = Lock()

    def __init__(
        self,
        lake_root: str | Path,
        warehouse_path: str | Path,
        minio_endpoint: str | None = None,
        minio_access_key: str = "minioadmin",
        minio_secret_key: str = "minioadmin_dev",
        minio_bucket: str = "payment-integrity",
        minio_object_name: str = "silver/payment_events/events.parquet",
    ) -> None:
        self.lake_root = Path(lake_root)
        self.warehouse_path = Path(warehouse_path)
        self.minio_endpoint = minio_endpoint
        self.minio_access_key = minio_access_key
        self.minio_secret_key = minio_secret_key
        self.minio_bucket = minio_bucket
        self.minio_object_name = minio_object_name

    def project(self, event: PaymentEvent) -> bool:
        event_mapping = event.to_mapping()
        normalized = {**event_mapping, "normalizationVersion": "python-local-v1"}
        bronze_path = self.lake_root / "bronze" / "payment_events" / "events.ndjson"
        silver_path = self.lake_root / "silver" / "payment_events" / "events.ndjson"
        parquet_path = self.lake_root / "silver" / "payment_events" / "events.parquet"
        with self._lock:
            if self._contains_event(silver_path, event.event_id):
                return False
            bronze_path.parent.mkdir(parents=True, exist_ok=True)
            silver_path.parent.mkdir(parents=True, exist_ok=True)
            with bronze_path.open("a", encoding="utf-8") as bronze, silver_path.open("a", encoding="utf-8") as silver:
                bronze.write(json.dumps(event_mapping, ensure_ascii=False, separators=(",", ":")) + "\n")
                silver.write(json.dumps(normalized, ensure_ascii=False, separators=(",", ":")) + "\n")

            from data_platform.lake.ingest_to_lake import write_parquet
            from data_platform.warehouse.build_warehouse import build_warehouse

            write_parquet(silver_path, parquet_path)
            build_warehouse(parquet_path, self.warehouse_path)
            if self.minio_endpoint:
                from data_platform.lake.ingest_to_lake import upload_to_minio

                upload_to_minio(parquet_path, self.minio_endpoint, self.minio_access_key, self.minio_secret_key, self.minio_bucket, self.minio_object_name)
            logger.info("analytics_projection_applied event_id=%s parquet=%s", event.event_id, parquet_path)
            return True

    @staticmethod
    def _contains_event(path: Path, event_id: str) -> bool:
        if not path.exists():
            return False
        with path.open(encoding="utf-8") as stream:
            return any(json.loads(line).get("eventId") == event_id for line in stream if line.strip())
