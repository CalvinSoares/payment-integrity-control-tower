# Runbook da Fase 1

## Núcleo entregue

- máquina de estados do pagamento;
- valores monetários em unidades menores e inteiros seguros;
- ledger de dupla entrada balanceado por journal;
- chave de idempotência escopada por tenant, ator, operação e chave;
- fingerprint para bloquear reuso com payload diferente;
- auditoria de criação e transição;
- portas de persistência e transação;
- adaptadores em memória para testes determinísticos;
- adaptador PostgreSQL para pagamentos, ledger, idempotência e auditoria;
- runner PostgreSQL com `BEGIN`, `COMMIT`, `ROLLBACK` e liberação segura da conexão;
- migration PostgreSQL com constraints e índices.

## Executar

```bash
npm test
npm run typecheck
docker compose up -d postgres
docker compose exec -T postgres psql -U integrity -d payment_integrity -c "\\dt"
# PowerShell
$env:RUN_DB_TESTS = "1"
npm run test:db
# Bash
RUN_DB_TESTS=1 npm run test:db
```

## Invariantes testadas

- `CREATED → AUTHORIZED → CAPTURED` é aceito;
- salto de `CREATED` para `CAPTURED` é rejeitado;
- journal com débito diferente de crédito é rejeitado;
- journal com moedas diferentes é rejeitado;
- replay com a mesma chave não duplica efeitos;
- mesma chave em outro tenant não colide;
- payload diferente na mesma chave gera conflito;
- falha de validação não altera o pagamento nem o ledger.
- persistência PostgreSQL mantém pagamento, ledger, idempotência e auditoria na mesma operação;
- teste de integração confirma leitura do Postgres depois do commit.

## Limites conhecidos desta fase

O adaptador em memória não simula rollback de banco concorrente. O adaptador PostgreSQL já garante rollback da transação em falha, mas ainda não trata de forma especializada a corrida de duas requisições com a mesma chave de idempotência; esse comportamento deve ser coberto com lock/upsert seguro na próxima etapa.
