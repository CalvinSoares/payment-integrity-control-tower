import { describe, expect, it } from "vitest";
import { createInMemoryPaymentCore } from "../src/adapters/in-memory.js";
import { DomainError } from "../src/domain/errors.js";

const baseCreateCommand = {
  id: "pay_001",
  tenantId: "tenant_a",
  actorId: "operator_1",
  externalPaymentId: "provider_pay_001",
  amountMinor: 10000,
  currency: "BRL",
  occurredAt: "2026-01-10T10:00:00Z",
  idempotencyKey: "create-key-001",
};

function captureCommand(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: "tenant_a",
    actorId: "operator_1",
    paymentId: "pay_001",
    operation: "payment.capture",
    idempotencyKey: "capture-key-001",
    targetState: "CAPTURED" as const,
    sourceEventId: "evt_capture_001",
    occurredAt: "2026-01-10T10:01:00Z",
    journal: {
      journalId: "journal_capture_001",
      lines: [
        {
          accountId: "acquirer_receivable",
          direction: "DEBIT" as const,
          amountMinor: 10000,
          currency: "BRL",
          referenceType: "Payment",
          referenceId: "pay_001",
        },
        {
          accountId: "merchant_obligation",
          direction: "CREDIT" as const,
          amountMinor: 10000,
          currency: "BRL",
          referenceType: "Payment",
          referenceId: "pay_001",
        },
      ],
    },
    ...overrides,
  };
}

async function createAuthorizedPayment(service: ReturnType<typeof createInMemoryPaymentCore>["service"]): Promise<void> {
  await service.createPayment(baseCreateCommand);
  await service.transitionPayment({
    tenantId: "tenant_a",
    actorId: "operator_1",
    paymentId: "pay_001",
    operation: "payment.authorize",
    idempotencyKey: "authorize-key-001",
    targetState: "AUTHORIZED",
    sourceEventId: "evt_authorize_001",
    occurredAt: "2026-01-10T10:00:30Z",
  });
}

describe("PaymentCoreService", () => {
  it("creates a payment in CREATED", async () => {
    const { service, payments, audit } = createInMemoryPaymentCore();
    const result = await service.createPayment(baseCreateCommand);

    expect(result.payment.state).toBe("CREATED");
    expect((await payments.getById("pay_001"))?.amountMinor).toBe(10000);
    expect(audit.size).toBe(1);
  });

  it("applies a valid transition and a balanced journal", async () => {
    const { service, ledger } = createInMemoryPaymentCore();
    await createAuthorizedPayment(service);
    const result = await service.transitionPayment(captureCommand());

    expect(result.payment.state).toBe("CAPTURED");
    expect(result.journal?.lines).toHaveLength(2);
    expect(ledger.size).toBe(1);
  });

  it("rejects an invalid transition without changing the payment", async () => {
    const { service, payments, ledger } = createInMemoryPaymentCore();
    await service.createPayment(baseCreateCommand);

    await expect(service.transitionPayment(captureCommand({ targetState: "PAID_OUT" }))).rejects.toThrow(
      "Transição de pagamento inválida",
    );
    expect((await payments.getById("pay_001"))?.state).toBe("CREATED");
    expect(ledger.size).toBe(0);
  });

  it("rejects an unbalanced journal before persisting state or ledger", async () => {
    const { service, payments, ledger } = createInMemoryPaymentCore();
    await createAuthorizedPayment(service);

    await expect(
      service.transitionPayment(
        captureCommand({
          journal: {
            journalId: "journal_invalid_001",
            lines: [
              {
                accountId: "acquirer_receivable",
                direction: "DEBIT" as const,
                amountMinor: 10000,
                currency: "BRL",
                referenceType: "Payment",
                referenceId: "pay_001",
              },
              {
                accountId: "merchant_obligation",
                direction: "CREDIT" as const,
                amountMinor: 9900,
                currency: "BRL",
                referenceType: "Payment",
                referenceId: "pay_001",
              },
            ],
          },
        }),
      ),
    ).rejects.toThrow("Journal desbalanceado");

    expect((await payments.getById("pay_001"))?.state).toBe("AUTHORIZED");
    expect(ledger.size).toBe(0);
  });

  it("replays the same idempotent command without duplicating effects", async () => {
    const { service, ledger, audit } = createInMemoryPaymentCore();
    await createAuthorizedPayment(service);

    const first = await service.transitionPayment(captureCommand());
    const second = await service.transitionPayment(captureCommand());

    expect(second).toEqual(first);
    expect(ledger.size).toBe(1);
    expect(audit.size).toBe(3);
  });

  it("does not share an idempotency key between tenants", async () => {
    const { service, payments } = createInMemoryPaymentCore();
    await service.createPayment(baseCreateCommand);
    const otherTenant = await service.createPayment({
      ...baseCreateCommand,
      id: "pay_002",
      tenantId: "tenant_b",
      externalPaymentId: "provider_pay_002",
    });

    expect(otherTenant.payment.tenantId).toBe("tenant_b");
    expect(await payments.getById("pay_002")).toBeDefined();
  });

  it("rejects reusing a key with a different payload", async () => {
    const { service } = createInMemoryPaymentCore();
    await service.createPayment(baseCreateCommand);

    await expect(service.createPayment({ ...baseCreateCommand, amountMinor: 20000 })).rejects.toThrow(DomainError);
    await expect(service.createPayment({ ...baseCreateCommand, amountMinor: 20000 })).rejects.toThrow(
      "payload diferente",
    );
  });
});
