import { AuditEvent } from "../domain/audit/audit-event.js";
import { DomainError } from "../domain/errors.js";
import {
  assertSameIdempotentCommand,
  fingerprintCommand,
  type IdempotencyScope,
} from "../domain/idempotency/idempotency.js";
import {
  createLedgerJournal,
  type CreateLedgerJournalInput,
} from "../domain/ledger/ledger.js";
import {
  createPayment,
  transitionPayment,
  type CreatePaymentInput,
  type Payment,
  type PaymentState,
} from "../domain/payments/payment.js";
import type { PaymentCorePorts, PaymentCoreResult, RepositoryPorts } from "./ports.js";

export type CreatePaymentCommand = CreatePaymentInput & {
  actorId: string;
  idempotencyKey: string;
};

export type TransitionPaymentCommand = {
  tenantId: string;
  actorId: string;
  paymentId: string;
  operation: string;
  idempotencyKey: string;
  targetState: PaymentState;
  sourceEventId: string;
  occurredAt: string;
  journal?: Omit<CreateLedgerJournalInput, "sourceEventId" | "createdAt">;
};

function assertCommandIdentity(tenantId: string, actorId: string, operation: string, key: string): void {
  if (tenantId.trim() === "" || actorId.trim() === "" || operation.trim() === "" || key.trim() === "") {
    throw new DomainError("invalid_command", "tenantId, actorId, operation e idempotencyKey são obrigatórios.");
  }
}

function scopeOf(command: { tenantId: string; actorId: string; operation: string; idempotencyKey: string }): IdempotencyScope {
  assertCommandIdentity(command.tenantId, command.actorId, command.operation, command.idempotencyKey);
  return {
    tenantId: command.tenantId,
    actorId: command.actorId,
    operation: command.operation,
    key: command.idempotencyKey,
  };
}

async function getReplayOrThrow(
  ports: RepositoryPorts,
  scope: IdempotencyScope,
  fingerprint: string,
): Promise<PaymentCoreResult | undefined> {
  const record = await ports.idempotency.get(scope);
  return record ? assertSameIdempotentCommand(record, fingerprint) : undefined;
}

function expirationFrom(createdAt: string): string {
  const expiration = new Date(createdAt);
  expiration.setUTCDate(expiration.getUTCDate() + 7);
  return expiration.toISOString();
}

function auditForPayment(input: {
  auditId: string;
  tenantId: string;
  actorId: string;
  action: string;
  payment: Payment;
  occurredAt: string;
  sourceEventId?: string;
  metadata: Record<string, unknown>;
}): AuditEvent {
  return {
    auditId: input.auditId,
    tenantId: input.tenantId,
    actorId: input.actorId,
    action: input.action,
    entityType: "Payment",
    entityId: input.payment.id,
    ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
    occurredAt: input.occurredAt,
    metadata: input.metadata,
  };
}

export class PaymentCoreService {
  public constructor(private readonly ports: PaymentCorePorts) {}

  public async createPayment(command: CreatePaymentCommand): Promise<PaymentCoreResult> {
    const scope = scopeOf({
      tenantId: command.tenantId,
      actorId: command.actorId,
      operation: "payment.create",
      idempotencyKey: command.idempotencyKey,
    });
    const fingerprint = fingerprintCommand(command);
    return this.ports.transaction.run(async (ports: RepositoryPorts) => {
      const replay = await getReplayOrThrow(ports, scope, fingerprint);
      if (replay) return replay;

      const existing = await ports.payments.getByExternalPaymentId(command.tenantId, command.externalPaymentId);
      if (existing) {
        throw new DomainError("payment_already_exists", "Já existe pagamento com esse identificador externo.");
      }

      const payment = createPayment(command);
      const result: PaymentCoreResult = { payment, journal: null };
      await ports.payments.insert(payment);
      await ports.audit.append(
        auditForPayment({
          auditId: `audit:${command.idempotencyKey}`,
          tenantId: command.tenantId,
          actorId: command.actorId,
          action: "PAYMENT_CREATED",
          payment,
          occurredAt: command.occurredAt,
          metadata: { state: payment.state, amountMinor: payment.amountMinor, currency: payment.currency },
        }),
      );
      await ports.idempotency.save({
        ...scope,
        fingerprint,
        result,
        createdAt: command.occurredAt,
        expiresAt: expirationFrom(command.occurredAt),
      });
      return result;
    });
  }

  public async transitionPayment(command: TransitionPaymentCommand): Promise<PaymentCoreResult> {
    const scope = scopeOf(command);
    const fingerprint = fingerprintCommand(command);
    return this.ports.transaction.run(async (ports: RepositoryPorts) => {
      const replay = await getReplayOrThrow(ports, scope, fingerprint);
      if (replay) return replay;

      const current = await ports.payments.getById(command.paymentId);
      if (!current || current.tenantId !== command.tenantId) {
        throw new DomainError("payment_not_found", "Pagamento não encontrado no tenant informado.");
      }

      const payment = transitionPayment(current, command.targetState, command.occurredAt);
      const journal = command.journal
        ? createLedgerJournal({
            ...command.journal,
            sourceEventId: command.sourceEventId,
            createdAt: command.occurredAt,
          })
        : null;
      const result: PaymentCoreResult = { payment, journal };

      if (journal) await ports.ledger.append(journal);
      await ports.payments.update(payment);
      await ports.audit.append(
        auditForPayment({
          auditId: `audit:${command.idempotencyKey}`,
          tenantId: command.tenantId,
          actorId: command.actorId,
          action: `PAYMENT_${command.targetState}`,
          payment,
          occurredAt: command.occurredAt,
          sourceEventId: command.sourceEventId,
          metadata: { previousState: current.state, targetState: command.targetState, journalId: journal?.journalId ?? null },
        }),
      );
      await ports.idempotency.save({
        ...scope,
        fingerprint,
        result,
        createdAt: command.occurredAt,
        expiresAt: expirationFrom(command.occurredAt),
      });
      return result;
    });
  }
}
