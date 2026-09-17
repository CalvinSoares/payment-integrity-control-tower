# Runbook da Fase 4

## API entregue

- `POST /payments/events`: recebe evento canônico autenticado;
- `POST /settlements/imports`: recebe CSV carregado no request;
- `POST /reconciliation-runs`: executa conciliação por lote;
- `GET /payments/:id/timeline`: combina pagamento, eventos, ledger, auditoria, itens e exceções;
- `GET /payments/:id/ledger`: consulta journals do pagamento;
- `GET /exceptions`: lista exceções do tenant com filtros e limite;
- `POST /exceptions/:id/reprocess`: cria novo run de reprocessamento;
- `POST /exceptions/:id/resolve`: resolve com motivo, evidências e auditoria.

## Autenticação e autorização

Todas as rotas exigem:

```http
Authorization: Bearer <CONTROL_TOWER_API_TOKEN>
```

O principal local é configurado por `CONTROL_TOWER_API_TENANT_ID` e `CONTROL_TOWER_API_ACTOR_ID`. Rotas `GET` exigem `control_tower:read`; mutações exigem `control_tower:write`. Em produção, `CONTROL_TOWER_API_TOKEN` é obrigatório; o token estático local é apenas fallback de desenvolvimento/teste.

## Executar

```bash
docker compose up -d postgres
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U integrity -d payment_integrity -f /docker-entrypoint-initdb.d/004_phase3_settlement.sql
npm run api
```

Servidor padrão: `http://localhost:4100`.

Exemplo de consulta:

```bash
curl -H "Authorization: Bearer local-dev-token" http://localhost:4100/exceptions
```

## Limites de segurança atuais

- corpo máximo padrão de 2 MiB;
- respostas são JSON;
- filtros de exceção são limitados a 100 registros;
- tenant do evento é comparado com o principal autenticado;
- queries de pagamento, ledger e exceções são tenant-scoped;
- erros internos não retornam detalhes SQL ao cliente.

## Limites conhecidos

- O endpoint de importação recebe o conteúdo CSV em JSON; multipart, object storage e streaming ficam para uma evolução posterior.
- O token local é um autenticador mínimo para o Control Tower agnóstico. A integração com Clerk, OAuth/OIDC ou um gateway corporativo deve implementar a mesma interface `Authenticator` antes de produção.
- Rate limit, métricas HTTP, tracing e health/readiness ficam na Fase 5.
