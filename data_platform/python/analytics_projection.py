from __future__ import annotations

import json
import logging
from pathlib import Path
from threading import Lock

from .api.models import PaymentEvent
from .normalize_events import normalize

logger = logging.getLogger("payment-integrity.analytics")


class EventAnalyticsProjector:
    """Materializa eventos aplicados em NDJSON, Parquet, DuckDB e opcionalmente MinIO."""

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
        normalized = normalize(event.model_dump(mode="json"))
        bronze_path = self.lake_root / "bronze" / "payment_events" / "events.ndjson"
        silver_path = self.lake_root / "silver" / "payment_events" / "events.ndjson"
        parquet_path = self.lake_root / "silver" / "payment_events" / "events.parquet"
        with self._lock:
            if self._contains_event(silver_path, event.eventId):
                return False
            bronze_path.parent.mkdir(parents=True, exist_ok=True)
            silver_path.parent.mkdir(parents=True, exist_ok=True)
            with bronze_path.open("a", encoding="utf-8") as bronze, silver_path.open("a", encoding="utf-8") as silver:
                bronze.write(json.dumps(event.model_dump(mode="json"), ensure_ascii=False, separators=(",", ":")) + "\n")
                silver.write(json.dumps(normalized, ensure_ascii=False, separators=(",", ":")) + "\n")
            from ..lake.ingest_to_lake import write_parquet
            from ..warehouse.build_warehouse import build_warehouse

            write_parquet(silver_path, parquet_path)
            build_warehouse(parquet_path, self.warehouse_path)
            if self.minio_endpoint:
                from ..lake.ingest_to_lake import upload_to_minio

                upload_to_minio(
                    parquet_path,
                    self.minio_endpoint,
                    self.minio_access_key,
                    self.minio_secret_key,
                    self.minio_bucket,
                    self.minio_object_name,
                )
            logger.info("analytics_projection_applied event_id=%s parquet=%s", event.eventId, parquet_path)
            return True

    @staticmethod
    def _contains_event(path: Path, event_id: str) -> bool:
        if not path.exists():
            return False
        with path.open(encoding="utf-8") as stream:
            for line in stream:
                if not line.strip():
                    continue
                if json.loads(line).get("eventId") == event_id:
                    return True
        return False
