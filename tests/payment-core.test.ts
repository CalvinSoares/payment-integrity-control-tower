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

function createAuthorizedPayment(service: ReturnType<typeof createInMemoryPaymentCore>["service"]): void {
  service.createPayment(baseCreateCommand);
  service.transitionPayment({
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
  it("creates a payment in CREATED", () => {
    const { service, payments, audit } = createInMemoryPaymentCore();
    const result = service.createPayment(baseCreateCommand);

    expect(result.payment.state).toBe("CREATED");
    expect(payments.getById("pay_001")?.amountMinor).toBe(10000);
    expect(audit.size).toBe(1);
  });

  it("applies a valid transition and a balanced journal", () => {
    const { service, ledger } = createInMemoryPaymentCore();
    createAuthorizedPayment(service);
    const result = service.transitionPayment(captureCommand());

    expect(result.payment.state).toBe("CAPTURED");
    expect(result.journal?.lines).toHaveLength(2);
    expect(ledger.size).toBe(1);
  });

  it("rejects an invalid transition without changing the payment", () => {
    const { service, payments, ledger } = createInMemoryPaymentCore();
    service.createPayment(baseCreateCommand);

    expect(() => service.transitionPayment(captureCommand({ targetState: "PAID_OUT" }))).toThrow(
      "Transição de pagamento inválida",
    );
    expect(payments.getById("pay_001")?.state).toBe("CREATED");
    expect(ledger.size).toBe(0);
  });

  it("rejects an unbalanced journal before persisting state or ledger", () => {
    const { service, payments, ledger } = createInMemoryPaymentCore();
    createAuthorizedPayment(service);

    expect(() =>
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
    ).toThrow("Journal desbalanceado");

    expect(payments.getById("pay_001")?.state).toBe("AUTHORIZED");
    expect(ledger.size).toBe(0);
  });

  it("replays the same idempotent command without duplicating effects", () => {
    const { service, ledger, audit } = createInMemoryPaymentCore();
    createAuthorizedPayment(service);

    const first = service.transitionPayment(captureCommand());
    const second = service.transitionPayment(captureCommand());

    expect(second).toEqual(first);
    expect(ledger.size).toBe(1);
    expect(audit.size).toBe(3);
  });

  it("does not share an idempotency key between tenants", () => {
    const { service, payments } = createInMemoryPaymentCore();
    service.createPayment(baseCreateCommand);
    const otherTenant = service.createPayment({
      ...baseCreateCommand,
      id: "pay_002",
      tenantId: "tenant_b",
      externalPaymentId: "provider_pay_002",
    });

    expect(otherTenant.payment.tenantId).toBe("tenant_b");
    expect(payments.getById("pay_002")).toBeDefined();
  });

  it("rejects reusing a key with a different payload", () => {
    const { service } = createInMemoryPaymentCore();
    service.createPayment(baseCreateCommand);

    expect(() => service.createPayment({ ...baseCreateCommand, amountMinor: 20000 })).toThrow(DomainError);
    expect(() => service.createPayment({ ...baseCreateCommand, amountMinor: 20000 })).toThrow(
      "payload diferente",
    );
  });
});
