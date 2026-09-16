# Planejamento inicial

## Visão

O Control Tower será uma camada de integridade entre sistemas de pagamento. Ele não substitui uma adquirente nem presume que o participante seja Axxon. Ele observa fatos de várias fontes, normaliza contratos, calcula a verdade financeira interna, compara com a realidade externa e oferece explicação operacional.

## Status da Fase 0

Concluída. A fundação inclui cenário runner, fixtures agnósticas, contrato mínimo de participantes/eventos, dependências instaladas, testes/typecheck passando e PostgreSQL local saudável com a migration inicial aplicada.

## Status da Fase 1

Implementada localmente. O núcleo financeiro possui ports assíncronos, runner transacional PostgreSQL, repositories para pagamentos, ledger, idempotência e auditoria, além de testes unitários e de integração com commit e rollback verificados. A concorrência da mesma chave de idempotência ainda será endurecida na Fase 2.

## Status da Fase 2

Implementada localmente. O contrato canônico, inbox/outbox, worker local, simulador e adaptador Axxon foram adicionados com deduplicação, hash de payload, falha persistida e claim concorrente no PostgreSQL. Retry com backoff e integração financeira dentro da mesma transação ficam para as fases de robustez e ingestão de negócio.

## Regra de commits por tarefa

Todas as fases serão entregues em commits pequenos. Ao terminar cada tarefa, o próximo retorno deve trazer o comando exato para salvar apenas os arquivos daquela tarefa:

```bash
git add -- <arquivos-da-tarefa>
git diff --cached --check
git commit -m "<mensagem-específica>"
```

Não usar `git add .`, não agrupar a fase inteira e não incluir alterações de outra tarefa. Se houver hunks misturados no mesmo arquivo, usar `git add -p`.

## Problema que resolve

Uma transação pode ser autorizada, capturada, liquidada e repassada por sistemas diferentes. Cada etapa pode usar IDs, horários, taxas, lotes e regras distintas. Sem uma linha do tempo e um ledger próprios, uma divergência vira uma investigação manual sem resposta confiável.

## Decisão de arquitetura inicial

Construir um monólito modular com arquitetura hexagonal:

- núcleo de domínio independente;
- PostgreSQL como fonte da verdade transacional;
- outbox no mesmo commit da alteração de negócio;
- worker/fila substituível;
- adaptadores para Axxon, simulador e futuros provedores;
- API de consulta separada conceitualmente dos comandos;
- pipeline analítico somente depois de o modelo financeiro estar provado.

## Por que não iniciar com a arquitetura inteira do texto

Kafka, Debezium, Airflow, Spark, S3 e Redshift resolvem escala e operação reais, mas adicionam contratos, deploy, observabilidade e pontos de falha antes de o domínio estar validado. O MVP deve permitir trocar a fila local por Kafka e o storage local por S3 sem alterar casos de uso.

## Fases

### Fase 0 — Fundação e cenários

Definir vocabulário, participantes, moedas, políticas, fixtures e critérios de sucesso. Criar cenários bons e ruins: duplicidade, evento fora de ordem, arquivo atrasado, taxa divergente e timeout.

### Fase 1 — Núcleo financeiro

Implementar pagamento, estados, ledger de dupla entrada, idempotência, transação de banco e auditoria. Nenhuma integração externa ainda é necessária: usar comandos e fixtures.

### Fase 2 — Contrato de eventos e ingestão

Criar envelope versionado, inbox/deduplicação, outbox, worker local e um adaptador de simulador. Axxon deve ser apenas o primeiro adaptador opcional, não uma dependência do domínio.

### Fase 3 — Liquidação e conciliação

Ingerir arquivos e retornos de liquidação, validar schema, criar lotes, fazer matching em camadas e abrir exceções com cálculo de valor em risco.

### Fase 4 — Operação e consulta

Entregar API e dashboard de timeline, status, ledger, divergências, filtros, evidências, reprocessamento e ações aprovadas.

### Fase 5 — Robustez e escala

Adicionar contratos de parceiro, DLQ, backoff, replay por partição, métricas, tracing, alertas, object storage, Kafka/CDC e pipeline analítico conforme evidência de necessidade.

### Fase 6 — Produção e governança

Hardening, segregação de funções, retenção, LGPD, gestão de chaves, disaster recovery, SLOs, runbooks, certificação de adaptadores e testes de carga.

## Riscos principais

- confundir evento observado com verdade financeira;
- usar valor decimal ou arredondamento inconsistente;
- permitir replay com efeito duplicado;
- esconder divergência por sobrescrever estado;
- acoplar o modelo à resposta de Axxon;
- liberar ação automática sem aprovação;
- adotar infraestrutura distribuída antes de medir necessidade.
