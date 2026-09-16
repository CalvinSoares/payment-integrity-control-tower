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
- migration PostgreSQL com constraints e índices.

## Executar

```bash
npm test
npm run typecheck
docker compose up -d postgres
docker compose exec -T postgres psql -U integrity -d payment_integrity -c "\\dt"
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

## Limites conhecidos desta fase

O adaptador em memória não simula rollback de banco concorrente. A garantia transacional de produção depende de implementar `TransactionRunner` com uma transação real do PostgreSQL. O próximo trabalho deve adicionar o repositório PostgreSQL e testes de integração contra o container.
