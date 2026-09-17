# API Python

A API oficial do Control Tower é FastAPI. TypeScript permanece somente no
frontend/mobile; o módulo Java é um experimento legado e não participa do
runtime principal.

Subir localmente:

```bash
python -m pip install -r data_platform/python/requirements.txt
docker compose up -d postgres
python -m data_platform.python.api.run_api
```

Endpoints:

- `GET /v1/health/live`: processo ativo;
- `GET /v1/health/ready`: API conectada ao PostgreSQL;
- `POST /v1/events`: ingestão autenticada com `Bearer local-dev-token`.

O `POST /v1/events` grava inbox, outbox e auditoria em uma única transação.
Repetições do mesmo evento retornam `REPLAYED` e não criam uma nova auditoria.
