# Fases executáveis do MVP

## Fase 0 — Fundação

**Entrega:** repositório, ADRs, glossário, Docker Compose local, PostgreSQL, configuração por ambiente, CI e fixtures.

**Aceite:** qualquer pessoa consegue subir o núcleo e rodar um cenário determinístico sem credenciais externas.

## Fase 1 — Domínio e ledger

**Entrega:** estados, comandos, contas contábeis, lançamentos, idempotência, auditoria, ports assíncronos, repositories PostgreSQL, transação real e testes de invariantes.

**Aceite:** autorização/captura/estorno/reembolso produzem lançamentos balanceados, replay não altera o saldo e falha de uma etapa faz rollback das escritas PostgreSQL.

## Fase 2 — Eventos e adaptadores

**Entrega:** envelope, inbox, outbox, worker local, simulador e contrato de adaptador Axxon.

**Aceite:** o mesmo caso pode ser alimentado pelo simulador ou por um adaptador real sem mudar o domínio.

## Fase 3 — Settlement e conciliação

**Entrega:** upload/ingestão de arquivo, validação, lotes, matching, tolerâncias, exceções e reprocessamento.

**Aceite:** detectar ausência, duplicidade, valor divergente, taxa incorreta e atraso com evidência reproduzível.

## Fase 4 — API e control tower

**Entrega:** timeline, busca por IDs, visão financeira, exceções, filtros por provedor, ações com autorização e exportação.

**Aceite:** operador explica uma divergência sem consultar manualmente todos os sistemas externos.

## Fase 5 — Operação resiliente

**Entrega:** DLQ, backoff, replay, métricas, tracing, alertas, health/readiness, retenção e runbooks.

**Aceite:** falha de consumidor ou provedor não perde eventos e a retomada é verificável.

## Fase 6 — Escala e produção

**Entrega:** Kafka/CDC quando necessário, object storage, jobs distribuídos, particionamento, testes de carga, DR e controles LGPD.

**Aceite:** SLOs medidos, custo conhecido, recuperação testada e adaptadores certificados.

## Sequenciamento técnico recomendado

1. Modelar invariantes antes da API.
2. Implementar ledger antes do dashboard.
3. Implementar simulador antes do conector Axxon.
4. Implementar conciliação com arquivos pequenos antes do data lake.
5. Medir volume/latência antes de adotar Kafka, CDC ou Spark.
