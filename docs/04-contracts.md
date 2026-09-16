# Contratos iniciais

## Envelope de evento

```json
{
  "eventId": "evt_01J...",
  "eventType": "payment.captured",
  "schemaVersion": 1,
  "provider": "axxon",
  "providerAccountId": "account_123",
  "externalPaymentId": "prov_pay_123",
  "externalEventId": "prov_evt_456",
  "occurredAt": "2026-09-15T12:00:00Z",
  "receivedAt": "2026-09-15T12:00:03Z",
  "traceId": "trace_123",
  "payloadHash": "sha256:...",
  "data": {}
}
```

`eventId` identifica a entrada interna; `externalEventId` identifica o fato na origem. A deduplicação deve considerar provedor, conta e identificador externo, com fallback documentado quando a origem não fornece ID.

Na implementação atual, a chave é serializada como JSON para evitar colisões quando um identificador contém `:`. O envelope validado usa `schemaVersion: 1` e `payloadHash` SHA-256 calculado sobre `data` com propriedades ordenadas.

## Chaves e idempotência

- comandos: chave enviada pelo cliente ou gerada no início da ação;
- eventos: chave do fato externo;
- arquivos: provedor + nome + checksum + período;
- conciliação: run + lote + versão da regra;
- ajustes: comando único com aprovação e motivo.

Persistir status `RECEIVED`, `PROCESSING`, `APPLIED`, `REJECTED` ou `REPLAYED`. O replay deve devolver o resultado original quando disponível.

O fluxo de entrega local usa outbox com `PENDING`, `PROCESSING`, `PUBLISHED` e `FAILED`. O claim PostgreSQL usa `FOR UPDATE SKIP LOCKED`; retry com backoff e DLQ ficam para a fase de robustez.

## Ledger

Cada transação financeira deve gerar pelo menos duas linhas:

```text
Débito  conta_de_liquidacao       10000 centavos
Crédito obrigacao_do_lojista      10000 centavos

Débito  obrigacao_do_lojista       500 centavos
Crédito receita_de_taxa            500 centavos
```

Campos mínimos: `journalId`, `accountId`, `direction`, `amountMinor`, `currency`, `referenceType`, `referenceId`, `effectiveAt`, `sourceEventId` e `createdAt`.

## Estados mínimos

```text
CREATED -> AUTHORIZED -> CAPTURED -> SETTLED -> PAID_OUT
    |          |            |          |
  CANCELED   VOIDED      REFUNDED   CHARGEBACK
```

Transições e estados adicionais devem ser versionados conforme o domínio, sem transformar status do provedor diretamente em regra financeira.

## Resultado de conciliação

```json
{
  "status": "EXCEPTION",
  "category": "AMOUNT_MISMATCH",
  "severity": "HIGH",
  "expectedMinor": 10000,
  "observedMinor": 9800,
  "differenceMinor": -200,
  "currency": "BRL",
  "evidence": ["payment:pay_123", "settlement:stl_456"],
  "ruleVersion": "settlement-match.v1",
  "reprocessable": true
}
```

## API de alto nível

- `POST /payments/events`: receber evento canônico/adaptado;
- `POST /settlements/imports`: iniciar importação de arquivo;
- `POST /reconciliation-runs`: executar uma conciliação;
- `GET /payments/:id/timeline`: consultar linha do tempo;
- `GET /payments/:id/ledger`: consultar lançamentos;
- `GET /exceptions`: listar e filtrar exceções;
- `POST /exceptions/:id/reprocess`: reprocessar com idempotência;
- `POST /exceptions/:id/resolve`: resolver com ator, motivo e evidência.

Todas as mutações exigem autenticação, autorização por tenant e idempotência. APIs externas nunca devem receber credenciais ou payloads específicos dentro do núcleo.
