# Runbook da Fase 3

## Núcleo entregue

- parser CSV estrito para settlement;
- checksum SHA-256 e chave de deduplicação de arquivo;
- lote canônico com período, provedor, conta e linhas normalizadas;
- matching contra pagamentos por `tenantId + externalPaymentId`;
- validação de valor bruto, taxa líquida e atraso de settlement;
- itens `MATCHED` ou `EXCEPTION` com evidências;
- exceções com categoria, severidade, valor em risco, regra e status;
- reprocessamento idempotente de uma exceção;
- persistência PostgreSQL de lotes, runs, itens e exceções.

## Formato inicial suportado

O primeiro corte usa CSV com cabeçalho obrigatório e valores monetários em centavos:

```text
settlement_id,external_payment_id,settled_at,gross_amount_minor,fee_amount_minor,net_amount_minor,currency
settle-001,provider-pay-001,2026-01-11T10:00:00Z,10000,200,9800,BRL
```

Decimais como `100.00` são rejeitados para evitar ambiguidade de arredondamento.

## Executar

```bash
npm test
npm run typecheck
docker compose up -d postgres
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U integrity -d payment_integrity -f /docker-entrypoint-initdb.d/004_phase3_settlement.sql
```

Integração com PostgreSQL:

```bash
# Bash
RUN_DB_TESTS=1 npm run test:db

# PowerShell
$env:RUN_DB_TESTS = "1"
npm run test:db
```

## Categorias produzidas

- `MISSING_PAYMENT`: settlement sem pagamento conhecido no tenant;
- `DUPLICATE_SETTLEMENT`: settlement ou pagamento externo repetido no lote;
- `AMOUNT_MISMATCH`: bruto observado diferente do pagamento;
- `FEE_MISMATCH`: líquido + taxa não fecha o bruto;
- `SETTLEMENT_DELAYED`: liquidação mais de 48 horas após a última atualização do pagamento.

Cada exceção preserva evidências do lote, linha, registro externo e pagamento quando encontrado.

## Reprocessamento

O primeiro run não é sobrescrito. O reprocessamento cria outro run com nova chave, mantém o histórico e marca a exceção original como `RESOLVED` apenas quando a mesma divergência não aparece novamente. Se persistir, ela volta para `OPEN`.

## Limites conhecidos

- O upload HTTP e armazenamento de arquivos ainda serão expostos na Fase 4; o caso de uso atual recebe o conteúdo já carregado.
- O matching atual usa `externalPaymentId` e regras determinísticas; tolerâncias configuráveis por provedor entram na evolução da conciliação.
- A transição automática de `CAPTURED` para `SETTLED` ainda exige um caso de uso explícito e trilha de auditoria.
