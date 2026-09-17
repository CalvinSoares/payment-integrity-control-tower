import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventIngestionService, LocalEventWorker } from "../src/application/event-ingestion.js";
import { createPostgresEventPipeline } from "../src/adapters/postgres-events.js";
import { SimulatorEventAdapter } from "../src/adapters/provider-events.js";
import { loadEnvironment } from "../src/config/env.js";

const runDbTests = process.env.RUN_DB_TESTS === "1";

function makeEvent(suffix = randomUUID()) {
  const occurredAt = new Date(Date.now() - 2000).toISOString();
  return new SimulatorEventAdapter().normalize({
    step: {
      eventType: "captured",
      externalEventId: `sim_evt_${suffix}`,
      occurredAt,
      amountMinor: 10000,
      currency: "BRL",
      provider: "simulator",
    },
    context: {
      tenantId: `tenant_test_${suffix}`,
      providerAccountId: "simulator_account",
      paymentId: `pay_test_${suffix}`,
      externalPaymentId: `provider_test_pay_${suffix}`,
      traceId: `trace_${suffix}`,
      receivedAt: occurredAt,
    },
  });
}

describe.skipIf(!runDbTests)("Postgres event pipeline", () => {
  const pool = new Pool({ connectionString: loadEnvironment().databaseUrl });
  const { transaction } = createPostgresEventPipeline(pool);
  const ingestion = new EventIngestionService(transaction);
  const worker = new LocalEventWorker(transaction);

  beforeAll(async () => {
    await pool.query("SELECT 1");
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM event_outbox WHERE event_json->'data'->>'paymentId' LIKE 'pay_test_%'");
    await pool.query("DELETE FROM event_inbox WHERE event_json->'data'->>'paymentId' LIKE 'pay_test_%'");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("persists inbox/outbox and replays a duplicate without creating another row", async () => {
    const event = makeEvent();
    const first = await ingestion.receive(event);
    const replay = await ingestion.receive(event);
    const counts = await pool.query<{ inbox_count: string; outbox_count: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM event_inbox WHERE event_id = $1) AS inbox_count,
         (SELECT COUNT(*)::text FROM event_outbox WHERE event_id = $1) AS outbox_count`,
      [event.eventId],
    );

    expect(first.status).toBe("RECEIVED");
    expect(replay.status).toBe("REPLAYED");
    expect(counts.rows[0]).toEqual({ inbox_count: "1", outbox_count: "1" });
    expect((await worker.processNext(async () => undefined)).status).toBe("APPLIED");
  });

  it("applies the event and prevents two workers from claiming the same message", async () => {
    const event = makeEvent();
    await ingestion.receive(event);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseHandler!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });

    const firstWorker = worker.processNext(async () => {
      markStarted();
      await release;
    });
    await started;
    const secondWorker = await worker.processNext(async () => undefined);
    releaseHandler();
    const firstResult = await firstWorker;
    const statuses = await pool.query<{ inbox_status: string; outbox_status: string; attempts: number }>(
      `SELECT
         i.status AS inbox_status,
         o.status AS outbox_status,
         o.attempts
       FROM event_inbox i
       INNER JOIN event_outbox o ON o.event_id = i.event_id
       WHERE i.event_id = $1`,
      [event.eventId],
    );

    expect(secondWorker.status).toBe("IDLE");
    expect(firstResult).toEqual({ status: "APPLIED", eventId: event.eventId });
    expect(statuses.rows[0]).toMatchObject({ inbox_status: "APPLIED", outbox_status: "PUBLISHED", attempts: 1 });
  });

  it("marks a handler failure as rejected and failed", async () => {
    const event = makeEvent();
    await ingestion.receive(event);
    const result = await worker.processNext(async () => {
      throw new Error("falha persistida");
    });
    const statuses = await pool.query<{ inbox_status: string; outbox_status: string; last_error: string }>(
      `SELECT i.status AS inbox_status, o.status AS outbox_status, i.last_error
       FROM event_inbox i
       INNER JOIN event_outbox o ON o.event_id = i.event_id
       WHERE i.event_id = $1`,
      [event.eventId],
    );

    expect(result).toEqual({ status: "REJECTED", eventId: event.eventId, error: "falha persistida" });
    expect(statuses.rows[0]).toMatchObject({
      inbox_status: "REJECTED",
      outbox_status: "FAILED",
      last_error: "falha persistida",
    });
  });
});
