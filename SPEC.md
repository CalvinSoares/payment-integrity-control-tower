# SPEC.md — especificação inicial

## Objetivo

Responder, para cada pagamento e repasse: o que aconteceu, quando aconteceu, qual valor deveria existir, qual valor foi observado, onde surgiu a diferença e qual ação é segura.

## Escopo do MVP

- transação e máquina de estados;
- eventos canônicos versionados;
- ledger de dupla entrada;
- idempotência e deduplicação;
- ingestão de pelo menos um fluxo de API/webhook e um arquivo de liquidação simulado;
- matching e classificação de divergências;
- exceção operacional com evidências;
- consulta por transação, lote, provedor e período;
- auditoria e métricas essenciais.

## Fora do primeiro corte

- processamento real de PAN/CVV;
- decisão autônoma de crédito/antifraude;
- dezenas de microserviços;
- Kafka/CDC/Airflow/Spark obrigatórios para rodar localmente;
- movimentação bancária real sem aprovação e integração certificada;
- apagar ou alterar lançamentos financeiros históricos.

## Termos canônicos

- `Payment`: intenção e ciclo de vida do pagamento.
- `PaymentEvent`: fato observado em uma fonte externa ou interna.
- `Settlement`: lote/arquivo/retorno que informa liquidação.
- `LedgerEntry`: lançamento imutável de débito ou crédito.
- `ReconciliationRun`: execução reproduzível de conciliação.
- `ReconciliationItem`: resultado de matching ou exceção.
- `ExceptionCase`: unidade operacional de investigação e resolução.
- `ProviderAccount`: configuração isolada de um participante externo.

## Invariantes

1. A soma dos lançamentos de uma transação balanceia por moeda e livro.
2. O mesmo evento não produz dois efeitos financeiros.
3. Um evento tardio não apaga uma evidência anterior; ele cria nova versão/observação.
4. Um pagamento não pode saltar para um estado inválido.
5. Toda divergência tem tipo, severidade, valor em risco, evidência e status.
6. Uma tentativa de reprocessamento produz o mesmo resultado lógico quando a entrada não mudou.

## Critério de sucesso

Dado um cenário autorizado de R$ 100,00, capturado por R$ 100,00, liquidado por R$ 98,00 e repassado por R$ 95,00, o sistema deve explicar os R$ 5,00 como taxas/ajustes conforme a política configurada, ou abrir exceção se os lançamentos não fecharem.

## Política de entrega e versionamento

O desenvolvimento será incremental por fase. Cada unidade de trabalho deve ser salva em um commit separado e específico; uma fase não deve ser condensada em um único commit genérico.

Para cada tarefa concluída, a entrega deve incluir:

1. arquivos alterados e motivo;
2. testes executados;
3. comando `git add --` com caminhos explícitos;
4. `git diff --cached --check`;
5. comando `git commit -m` com mensagem específica;
6. indicação clara de arquivos deixados fora por serem de outra tarefa.

Sequência preferencial de commits dentro de uma fase:

```text
contrato/documentação → domínio → persistência/migration → caso de uso → adaptador → testes → integração
```

Essa sequência pode ser ajustada quando a dependência técnica exigir, mas cada commit deve continuar compilável ou explicar explicitamente por que depende do próximo.
