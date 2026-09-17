# Execução local completa

O fluxo local não exige Kafka, cloud, OpenTelemetry ou credenciais externas. Ele usa PostgreSQL, API e worker em processos separados.

## Preparar o banco

```bash
npm install
docker compose up -d postgres
npm run db:migrate
```

O comando lê os arquivos SQL de `db/init` em ordem numérica e executa tudo em uma transação. As migrations deste estudo são idempotentes.

## Subir API e worker

Em dois terminais, no mesmo diretório:

```bash
npm run api
```

```bash
npm run worker
```

O worker consome o outbox, executa o handler local de estudo e grava `PUBLISHED`. Ele prova o ciclo de ingestão, claim, retry, lease, DLQ e replay.

## Verificar

```bash
curl http://localhost:4100/health/live
curl http://localhost:4100/health/ready
curl http://localhost:4100/metrics
```

Use `Ctrl+C` para encerrar API ou worker. Ambos fecham o pool PostgreSQL de forma graciosa.

O token `local-dev-token` e o tenant `tenant_local` são exclusivos para desenvolvimento.
