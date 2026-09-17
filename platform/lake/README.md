# Lake local

Suba o MinIO com:

```bash
docker compose -f docker-compose.data.yml up -d minio minio-init
```

O console fica em `http://localhost:9101` com `minioadmin` / `minioadmin_dev`.
O bucket `payment-integrity` é criado automaticamente.

Para gerar Parquet a partir do NDJSON normalizado:

```bash
python -m pip install -r platform/python/requirements.txt
python platform/lake/ingest_to_lake.py \
  --input curated.ndjson \
  --output lake/silver/payment_events/events.parquet \
  --minio-endpoint localhost:9100
```

Sem `--minio-endpoint`, o mesmo comando funciona como fallback offline e grava
somente o Parquet local.
