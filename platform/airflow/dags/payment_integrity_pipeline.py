"""Airflow orchestration for the same local Python pipeline."""

from datetime import datetime
from pathlib import Path
import os
import sys

from airflow.decorators import dag, task


@dag(
    dag_id="payment_integrity_pipeline",
    schedule="@hourly",
    start_date=datetime(2026, 1, 1),
    catchup=False,
    tags=["payment-integrity", "local"],
)
def payment_integrity_pipeline():
    @task
    def run_pipeline():
        project_root = Path(os.environ.get("CONTROL_TOWER_ROOT", "/opt/airflow/project"))
        sys.path.insert(0, str(project_root / "platform" / "python"))
        from run_local_pipeline import run

        input_path = Path(os.environ.get("CONTROL_TOWER_INPUT", project_root / "data" / "events.ndjson"))
        lake_root = Path(os.environ.get("CONTROL_TOWER_LAKE_ROOT", project_root / "lake"))
        warehouse = Path(os.environ.get("CONTROL_TOWER_WAREHOUSE", project_root / "warehouse" / "payment_integrity.duckdb"))
        return run(input_path, lake_root, warehouse)

    run_pipeline()


payment_integrity_pipeline()
