#!/usr/bin/env python3
"""Optional PySpark executor for the canonical event pipeline."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


REQUIRED_COLUMNS = {
    "eventId", "eventType", "schemaVersion", "tenantId", "provider",
    "providerAccountId", "externalPaymentId", "externalEventId",
    "occurredAt", "receivedAt", "traceId", "payloadHash", "data",
}


def run(input_path: Path, output_path: Path, master: str = "local[*]", dry_run: bool = False) -> int:
    try:
        from pyspark.sql import SparkSession
        from pyspark.sql.functions import countDistinct, current_timestamp, col
    except ModuleNotFoundError as error:
        raise RuntimeError("PySpark não está instalado. Use o fallback data_platform/python/run_local_pipeline.py ou instale data_platform/spark/requirements.txt.") from error

    spark = SparkSession.builder.master(master).appName("payment-integrity-events").config(
        "spark.sql.shuffle.partitions", "4"
    ).getOrCreate()
    try:
        events = spark.read.json(str(input_path))
        missing = sorted(REQUIRED_COLUMNS - set(events.columns))
        if missing:
            raise ValueError(f"colunas ausentes no contrato canônico: {', '.join(missing)}")

        conflicts = (
            events.groupBy("eventId")
            .agg(countDistinct("payloadHash").alias("payload_hash_count"))
            .where(col("payload_hash_count") > 1)
            .limit(1)
            .count()
        )
        if conflicts:
            raise ValueError("eventId duplicado com payloadHash diferente")

        curated = events.dropDuplicates(["eventId"]).withColumn("processedAt", current_timestamp())
        count = curated.count()
        if dry_run:
            return count
        curated.write.mode("overwrite").partitionBy("tenantId").parquet(str(output_path))
        return count
    finally:
        spark.stop()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--master", default="local[*]")
    parser.add_argument("--dry-run", action="store_true", help="executa leitura e deduplicação sem gravar no filesystem Hadoop")
    args = parser.parse_args()
    try:
        count = run(args.input, args.output, args.master, args.dry_run)
    except (RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2
    action = "spark_dry_run" if args.dry_run else "spark_parquet_written"
    print(f"{action}={args.output};unique_events={count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
