# Payment Integrity Control Tower

Plataforma agnóstica para rastrear a jornada financeira e operacional de pagamentos, da autorização ao repasse, explicar divergências e reduzir perdas.

O projeto pode ser conectado à Axxon, mas o núcleo não conhece Axxon. Cada adquirente, gateway, banco, bandeira ou processador entra por um adaptador que traduz seus dados para o contrato canônico.

## Documentos

- [`AGENTS.md`](./AGENTS.md): regras de colaboração e engenharia.
- [`SKILL.md`](./SKILL.md): capacidades e modo de execução do projeto.
- [`SPEC.md`](./SPEC.md): escopo funcional e contratos de alto nível.
- [`docs/00-planning.md`](./docs/00-planning.md): objetivo, riscos e fases.
- [`docs/01-architecture.md`](./docs/01-architecture.md): arquitetura modular e decisões de infraestrutura.
- [`docs/02-flow.md`](./docs/02-flow.md): fluxo ponta a ponta e fluxos de exceção.
- [`docs/03-mvp-phases.md`](./docs/03-mvp-phases.md): entregas incrementais do MVP.
- [`docs/04-contracts.md`](./docs/04-contracts.md): eventos, idempotência, ledger e APIs.

## Princípio inicial

Começar como um monólito modular com portas e adaptadores, PostgreSQL como fonte transacional, outbox transacional e uma fila substituível. Kafka, CDC, Airflow e Spark entram quando volume, latência ou reprocessamento justificarem a complexidade.

O objetivo do MVP não é acumular tecnologias: é provar rastreabilidade por transação, precisão por centavo, idempotência, reconciliação reproduzível e auditoria.

## Fase 0 local

Requisitos: Node.js 20+ e Docker Desktop. O PostgreSQL é usado somente quando necessário; os cenários de fundação rodam sem banco ou credenciais externas.

```bash
npm install
npm run fixtures
npm test
docker compose up -d postgres
```

Configuração: copie `.env.example` para `.env`. O arquivo `.env` não deve ser commitado.
