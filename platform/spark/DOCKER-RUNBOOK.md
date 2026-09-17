# Spark em Linux/Docker

O compose usa a imagem oficial Apache Spark para evitar o requisito `winutils`
do Windows. O diretório do projeto é montado em `/workspace` e o output gold é
gravado no lake local.

Pré-requisito: silver NDJSON em
`lake/silver/payment_events/events.ndjson`.

```bash
docker compose -f docker-compose.data.yml -f docker-compose.spark.yml run --rm spark-runner
python platform/lake/upload_object.py \
  --file lake/gold/payment_events_spark/part-00000-*.parquet \
  --minio-endpoint localhost:9100 \
  --object-name gold/payment_events_spark/events.parquet
```

Em Git Bash, se o glob não for expandido por causa do nome gerado pelo Spark,
use o caminho do arquivo retornado por `find`:

```bash
SPARK_FILE=$(find lake/gold/payment_events_spark -name '*.parquet' | head -n 1)
python platform/lake/upload_object.py \
  --file "$SPARK_FILE" \
  --object-name gold/payment_events_spark/events.parquet
```

O `spark-runner` é uma execução batch descartável; estado, evidências e dados
curados permanecem no lake/warehouse, não no container.
