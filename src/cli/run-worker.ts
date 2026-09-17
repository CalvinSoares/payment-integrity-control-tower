import { Pool } from "pg";
import { createPostgresEventPipeline } from "../adapters/postgres-events.js";
import { LocalEventWorker } from "../application/event-ingestion.js";
import { runWorkerLoop } from "../application/worker-loop.js";
import { loadEnvironment } from "../config/env.js";
import { postgresPoolOptions } from "../config/runtime.js";
import { consoleLogger } from "../observability/logger.js";
import { MetricsRegistry } from "../observability/metrics.js";

const environment = loadEnvironment();
const metrics = new MetricsRegistry();
const pool = new Pool(postgresPoolOptions(environment));
const pipeline = createPostgresEventPipeline(pool);
const worker = new LocalEventWorker(pipeline.transaction, undefined, metrics, environment.workerLeaseMs);
const controller = new AbortController();

consoleLogger.info("worker_started", { pollMs: environment.workerPollMs, leaseMs: environment.workerLeaseMs });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    consoleLogger.info("worker_stopping", { signal });
    controller.abort();
  });
}

await runWorkerLoop(worker, async (event) => {
  consoleLogger.info("event_processed", { eventId: event.eventId, eventType: event.eventType, tenantId: event.tenantId });
}, {
  pollMs: environment.workerPollMs,
  signal: controller.signal,
  onResult: (result) => consoleLogger.info("worker_result", { status: result.status, eventId: result.eventId, attempts: result.attempts }),
  onError: (error) => consoleLogger.error("worker_error", { error: error instanceof Error ? error.message : "Erro desconhecido." }),
});

await pool.end();
consoleLogger.info("worker_stopped");
