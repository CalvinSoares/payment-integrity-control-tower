# Runbook da Fase 0

## 1. Preparar ambiente

```bash
cp .env.example .env
npm install
```

No PowerShell, use `Copy-Item .env.example .env` no lugar de `cp`.

## 2. Rodar cenários sem banco

```bash
npm run fixtures
npm test
npm run typecheck
```

O runner deve produzir seis resultados `PASS`: ciclo íntegro, evento duplicado, evento fora de ordem, valor divergente, liquidação atrasada e timeout do provedor.

## 3. Subir PostgreSQL local

```bash
docker compose up -d postgres
docker compose ps
```

Conexão padrão: `postgresql://integrity:integrity_dev@localhost:5438/payment_integrity`.

O banco da Fase 0 só cria `app_metadata`. Ledger, outbox e tabelas de negócio entram na Fase 1 para não congelar um modelo prematuro.

## 4. Critérios de aceite

- cenário runner funciona sem Axxon e sem rede externa;
- TypeScript e testes passam;
- PostgreSQL inicia com healthcheck `healthy`;
- `.env` fica ignorado pelo Git;
- todas as fixtures usam valores inteiros em centavos;
- cada cenário documenta o sinal esperado;
- nenhum teste depende de data/hora atual ou serviço externo.

## 5. Próximo passo

Depois da validação local, iniciar a Fase 1 com o modelo transacional de pagamentos, contas contábeis, ledger imutável e idempotência.
