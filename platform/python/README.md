# Jobs Python locais

`normalize_events.py` é o fallback local do pipeline analítico. Não exige
Airflow, Spark, banco ou pacote externo: lê eventos canônicos em NDJSON pelo
stdin, valida o contrato e emite eventos normalizados pelo stdout.

```bash
python platform/python/normalize_events.py < events.ndjson > curated.ndjson
python -m unittest discover -s platform/python -p 'test_*.py'
```

O job será reutilizado por um DAG Airflow e por um executor PySpark nas fases
seguintes. O contrato compartilhado está em
`platform/contracts/payment-event.v1.schema.json`.
