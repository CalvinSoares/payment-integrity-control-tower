#!/usr/bin/env python3
"""Convert normalized NDJSON to Parquet and optionally upload it to MinIO."""

from __future__ import annotations

import argparse
from pathlib import Path

import duckdb


def write_parquet(input_path: Path, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    connection = duckdb.connect()
    try:
        connection.execute(
            "CREATE TABLE normalized_events AS "
            "SELECT * FROM read_json_auto(?, format='newline_delimited')",
            [str(input_path)],
        )
        output_literal = str(output_path).replace("'", "''")
        connection.execute(
            f"COPY normalized_events TO '{output_literal}' (FORMAT PARQUET, COMPRESSION ZSTD)"
        )
    finally:
        connection.close()


def upload_to_minio(path: Path, endpoint: str, access_key: str, secret_key: str, bucket: str, object_name: str) -> None:
    from minio import Minio

    client = Minio(endpoint, access_key=access_key, secret_key=secret_key, secure=False)
    if not client.bucket_exists(bucket):
        client.make_bucket(bucket)
    client.fput_object(bucket, object_name, str(path), content_type="application/vnd.apache.parquet")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--minio-endpoint")
    parser.add_argument("--minio-access-key", default="minioadmin")
    parser.add_argument("--minio-secret-key", default="minioadmin_dev")
    parser.add_argument("--bucket", default="payment-integrity")
    parser.add_argument("--object-name", default="silver/payment_events/events.parquet")
    args = parser.parse_args()

    write_parquet(args.input, args.output)
    print(f"parquet_written={args.output}")
    if args.minio_endpoint:
        upload_to_minio(args.output, args.minio_endpoint, args.minio_access_key, args.minio_secret_key, args.bucket, args.object_name)
        print(f"minio_uploaded={args.bucket}/{args.object_name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
