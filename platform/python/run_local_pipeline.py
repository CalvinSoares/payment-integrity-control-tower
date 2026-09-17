#!/usr/bin/env python3
"""Run the local bronze -> silver -> Parquet -> DuckDB pipeline."""

from __future__ import annotations

import argparse
import json
from collections import OrderedDict
from pathlib import Path
from typing import Any

from normalize_events import normalize, validate_event

import sys

PLATFORM_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLATFORM_ROOT / "lake"))
sys.path.insert(0, str(PLATFORM_ROOT / "warehouse"))
from build_warehouse import build_warehouse  # noqa: E402
from ingest_to_lake import write_parquet  # noqa: E402


def curate(input_path: Path, bronze_path: Path, silver_path: Path) -> dict[str, int]:
    bronze_path.parent.mkdir(parents=True, exist_ok=True)
    silver_path.parent.mkdir(parents=True, exist_ok=True)
    raw_lines = input_path.read_text(encoding="utf-8").splitlines()
    bronze_path.write_text("\n".join(line for line in raw_lines if line.strip()) + "\n", encoding="utf-8")

    unique: OrderedDict[str, dict[str, Any]] = OrderedDict()
    duplicate_count = 0
    for line_number, line in enumerate(raw_lines, start=1):
        if not line.strip():
            continue
        event = json.loads(line)
        if not isinstance(event, dict):
            raise ValueError(f"linha {line_number}: evento deve ser um objeto")
        errors = validate_event(event)
        if errors:
            raise ValueError(f"linha {line_number}: {'; '.join(errors)}")
        event_id = event["eventId"]
        previous = unique.get(event_id)
        if previous:
            if previous["payloadHash"] != event["payloadHash"]:
                raise ValueError(f"linha {line_number}: eventId duplicado com payload diferente: {event_id}")
            duplicate_count += 1
            continue
        unique[event_id] = normalize(event)

    silver_path.write_text(
        "".join(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n" for event in unique.values()),
        encoding="utf-8",
    )
    return {"input": len([line for line in raw_lines if line.strip()]), "unique": len(unique), "duplicates": duplicate_count}


def run(input_path: Path, lake_root: Path, warehouse_path: Path) -> dict[str, Any]:
    bronze_path = lake_root / "bronze" / "payment_events" / "events.ndjson"
    silver_path = lake_root / "silver" / "payment_events" / "events.ndjson"
    parquet_path = lake_root / "silver" / "payment_events" / "events.parquet"
    report = curate(input_path, bronze_path, silver_path)
    write_parquet(silver_path, parquet_path)
    build_warehouse(parquet_path, warehouse_path)
    return {**report, "parquet": str(parquet_path), "warehouse": str(warehouse_path)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--lake-root", type=Path, default=Path("lake"))
    parser.add_argument("--warehouse", type=Path, default=Path("warehouse/payment_integrity.duckdb"))
    args = parser.parse_args()
    print(json.dumps(run(args.input, args.lake_root, args.warehouse), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
