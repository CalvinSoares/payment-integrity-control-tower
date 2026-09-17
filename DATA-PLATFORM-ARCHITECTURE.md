# Arquitetura da plataforma de integridade

## Direção

O Control Tower terá um núcleo transacional em Java e uma camada analítica em Python, com execução local reproduzível. A plataforma continua agnóstica a adquirentes e gateways; Axxon entra somente por adaptador.

## Stack local

- Java 21 + Spring Boot: API, ingestão, idempotência, auditoria e regras transacionais.
- PostgreSQL: fonte transacional para pagamentos, eventos, ledger, conciliação e exceções.
- Python: jobs de qualidade, normalização analítica e regras exploratórias.
- PySpark: processamento distribuído opcional; no local, o mesmo contrato deve funcionar em modo single-node.
- MinIO: data lake S3-compatible local para payloads originais e arquivos de settlement.
- Parquet: formato de dados brutos e curados no lake.
- DuckDB: warehouse local para consultas analíticas e validação dos datasets.
- Airflow: orquestração de ingestões, conciliação, qualidade, curadoria e backfills.

## Fallbacks obrigatórios

Cada componente pesado precisa de um fallback local:

| Capacidade | Padrão alvo | Fallback local |
|---|---|---|
| API transacional | Java/Spring Boot | Java puro com adapters de teste |
| Mensageria | Kafka | outbox PostgreSQL + worker |
| Object storage | S3 | MinIO; arquivos locais apenas em testes unitários |
| Processamento | Spark | Python + DuckDB/Polars em datasets pequenos |
| Orquestração | Airflow | CLI Python com jobs sequenciais |
| Warehouse | BigQuery/Snowflake/ClickHouse | DuckDB sobre Parquet |

## Fluxo

1. O adaptador recebe webhook, API ou arquivo de um provedor.
2. O serviço Java valida envelope, tenant, idempotência e hash.
3. O PostgreSQL grava evento, inbox e outbox na mesma transação.
4. O worker publica o evento e registra retry/DLQ.
5. O DAG do Airflow coleta eventos e arquivos aprovados para o lake.
6. Python/PySpark normaliza e particiona dados em bronze, silver e gold.
7. DuckDB consulta as camadas curadas e calcula indicadores.
8. O serviço de conciliação grava divergências operacionais no PostgreSQL.
9. O painel consulta a API Java; nenhum dashboard lê o lake diretamente para ações transacionais.

## Ordem de implementação

1. Contratos e modelo de dados compartilhados.
2. Serviço Java equivalente ao núcleo atual e testes de contrato.
3. Ambiente local com PostgreSQL, MinIO e DuckDB.
4. Jobs Python de ingestão, qualidade e curadoria sem Spark.
5. DAGs Airflow para executar os jobs localmente.
6. Runner PySpark compatível com os mesmos contratos.
7. Migração gradual da API TypeScript e desligamento somente após paridade comprovada.

## Critério de paridade

O serviço Java só substitui o núcleo TypeScript quando passar os mesmos cenários de idempotência, eventos duplicados/fora de ordem, ledger balanceado, retry, DLQ, replay, conciliação e isolamento por tenant.
