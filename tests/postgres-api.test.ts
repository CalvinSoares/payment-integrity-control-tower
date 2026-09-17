import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BearerTokenAuthenticator } from "../src/api/auth.js";
import { createApiServer } from "../src/api/server.js";
import { PostgresControlTowerQueries } from "../src/adapters/postgres-control-tower.js";
import { createPostgresEventPipeline } from "../src/adapters/postgres-events.js";
import { createPostgresPaymentCore } from "../src/adapters/postgres.js";
import { createPostgresSettlementPipeline } from "../src/adapters/postgres-settlement.js";
import { EventIngestionService } from "../src/application/event-ingestion.js";
import { ExceptionOperationsService } from "../src/application/exception-operations.js";
import { ReconciliationService, SettlementIngestionService } from "../src/application/settlement.js";
import { createPaymentEvent, hashEventData } from "../src/domain/events/payment-event.js";
import { loadEnvironment } from "../src/config/env.js";

const runDbTests = process.env.RUN_DB_TESTS === "1";

function call(port: number, method: string, path: string, body: unknown, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      port,
      method,
      path,
      headers: {
        authorization: `Bearer ${token}`,
        ...(serialized === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(serialized) }),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> }));
    });
    req.on("error", reject);
    if (serialized !== undefined) req.write(serialized);
    req.end();
  });
}

describe.skipIf(!runDbTests)("Postgres Control Tower API", () => {
  const pool = new Pool({ connectionString: loadEnvironment().databaseUrl });
  const paymentCore = createPostgresPaymentCore(pool);
  const eventPipeline = createPostgresEventPipeline(pool);
  const settlementPipeline = createPostgresSettlementPipeline(pool);
  const token = `api-token-${randomUUID()}`;
  const tenantId = `api-tenant-${randomUUID()}`;
  const actorId = `api-actor-${randomUUID()}`;
  const server = createApiServer({
    authenticator: new BearerTokenAuthenticator(token, { tenantId, actorId, scopes: ["control_tower:read", "control_tower:write"] }),
    eventIngestion: new EventIngestionService(eventPipeline.transaction),
    settlementIngestion: new SettlementIngestionService(settlementPipeline.transaction),
    reconciliation: new ReconciliationService(settlementPipeline.transaction),
    exceptions: new ExceptionOperationsService(settlementPipeline.transaction),
    queries: new PostgresControlTowerQueries(pool),
  });
  let port: number;

  beforeAll(async () => {
    await pool.query("SELECT 1");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("API de integração não abriu porta.");
    port = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.end();
  });

  it("publishes an event and exposes it in the tenant-scoped timeline", async () => {
    const suffix = randomUUID();
    const paymentId = `pay_api_${suffix}`;
    const externalPaymentId = `external_api_${suffix}`;
    const occurredAt = new Date(Date.now() - 60_000).toISOString();
    await paymentCore.service.createPayment({
      id: paymentId,
      tenantId,
      actorId,
      externalPaymentId,
      amountMinor: 10000,
      currency: "BRL",
      occurredAt,
      idempotencyKey: `create_${suffix}`,
    });
    const data = { paymentId, externalPaymentId, amountMinor: 10000, currency: "BRL" };
    const event = createPaymentEvent({
      eventId: `evt:api:${suffix}`,
      eventType: "payment.authorized",
      schemaVersion: 1,
      tenantId,
      provider: "simulator",
      providerAccountId: `account_${suffix}`,
      externalPaymentId,
      externalEventId: `external_evt_${suffix}`,
      occurredAt,
      receivedAt: new Date().toISOString(),
      traceId: `trace_${suffix}`,
      payloadHash: hashEventData(data),
      data,
    });

    const published = await call(port, "POST", "/payments/events", event, token);
    const timeline = await call(port, "GET", `/payments/${paymentId}/timeline`, undefined, token);
    const events = timeline.body.events as Array<Record<string, unknown>>;

    expect(published.status).toBe(202);
    expect(timeline.status).toBe(200);
    expect(events.some((item) => item.eventId === event.eventId && item.status === "RECEIVED")).toBe(true);
  });
});
