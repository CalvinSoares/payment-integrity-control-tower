# Plataforma de dados local

Esta pasta contém a evolução Python do Control Tower. TypeScript fica no
frontend/mobile; a API oficial desta pasta é FastAPI.

## Serviços

- `python/api/`: API FastAPI, PostgreSQL, idempotência e auditoria.
- `python/`: normalização e validação de eventos sem serviço externo.
- `lake/`: conversão para Parquet e upload opcional ao MinIO.
- `warehouse/`: tabelas e views analíticas em DuckDB.
- `spark/`: executor PySpark opcional para datasets maiores.
- `contracts/`: schemas canônicos compartilhados entre linguagens.

## Execução local

```bash
docker compose up -d postgres
docker compose -f docker-compose.data.yml up -d minio minio-init

python -m pip install -r data_platform/python/requirements.txt
python -m unittest data_platform.python.api.test_api -v
```

A API Python usa `postgresql://integrity:integrity_dev@localhost:5438/payment_integrity`
por padrão e escuta em `http://localhost:4200`. O MinIO deste projeto usa `localhost:9100`
para S3 e `localhost:9101` para o console, pois a porta 9000 já pode estar
ocupada por outro projeto local.

Para executar o teste Python contra o PostgreSQL real:

```bash
RUN_PYTHON_DB_TESTS=true python -B -m unittest data_platform.python.api.test_store -v
```
