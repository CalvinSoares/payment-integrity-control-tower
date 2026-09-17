# Orquestração Airflow

O DAG `payment_integrity_pipeline` executa o mesmo runner Python usado no
desenvolvimento local. Isso mantém um único comportamento entre o fallback CLI
e o scheduler, evitando uma implementação paralela das regras.

Variáveis do ambiente do worker Airflow:

- `CONTROL_TOWER_ROOT`: raiz montada do projeto;
- `CONTROL_TOWER_INPUT`: NDJSON de eventos recebidos;
- `CONTROL_TOWER_LAKE_ROOT`: diretório bronze/silver/gold;
- `CONTROL_TOWER_WAREHOUSE`: arquivo DuckDB persistido.

O Airflow ainda não é obrigatório para rodar localmente. A execução equivalente
é:

```bash
python platform/python/run_local_pipeline.py \
  --input events.ndjson \
  --lake-root lake \
  --warehouse warehouse/payment_integrity.duckdb
```
