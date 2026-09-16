# Arquitetura agnóstica

## Camadas

### Domínio

Entidades e regras puras: `Payment`, `PaymentEvent`, `Settlement`, `LedgerEntry`, `ReconciliationItem` e `ExceptionCase`. O domínio conhece moeda, estados, partidas dobradas, matching e políticas, mas não conhece HTTP, Prisma, Kafka ou Axxon.

### Aplicação

Casos de uso: registrar pagamento, aplicar evento, importar settlement, executar conciliação, abrir exceção, reprocessar, aprovar ajuste e consultar timeline.

### Portas

Interfaces para repositórios, relógio, idempotência, publicação, armazenamento de arquivos, notificações e conectores de provedores.

### Adaptadores

REST/gRPC, webhooks, SFTP/CSV, PostgreSQL, fila local/Kafka, MinIO/S3, Axxon, Stripe, Adyen, Pagar.me ou qualquer outro provedor. Cada adaptador mapeia para o contrato canônico e preserva o payload bruto.

## Modelo de implantação por estágio

| Estágio | Componentes padrão | Fallback local |
| --- | --- | --- |
| Núcleo | PostgreSQL + API | PostgreSQL local/container |
| Eventos | Outbox + Kafka | Outbox + worker em processo |
| Arquivos | S3 + Parquet | MinIO ou filesystem isolado |
| Transformação | Spark/Airflow | jobs idempotentes + DuckDB |
| Consultas | projeções CQRS | tabelas de leitura no PostgreSQL |
| Observabilidade | OpenTelemetry + Prometheus | logs estruturados + métricas HTTP |

## Axxon como adaptador

O adaptador Axxon deve implementar portas como:

- `PaymentSourceConnector` para consultar ou receber fatos;
- `SettlementSourceConnector` para lotes/arquivos;
- `ProviderStatusMapper` para mapear estados;
- `FeeMapper` para taxas e ajustes;
- `ProviderIdentityResolver` para ligar IDs externos ao pagamento interno.

O núcleo recebe `ProviderEvent` canônico com `provider = axxon`, mas não contém `if (provider === "axxon")`. Diferenças de contrato ficam no adaptador e na configuração versionada.

## Fonte da verdade

- o pagamento e o ledger são transacionais;
- o evento bruto é evidência imutável;
- projeções e dashboards podem ser reconstruídos;
- uma conciliação pode ser executada novamente sem duplicar lançamentos;
- ajustes manuais são novos fatos auditados, nunca edição silenciosa.

## Segurança mínima

Autenticação de operador, autorização por tenant/workspace, segregação entre consulta e ação financeira, mascaramento de dados, criptografia de segredos, assinatura/verificação de webhook e trilha de auditoria com ator, motivo e correlação.
