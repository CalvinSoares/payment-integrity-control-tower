import { Pool } from "pg";
import { createApiServer } from "../api/server.js";
import { BearerTokenAuthenticator } from "../api/auth.js";
import { PostgresControlTowerQueries } from "../adapters/postgres-control-tower.js";
import { createPostgresEventPipeline } from "../adapters/postgres-events.js";
import { createPostgresSettlementPipeline } from "../adapters/postgres-settlement.js";
import { EventIngestionService } from "../application/event-ingestion.js";
import { DeadLetterService } from "../application/dead-letter.js";
import { ExceptionOperationsService } from "../application/exception-operations.js";
import { ReconciliationService, SettlementIngestionService } from "../application/settlement.js";
import { loadEnvironment } from "../config/env.js";
import { configureHttpServer, postgresPoolOptions } from "../config/runtime.js";
import { MetricsRegistry } from "../observability/metrics.js";
import { PostgresHealthChecker } from "../api/health.js";

const environment = loadEnvironment();
const pool = new Pool(postgresPoolOptions(environment));
const eventPipeline = createPostgresEventPipeline(pool);
const settlementPipeline = createPostgresSettlementPipeline(pool);
const server = createApiServer({
  authenticator: new BearerTokenAuthenticator(environment.apiToken, {
    tenantId: environment.apiTenantId,
    actorId: environment.apiActorId,
    scopes: ["control_tower:read", "control_tower:write"],
  }),
  eventIngestion: new EventIngestionService(eventPipeline.transaction),
  deadLetters: new DeadLetterService(eventPipeline.transaction),
  settlementIngestion: new SettlementIngestionService(settlementPipeline.transaction),
  reconciliation: new ReconciliationService(settlementPipeline.transaction),
  exceptions: new ExceptionOperationsService(settlementPipeline.transaction),
  queries: new PostgresControlTowerQueries(pool),
  health: new PostgresHealthChecker(async () => pool.query("SELECT 1")),
  metrics: new MetricsRegistry(),
  maxBodyBytes: environment.maxBodyBytes,
});

configureHttpServer(server, environment);

server.listen(environment.port, () => {
  console.log(`[api] Control Tower ouvindo em http://localhost:${environment.port}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[api] recebendo ${signal}, encerrando...`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
