import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPaymentCore } from "../src/adapters/postgres.js";
import { loadEnvironment } from "../src/config/env.js";

const runDbTests = process.env.RUN_DB_TESTS === "1";

describe.skipIf(!runDbTests)("Postgres payment core", () => {
  const pool = new Pool({ connectionString: loadEnvironment().databaseUrl });
  const { service, ports } = createPostgresPaymentCore(pool);

  beforeAll(async () => {
    await pool.query("SELECT 1");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("persists payment, ledger, idempotency and audit atomically", async () => {
    const suffix = randomUUID();
    const paymentId = `pay_${suffix}`;
    const externalPaymentId = `provider_${suffix}`;
    const tenantId = `tenant_${suffix}`;
    const actorId = `operator_${suffix}`;
    const createKey = `create_${suffix}`;
    const authorizeKey = `authorize_${suffix}`;
    const captureKey = `capture_${suffix}`;
    const createdAt = new Date(Date.now() - 1000).toISOString();
    const authorizedAt = new Date(Date.parse(createdAt) + 30_000).toISOString();
    const capturedAt = new Date(Date.parse(createdAt) + 60_000).toISOString();

    const created = await service.createPayment({
      id: paymentId,
      tenantId,
      actorId,
      externalPaymentId,
      amountMinor: 10000,
      currency: "BRL",
      occurredAt: createdAt,
      idempotencyKey: createKey,
    });
    await service.transitionPayment({
      tenantId,
      actorId,
      paymentId,
      operation: "payment.authorize",
      idempotencyKey: authorizeKey,
      targetState: "AUTHORIZED",
      sourceEventId: `evt_authorize_${suffix}`,
      occurredAt: authorizedAt,
    });
    const captured = await service.transitionPayment({
      tenantId,
      actorId,
      paymentId,
      operation: "payment.capture",
      idempotencyKey: captureKey,
      targetState: "CAPTURED",
      sourceEventId: `evt_capture_${suffix}`,
      occurredAt: capturedAt,
      journal: {
        journalId: `journal_${suffix}`,
        lines: [
          {
            accountId: "acquirer_receivable",
            direction: "DEBIT",
            amountMinor: 10000,
            currency: "BRL",
            referenceType: "Payment",
            referenceId: paymentId,
          },
          {
            accountId: "merchant_obligation",
            direction: "CREDIT",
            amountMinor: 10000,
            currency: "BRL",
            referenceType: "Payment",
            referenceId: paymentId,
          },
        ],
      },
    });

    expect(created.payment.state).toBe("CREATED");
    expect(captured.payment.state).toBe("CAPTURED");

    const replayed = await service.createPayment({
      id: paymentId,
      tenantId,
      actorId,
      externalPaymentId,
      amountMinor: 10000,
      currency: "BRL",
      occurredAt: createdAt,
      idempotencyKey: createKey,
    });
    expect(replayed).toEqual(created);
    expect(await ports.payments.getById(paymentId)).toMatchObject({ id: paymentId, state: "CAPTURED" });
    expect(await ports.ledger.listByReference("Payment", paymentId)).toHaveLength(1);
    expect(await ports.audit.listByEntity("Payment", paymentId)).toHaveLength(3);

    const persisted = await pool.query<{ state: string }>("SELECT state FROM payments WHERE id = $1", [paymentId]);
    const idempotency = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM idempotency_records WHERE tenant_id = $1",
      [tenantId],
    );
    const audit = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM audit_events WHERE tenant_id = $1",
      [tenantId],
    );
    const ledger = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM ledger_entries e
       INNER JOIN ledger_journals j ON j.journal_id = e.journal_id
       WHERE e.reference_id = $1`,
      [paymentId],
    );

    expect(persisted.rows[0]?.state).toBe("CAPTURED");
    expect(idempotency.rows[0]?.count).toBe("3");
    expect(audit.rows[0]?.count).toBe("3");
    expect(ledger.rows[0]?.count).toBe("2");
  });

  it("rolls back a failed transition without partial persistence", async () => {
    const suffix = randomUUID();
    const paymentId = `pay_rollback_${suffix}`;
    const tenantId = `tenant_rollback_${suffix}`;
    const actorId = `operator_rollback_${suffix}`;
    const createdAt = new Date(Date.now() - 1000).toISOString();

    await service.createPayment({
      id: paymentId,
      tenantId,
      actorId,
      externalPaymentId: `provider_${suffix}`,
      amountMinor: 10000,
      currency: "BRL",
      occurredAt: createdAt,
      idempotencyKey: `create_${suffix}`,
    });
    await service.transitionPayment({
      tenantId,
      actorId,
      paymentId,
      operation: "payment.authorize",
      idempotencyKey: `authorize_${suffix}`,
      targetState: "AUTHORIZED",
      sourceEventId: `evt_authorize_${suffix}`,
      occurredAt: new Date(Date.parse(createdAt) + 30_000).toISOString(),
    });

    await expect(
      service.transitionPayment({
        tenantId,
        actorId,
        paymentId,
        operation: "payment.capture",
        // Reuses the authorization key only to force the audit unique constraint
        // after the ledger and payment UPDATE have already executed.
        idempotencyKey: `authorize_${suffix}`,
        targetState: "CAPTURED",
        sourceEventId: `evt_capture_${suffix}`,
        occurredAt: new Date(Date.parse(createdAt) + 60_000).toISOString(),
        journal: {
          journalId: `journal_${suffix}`,
          lines: [
            {
              accountId: "acquirer_receivable",
              direction: "DEBIT",
              amountMinor: 10000,
              currency: "BRL",
              referenceType: "Payment",
              referenceId: paymentId,
            },
            {
              accountId: "merchant_obligation",
              direction: "CREDIT",
              amountMinor: 10000,
              currency: "BRL",
              referenceType: "Payment",
              referenceId: paymentId,
            },
          ],
        },
      }),
    ).rejects.toThrow();

    expect(await ports.payments.getById(paymentId)).toMatchObject({ id: paymentId, state: "AUTHORIZED" });
    expect(await ports.ledger.listByReference("Payment", paymentId)).toHaveLength(0);
    expect(await ports.audit.listByEntity("Payment", paymentId)).toHaveLength(2);
  });
});
