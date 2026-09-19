"""Run the provider-agnostic local analytics pipeline."""

from __future__ import annotations

import argparse
import json
from collections import OrderedDict
from pathlib import Path
from typing import Any

from payment_integrity.domain.payment_events import PaymentEvent

from .lake import write_parquet
from .warehouse import build_warehouse


def _normalize(raw_event: dict[str, object]) -> dict[str, object]:
    event = PaymentEvent.from_mapping(raw_event)
    return {**event.to_mapping(), "normalizationVersion": "python-local-v2"}


def curate(input_path: Path, bronze_path: Path, silver_path: Path) -> dict[str, int]:
    """Validate, deduplicate and normalize an NDJSON event stream."""

    bronze_path.parent.mkdir(parents=True, exist_ok=True)
    silver_path.parent.mkdir(parents=True, exist_ok=True)
    raw_lines = input_path.read_text(encoding="utf-8").splitlines()
    non_empty_lines = [line for line in raw_lines if line.strip()]
    bronze_path.write_text("\n".join(non_empty_lines) + ("\n" if non_empty_lines else ""), encoding="utf-8")

    unique: OrderedDict[str, dict[str, object]] = OrderedDict()
    duplicate_count = 0
    for line_number, line in enumerate(raw_lines, start=1):
        if not line.strip():
            continue
        parsed = json.loads(line)
        if not isinstance(parsed, dict):
            raise ValueError(f"linha {line_number}: evento deve ser um objeto")
        normalized = _normalize(parsed)
        event_id = str(normalized["eventId"])
        previous = unique.get(event_id)
        if previous is not None:
            if previous["payloadHash"] != normalized["payloadHash"]:
                raise ValueError(f"linha {line_number}: eventId duplicado com payload diferente: {event_id}")
            duplicate_count += 1
            continue
        unique[event_id] = normalized

    silver_path.write_text(
        "".join(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n" for event in unique.values()),
        encoding="utf-8",
    )
    return {"input": len(non_empty_lines), "unique": len(unique), "duplicates": duplicate_count}


def run(input_path: Path, lake_root: Path, warehouse_path: Path) -> dict[str, Any]:
    """Curate NDJSON and materialize Parquet plus a DuckDB warehouse."""

    bronze_path = lake_root / "bronze" / "payment_events" / "events.ndjson"
    silver_path = lake_root / "silver" / "payment_events" / "events.ndjson"
    parquet_path = lake_root / "silver" / "payment_events" / "events.parquet"
    report = curate(input_path, bronze_path, silver_path)
    write_parquet(silver_path, parquet_path)
    build_warehouse(parquet_path, warehouse_path)
    return {**report, "parquet": str(parquet_path), "warehouse": str(warehouse_path)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--lake-root", type=Path, default=Path("lake"))
    parser.add_argument("--warehouse", type=Path, default=Path("warehouse/payment_integrity.duckdb"))
    args = parser.parse_args()
    print(json.dumps(run(args.input, args.lake_root, args.warehouse), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
