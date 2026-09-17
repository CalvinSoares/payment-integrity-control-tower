#!/usr/bin/env python3
"""Upload an existing lake object to MinIO."""

from __future__ import annotations

import argparse
from pathlib import Path

from minio import Minio


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", type=Path, required=True)
    parser.add_argument("--minio-endpoint", default="localhost:9100")
    parser.add_argument("--access-key", default="minioadmin")
    parser.add_argument("--secret-key", default="minioadmin_dev")
    parser.add_argument("--bucket", default="payment-integrity")
    parser.add_argument("--object-name", required=True)
    args = parser.parse_args()

    client = Minio(args.minio_endpoint, access_key=args.access_key, secret_key=args.secret_key, secure=False)
    client.fput_object(args.bucket, args.object_name, str(args.file), content_type="application/vnd.apache.parquet")
    print(f"minio_uploaded={args.bucket}/{args.object_name};bytes={args.file.stat().st_size}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
