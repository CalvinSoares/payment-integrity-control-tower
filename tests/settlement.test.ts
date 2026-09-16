import { describe, expect, it } from "vitest";
import { createInMemoryPaymentCore } from "../src/adapters/in-memory.js";
import { createInMemorySettlementPipeline } from "../src/adapters/in-memory-settlement.js";
import { ReconciliationService, SettlementIngestionService } from "../src/application/settlement.js";
import { parseSettlementCsv } from "../src/domain/settlement/settlement.js";

const header = "settlement_id,external_payment_id,settled_at,gross_amount_minor,fee_amount_minor,net_amount_minor,currency";

function fileInput(content: string) {
  return {
    tenantId: "tenant_a",
    provider: "simulator",
    providerAccountId: "settlement_account",
    fileName: "settlement-2026-01-11.csv",
    periodStart: "2026-01-10T00:00:00Z",
    periodEnd: "2026-01-13T23:59:59Z",
    receivedAt: "2026-01-14T10:00:00Z",
    content,
  };
}

async function seedPayment(service: ReturnType<typeof createInMemoryPaymentCore>["service"], id: string, externalPaymentId: string) {
  await service.createPayment({
    id,
    tenantId: "tenant_a",
    actorId: "operator_1",
    externalPaymentId,
    amountMinor: 10000,
    currency: "BRL",
    occurredAt: "2026-01-10T10:00:00Z",
    idempotencyKey: `create-${id}`,
  });
}

describe("settlement CSV", () => {
  it("parses integer minor units and normalizes the batch", () => {
    const batch = parseSettlementCsv(
      fileInput(`${header}\nsettle-1,pay-ext-1,2026-01-11T10:00:00Z,10000,200,9800,brl\n`),
    );

    expect(batch.fileChecksum).toMatch(/^sha256:/);
    expect(batch.rows[0]).toMatchObject({
      rowNumber: 2,
      settlementId: "settle-1",
      grossAmountMinor: 10000,
      feeAmountMinor: 200,
      netAmountMinor: 9800,
      currency: "BRL",
    });
  });

  it("rejects decimal amounts and malformed headers", () => {
    expect(() => parseSettlementCsv(fileInput(`${header}\nsettle-1,pay-ext-1,2026-01-11T10:00:00Z,100.00,2,98,BRL`))).toThrow(
      "inteiro em centavos",
    );
    expect(() => parseSettlementCsv(fileInput(`wrong-header\nsettle-1`))).toThrow("Cabeçalho esperado");
  });
});

describe("settlement ingestion and reconciliation", () => {
  it("detects missing, duplicate, amount, fee and delay exceptions", async () => {
    const paymentsCore = createInMemoryPaymentCore();
    await seedPayment(paymentsCore.service, "pay-1", "pay-ext-1");
    await seedPayment(paymentsCore.service, "pay-2", "pay-ext-2");
    await seedPayment(paymentsCore.service, "pay-3", "pay-ext-3");
    await seedPayment(paymentsCore.service, "pay-4", "pay-ext-4");
    const pipeline = createInMemorySettlementPipeline(paymentsCore.payments);
    const ingestion = new SettlementIngestionService(pipeline.transaction);
    const reconciliation = new ReconciliationService(pipeline.transaction);
    const content = [
      header,
      "settle-1,pay-ext-1,2026-01-11T10:00:00Z,10000,200,9800,BRL",
      "settle-2,pay-ext-2,2026-01-11T10:00:00Z,9800,100,9700,BRL",
      "settle-3,pay-ext-missing,2026-01-11T10:00:00Z,5000,0,5000,BRL",
      "settle-4,pay-ext-3,2026-01-11T10:00:00Z,10000,300,9800,BRL",
      "settle-5,pay-ext-4,2026-01-13T10:00:00Z,10000,0,10000,BRL",
      "settle-6,pay-ext-4,2026-01-13T10:00:00Z,10000,0,10000,BRL",
    ].join("\n");
    const received = await ingestion.receiveCsv(fileInput(content));
    const replay = await ingestion.receiveCsv(fileInput(content));
    const result = await reconciliation.reconcile({
      batchId: received.batchId,
      tenantId: "tenant_a",
      ruleVersion: "settlement-match.v1",
      idempotencyKey: "reconcile-001",
      requestedAt: "2026-01-14T10:01:00Z",
    });
    const categories = result.exceptions.map((exception) => exception.category).sort();

    expect(received.status).toBe("RECEIVED");
    expect(replay).toEqual({ status: "REPLAYED", batchId: received.batchId, rowCount: 6 });
    expect(result.run.status).toBe("EXCEPTION");
    expect(result.run.itemCount).toBe(6);
    expect(result.run.exceptionCount).toBe(5);
    expect(categories).toEqual([
      "AMOUNT_MISMATCH",
      "DUPLICATE_SETTLEMENT",
      "FEE_MISMATCH",
      "MISSING_PAYMENT",
      "SETTLEMENT_DELAYED",
    ]);
    expect(result.items.find((item) => item.settlementId === "settle-1")?.status).toBe("MATCHED");
  });

  it("reprocesses an exception and resolves it after the source is corrected", async () => {
    const paymentsCore = createInMemoryPaymentCore();
    await seedPayment(paymentsCore.service, "pay-reprocess", "pay-ext-reprocess");
    const pipeline = createInMemorySettlementPipeline(paymentsCore.payments);
    const ingestion = new SettlementIngestionService(pipeline.transaction);
    const reconciliation = new ReconciliationService(pipeline.transaction);
    const received = await ingestion.receiveCsv(
      fileInput(`${header}\nsettle-reprocess,pay-ext-reprocess,2026-01-11T10:00:00Z,9800,100,9700,BRL\n`),
    );
    const first = await reconciliation.reconcile({
      batchId: received.batchId,
      tenantId: "tenant_a",
      ruleVersion: "settlement-match.v1",
      idempotencyKey: "reconcile-reprocess-001",
      requestedAt: "2026-01-14T10:01:00Z",
    });
    const exception = first.exceptions[0];
    const payment = await paymentsCore.payments.getById("pay-reprocess");
    if (!exception || !payment) throw new Error("Fixture de reprocessamento incompleto.");
    await paymentsCore.payments.update({ ...payment, amountMinor: 9800 });

    const reprocessed = await reconciliation.reprocessException({
      exceptionId: exception.exceptionId,
      actorId: "operator_1",
      requestedAt: "2026-01-14T10:02:00Z",
    });

    expect(reprocessed.resolved).toBe(true);
    expect(reprocessed.exceptions).toHaveLength(0);
    expect((await pipeline.exceptions.getById(exception.exceptionId))?.status).toBe("RESOLVED");
  });
});
