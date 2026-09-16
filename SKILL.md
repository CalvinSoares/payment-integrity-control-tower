# SKILL.md

Este projeto deve ser capaz de executar seis capacidades principais:

## 1. Ingestão agnóstica

Receber webhook, API, polling, arquivo de liquidação ou lançamento interno e convertê-los para eventos canônicos sem perder o payload original, o provedor, os identificadores externos e o horário de ocorrência.

## 2. Rastreamento de ciclo de vida

Reconstruir a linha do tempo de uma transação e validar transições permitidas entre autorização, captura, estorno, chargeback, liquidação e repasse.

## 3. Integridade financeira

Registrar cada movimento em ledger de dupla entrada, separar principal, taxa, reserva, chargeback e repasse e calcular a diferença por moeda e participante.

## 4. Conciliação

Comparar a verdade interna com respostas de provedores e arquivos externos, classificando correspondências, divergências, ausências, duplicidades e atrasos.

## 5. Operação e resolução

Exibir exceções com evidências, permitir investigação, reprocessar entradas com segurança e registrar aprovação, ajuste ou encerramento.

## 6. Observabilidade e governança

Correlacionar transação, evento, lançamento, job e exceção por `traceId`; medir latência, atraso de liquidação, valor em risco e saúde dos adaptadores.

## Capacidades opcionais por estágio

- fila simples/worker local antes de Kafka;
- MinIO local antes de S3;
- DuckDB/Parquet antes de Spark/Redshift;
- scheduler/worker do próprio backend antes de Airflow;
- regras determinísticas antes de antifraude estatístico.

Esses fallbacks preservam as portas do domínio e permitem trocar infraestrutura sem reescrever as regras financeiras.
