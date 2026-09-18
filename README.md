# Payment Integrity Control Tower

Plataforma agnóstica de integridade de pagamentos para rastrear eventos, processar estados financeiros, reconciliar settlements, explicar exceções e materializar dados analíticos.

O núcleo não depende da Axxon. Gateways, adquirentes, processadores e bancos devem traduzir seus dados para o contrato canônico de eventos.

## Estado atual

O projeto é um ambiente local de estudo com:

- API Python baseada em FastAPI;
- PostgreSQL como fonte transacional;
- inbox/outbox transacional com idempotência;
- worker Python com retry, lease e DLQ;
- reconciliação de settlements com auditoria;
- lake local em NDJSON/Parquet;
- warehouse local em DuckDB;
- MinIO opcional para objetos analíticos;
- autenticação local por Bearer token e escopos.

## Arquitetura

```text
src/payment_integrity/
├── api/            HTTP, autenticação, modelos e métricas
├── application/    casos de uso e portas
├── domain/         contratos canônicos e regras puras
├── infrastructure/ PostgreSQL e adaptadores externos
├── analytics/      Parquet, MinIO, DuckDB e projeções
└── worker/         outbox, processamento financeiro e retry
```

Fluxo principal:

```text
provedor
  → API
  → domínio canônico
  → event_inbox + event_outbox
  → worker
  → pagamentos, ledger e auditoria
  → Parquet / DuckDB / MinIO
```

PostgreSQL é a fonte de verdade financeira. Parquet, DuckDB e MinIO são derivados e podem ser reconstruídos.

## Requisitos

- Docker Desktop;
- Python 3.12+ para executar testes fora do container;
- Git.

Não é necessário Node.js ou credencial de provedor externo para executar o ambiente local.

## Executar localmente

Na raiz do repositório:

```bash
docker compose -f docker-compose.python.yml up -d --build
```

Serviços:

- API: `http://localhost:4200`;
- PostgreSQL: `localhost:5439`;
- MinIO API: `http://localhost:9100`;
- MinIO Console: `http://localhost:9101`.

Verificar o ambiente:

```bash
curl http://localhost:4200/v1/health/live
curl http://localhost:4200/v1/health/ready
docker compose -f docker-compose.python.yml ps
```

Para parar os containers sem remover volumes:

```bash
docker compose -f docker-compose.python.yml stop
```

Para remover containers, mantendo os dados locais:

```bash
docker compose -f docker-compose.python.yml down
```

## Configuração

Copie `.env.example` para `.env` quando precisar personalizar o ambiente:

```bash
cp .env.example .env
```

Variáveis principais:

- `CONTROL_TOWER_API_TOKEN`: token Bearer local;
- `CONTROL_TOWER_API_TENANT_ID`: tenant do operador local;
- `CONTROL_TOWER_API_SCOPES`: escopos separados por vírgula;
- `ANALYTICS_ENABLED`: ativa ou desativa projeção analítica;
- `MINIO_BUCKET`: bucket usado pelo projector.

`.env`, dumps, arquivos de runtime e dados reais não devem ser commitados.

## Testes

Testes unitários, sem depender do PostgreSQL:

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python -B -m unittest discover -s tests/unit -p 'test_*.py' -v
```

Testes de integração, com o Compose em execução:

```bash
RUN_PYTHON_DB_TESTS=true \
DATABASE_URL=postgresql://integrity:integrity_dev@localhost:5439/payment_integrity \
PYTHONPATH=src \
python -B -m unittest discover -s tests -p 'test_*.py' -v
```

Os testes cobrem validação de eventos, tenant, deduplicação, retry, DLQ, reconciliação, replay, resolução, ledger e projeção analítica.

## Rotas principais

Health e observabilidade:

- `GET /v1/health/live`;
- `GET /v1/health/ready`;
- `GET /v1/metrics`.

Eventos:

- `POST /v1/events`;
- `POST /v1/payments/events`;
- `POST /v1/events/dead-letter/{outbox_id}/replay`.

Consultas:

- `GET /v1/payments/{payment_id}/timeline`;
- `GET /v1/payments/{payment_id}/ledger`;
- `GET /v1/exceptions`.

Reconciliação:

- `POST /v1/settlements/imports`;
- `POST /v1/reconciliation-runs`;
- `POST /v1/exceptions/{exception_id}/resolve`;
- `POST /v1/exceptions/{exception_id}/reprocess`.

As rotas protegidas usam `Authorization: Bearer <CONTROL_TOWER_API_TOKEN>` e escopos `control_tower:read` ou `control_tower:write`.

## Princípios de engenharia

- Valores financeiros são inteiros na menor unidade da moeda;
- o domínio não importa framework ou SDK de provedor;
- integrações externas ficam atrás de portas e adaptadores;
- eventos, comandos e reprocessamentos são idempotentes;
- o ledger é imutável;
- decisões precisam de evidências, regra e auditoria;
- projeções analíticas não podem desfazer transações financeiras;
- cada fase deve ser entregue em commits pequenos e reversíveis.

## Documentação adicional

- [`AGENTS.md`](./AGENTS.md): regras de engenharia e colaboração;
- [`SPEC.md`](./SPEC.md): escopo e contratos de alto nível;
- [`docs/00-planning.md`](./docs/00-planning.md): planejamento e fases;
- [`docs/01-architecture.md`](./docs/01-architecture.md): decisões arquiteturais;
- [`docs/02-flow.md`](./docs/02-flow.md): fluxos ponta a ponta;
- [`LOCAL-EXECUTION.md`](./LOCAL-EXECUTION.md): execução local detalhada.
