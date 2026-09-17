# Executor PySpark opcional

O job Spark usa o mesmo contrato e o mesmo NDJSON silver do pipeline Python.
Ele deduplica por `eventId`, bloqueia o mesmo ID com hashes diferentes e grava
Parquet particionado por `tenantId`.

```bash
python -m pip install -r platform/spark/requirements.txt
python platform/spark/payment_events_job.py \
  --input lake/silver/payment_events/events.ndjson \
  --output lake/gold/payment_events_spark
```

No Windows, a gravação do filesystem local do Spark exige `winutils.exe` e
`HADOOP_HOME`. Para validar leitura, schema, conflito de hash e deduplicação
sem essa configuração, use:

```bash
python platform/spark/payment_events_job.py \
  --input lake/silver/payment_events/events.ndjson \
  --output lake/gold/payment_events_spark \
  --dry-run
```

Para gravar Parquet com Spark no Windows, configure Hadoop local ou execute o
job em Linux/WSL/Docker. O pipeline Python/DuckDB continua sendo o fallback
completo para desenvolvimento local sem Hadoop.

PySpark não é obrigatório no ambiente local. Para datasets pequenos, use:

```bash
python platform/python/run_local_pipeline.py \
  --input events.ndjson \
  --lake-root lake \
  --warehouse warehouse/payment_integrity.duckdb
```

O fallback evita o custo de uma JVM Spark e mantém o mesmo contrato de entrada.
