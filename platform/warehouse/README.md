# Warehouse local

O warehouse usa DuckDB como fallback local, persistido em um arquivo `.duckdb`.
Ele recebe Parquet do lake e cria a tabela `payment_events` e a view
`tenant_event_summary`.

```bash
python platform/warehouse/build_warehouse.py \
  --parquet lake/silver/payment_events/events.parquet
python platform/warehouse/query_warehouse.py
```

Em uma futura implantação, a mesma modelagem pode ser carregada em ClickHouse,
BigQuery ou Snowflake sem mudar o contrato canônico.
