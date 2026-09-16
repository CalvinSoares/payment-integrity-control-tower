import type { AuditEvent } from "../domain/audit/audit-event.js";
import type { IdempotencyRecord, IdempotencyScope } from "../domain/idempotency/idempotency.js";
import type { LedgerJournal } from "../domain/ledger/ledger.js";
import type { Payment } from "../domain/payments/payment.js";

export type PaymentCoreResult = {
  payment: Payment;
  journal: LedgerJournal | null;
};

export interface PaymentRepository {
  getById(id: string): Payment | undefined;
  getByExternalPaymentId(tenantId: string, externalPaymentId: string): Payment | undefined;
  insert(payment: Payment): void;
  update(payment: Payment): void;
}

export interface LedgerRepository {
  append(journal: LedgerJournal): void;
  listByReference(referenceType: string, referenceId: string): LedgerJournal[];
}

export interface IdempotencyStore {
  get(scope: IdempotencyScope): IdempotencyRecord<PaymentCoreResult> | undefined;
  save(record: IdempotencyRecord<PaymentCoreResult>): void;
}

export interface AuditRepository {
  append(event: AuditEvent): void;
  listByEntity(entityType: string, entityId: string): AuditEvent[];
}

export interface TransactionRunner {
  run<TResult>(work: () => TResult): TResult;
}

export type PaymentCorePorts = {
  payments: PaymentRepository;
  ledger: LedgerRepository;
  idempotency: IdempotencyStore;
  audit: AuditRepository;
  transaction: TransactionRunner;
};
