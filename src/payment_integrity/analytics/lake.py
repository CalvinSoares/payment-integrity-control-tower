"""Local lake and object-storage adapters for analytics projections."""

from __future__ import annotations

from pathlib import Path

import duckdb


def write_parquet(input_path: Path, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    connection = duckdb.connect()
    try:
        connection.execute(
            "CREATE TABLE normalized_events AS SELECT * FROM read_json_auto(?, format='newline_delimited')",
            [str(input_path)],
        )
        output_literal = str(output_path).replace("'", "''")
        connection.execute(f"COPY normalized_events TO '{output_literal}' (FORMAT PARQUET, COMPRESSION ZSTD)")
    finally:
        connection.close()


def upload_to_minio(path: Path, endpoint: str, access_key: str, secret_key: str, bucket: str, object_name: str) -> None:
    from minio import Minio

    client = Minio(endpoint, access_key=access_key, secret_key=secret_key, secure=False)
    if not client.bucket_exists(bucket):
        client.make_bucket(bucket)
    client.fput_object(bucket, object_name, str(path), content_type="application/vnd.apache.parquet")
