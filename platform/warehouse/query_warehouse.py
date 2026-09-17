#!/usr/bin/env python3
"""Print the tenant summary from the local DuckDB warehouse."""

from __future__ import annotations

import argparse
from pathlib import Path

import duckdb


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=Path, default=Path("warehouse/payment_integrity.duckdb"))
    args = parser.parse_args()
    connection = duckdb.connect(str(args.database), read_only=True)
    try:
        for row in connection.execute("SELECT * FROM tenant_event_summary").fetchall():
            print("|".join(str(value) for value in row))
    finally:
        connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
