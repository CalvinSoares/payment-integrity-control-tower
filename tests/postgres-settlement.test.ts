import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPaymentCore } from "../src/adapters/postgres.js";
import {
  createPostgresSettlementPipeline,
  createPostgresSettlementRepositoryPorts,
} from "../src/adapters/postgres-settlement.js";
import { ReconciliationService, SettlementIngestionService } from "../src/application/settlement.js";
import { loadEnvironment } from "../src/config/env.js";

const runDbTests = process.env.RUN_DB_TESTS === "1";
const header = "settlement_id,external_payment_id,settled_at,gross_amount_minor,fee_amount_minor,net_amount_minor,currency";

describe.skipIf(!runDbTests)("Postgres settlement and reconciliation", () => {
  const pool = new Pool({ connectionString: loadEnvironment().databaseUrl });
  const paymentCore = createPostgresPaymentCore(pool);
  const pipeline = createPostgresSettlementPipeline(pool);
  const ingestion = new SettlementIngestionService(pipeline.transaction);
  const reconciliation = new ReconciliationService(pipeline.transaction);

  beforeAll(async () => {
    await pool.query("SELECT 1");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("persists a batch, matches rows and opens an exception with evidence", async () => {
    const suffix = randomUUID();
    const baseTime = new Date(Date.now() - 60 * 60 * 1000);
    const occurredAt = baseTime.toISOString();
    const settledAt = new Date(baseTime.getTime() + 10 * 60 * 1000).toISOString();
    const receivedAt = new Date(baseTime.getTime() + 20 * 60 * 1000).toISOString();
    const paymentId = `pay_${suffix}`;
    const tenantId = `tenant_${suffix}`;
    const externalPaymentId = `provider_${suffix}`;

    await paymentCore.service.createPayment({
      id: paymentId,
      tenantId,
      actorId: `operator_${suffix}`,
      externalPaymentId,
      amountMinor: 10000,
      currency: "BRL",
      occurredAt,
      idempotencyKey: `create_${suffix}`,
    });
    const content = [
      header,
      `settle_match_${suffix},${externalPaymentId},${settledAt},10000,200,9800,BRL`,
      `settle_missing_${suffix},missing_${suffix},${settledAt},5000,0,5000,BRL`,
    ].join("\n");
    const input = {
      tenantId,
      provider: "simulator",
      providerAccountId: `account_${suffix}`,
      fileName: `settlement-${suffix}.csv`,
      periodStart: occurredAt,
      periodEnd: settledAt,
      receivedAt,
      content,
    };
    const received = await ingestion.receiveCsv(input);
    const replay = await ingestion.receiveCsv(input);
    const result = await reconciliation.reconcile({
      batchId: received.batchId,
      tenantId,
      ruleVersion: "settlement-match.v1",
      idempotencyKey: `reconcile_${suffix}`,
      requestedAt: receivedAt,
    });
    const ports = createPostgresSettlementRepositoryPorts(pool, paymentCore.ports.payments);
    const storedBatch = await ports.settlements.getById(received.batchId);
    const storedItems = await ports.reconciliation.listItems(result.run.runId);
    const counts = await pool.query<{ exceptions: string }>(
      "SELECT COUNT(*)::text AS exceptions FROM exception_cases WHERE run_id = $1",
      [result.run.runId],
    );

    expect(received.status).toBe("RECEIVED");
    expect(replay).toEqual({ status: "REPLAYED", batchId: received.batchId, rowCount: 2 });
    expect(storedBatch?.rows).toHaveLength(2);
    expect(result.run.status).toBe("EXCEPTION");
    expect(result.run.itemCount).toBe(2);
    expect(result.run.exceptionCount).toBe(1);
    expect(storedItems.find((item) => item.status === "MATCHED")?.paymentId).toBe(paymentId);
    expect(storedItems.find((item) => item.category === "MISSING_PAYMENT")?.evidence).toContain(
      `settlement-record:settle_missing_${suffix}`,
    );
    expect(counts.rows[0]?.exceptions).toBe("1");
  });

  it("reprocesses a corrected mismatch and resolves the original exception", async () => {
    const suffix = randomUUID();
    const baseTime = new Date(Date.now() - 60 * 60 * 1000);
    const occurredAt = baseTime.toISOString();
    const settledAt = new Date(baseTime.getTime() + 10 * 60 * 1000).toISOString();
    const receivedAt = new Date(baseTime.getTime() + 20 * 60 * 1000).toISOString();
    const paymentId = `pay_reprocess_${suffix}`;
    const tenantId = `tenant_reprocess_${suffix}`;
    const externalPaymentId = `provider_reprocess_${suffix}`;
    await paymentCore.service.createPayment({
      id: paymentId,
      tenantId,
      actorId: `operator_${suffix}`,
      externalPaymentId,
      amountMinor: 10000,
      currency: "BRL",
      occurredAt,
      idempotencyKey: `create_${suffix}`,
    });
    const content = [
      header,
      `settle_reprocess_${suffix},${externalPaymentId},${settledAt},9800,100,9700,BRL`,
    ].join("\n");
    const received = await ingestion.receiveCsv({
      tenantId,
      provider: "simulator",
      providerAccountId: `account_${suffix}`,
      fileName: `settlement-reprocess-${suffix}.csv`,
      periodStart: occurredAt,
      periodEnd: settledAt,
      receivedAt,
      content,
    });
    const first = await reconciliation.reconcile({
      batchId: received.batchId,
      tenantId,
      ruleVersion: "settlement-match.v1",
      idempotencyKey: `reconcile_${suffix}`,
      requestedAt: receivedAt,
    });
    const exception = first.exceptions[0];
    if (!exception) throw new Error("Exceção esperada não foi criada.");
    await pool.query("UPDATE payments SET amount_minor = $2 WHERE id = $1", [paymentId, 9800]);

    const reprocessed = await reconciliation.reprocessException({
      exceptionId: exception.exceptionId,
      actorId: `operator_${suffix}`,
      requestedAt: new Date(baseTime.getTime() + 30 * 60 * 1000).toISOString(),
    });
    const resolved = await pool.query<{ status: string }>(
      "SELECT status FROM exception_cases WHERE exception_id = $1",
      [exception.exceptionId],
    );

    expect(reprocessed.resolved).toBe(true);
    expect(reprocessed.exceptions).toHaveLength(0);
    expect(resolved.rows[0]?.status).toBe("RESOLVED");
  });
});
