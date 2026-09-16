# Runbook da Fase 2

## Núcleo entregue

- envelope canônico versionado para eventos de pagamento;
- hash SHA-256 dos dados canônicos;
- deduplicação por provedor, conta e identificador externo;
- inbox com estados `RECEIVED`, `PROCESSING`, `APPLIED` e `REJECTED`;
- outbox com estados `PENDING`, `PROCESSING`, `PUBLISHED` e `FAILED`;
- ingestão transacional de inbox + outbox;
- worker local com tratamento de sucesso e falha;
- claim PostgreSQL com `FOR UPDATE SKIP LOCKED`;
- adaptador de simulador e contrato de adaptador Axxon sem SDK no domínio.

## Executar

```bash
npm test
npm run typecheck
docker compose up -d postgres
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U integrity -d payment_integrity -f /docker-entrypoint-initdb.d/003_phase2_events.sql
```

Para integração PostgreSQL:

```bash
# Bash
RUN_DB_TESTS=1 npm run test:db

# PowerShell
$env:RUN_DB_TESTS = "1"
npm run test:db
```

## Fluxo operacional

1. O adaptador recebe o payload do provedor e o transforma em `PaymentEvent`.
2. O contrato valida versão, datas, moeda, valor, IDs e `payloadHash`.
3. A ingestão procura a chave `(provider, providerAccountId, externalEventId)`.
4. Evento repetido com o mesmo hash retorna `REPLAYED` sem criar nova mensagem.
5. Evento novo grava inbox e outbox na mesma transação.
6. O worker reserva uma mensagem, marca `PROCESSING`, executa o handler e grava o resultado.
7. Falha do handler vira `REJECTED`/`FAILED` com erro operacional persistido.

## Limites conhecidos

- O worker local marca `PUBLISHED` ao concluir o handler; um publisher externo real ainda será adicionado quando houver necessidade de fila.
- Mensagens `FAILED` ainda não têm backoff e retry automático; isso entra na Fase 5.
- O handler recebe ports de eventos. A composição transacional com o `PaymentCoreService` será unificada quando o caso de uso de ingestão passar a produzir efeitos financeiros diretamente.
- O adaptador Axxon usa um DTO local intencionalmente pequeno; o mapeamento de webhook real deve ser validado com contrato de integração antes de produção.
