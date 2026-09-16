import type { AuditEvent } from "../domain/audit/audit-event.js";
import type { IdempotencyRecord, IdempotencyScope } from "../domain/idempotency/idempotency.js";
import type { LedgerJournal } from "../domain/ledger/ledger.js";
import type { Payment } from "../domain/payments/payment.js";

export type PaymentCoreResult = {
  payment: Payment;
  journal: LedgerJournal | null;
};

export interface PaymentRepository {
  getById(id: string): Promise<Payment | undefined>;
  getByExternalPaymentId(tenantId: string, externalPaymentId: string): Promise<Payment | undefined>;
  insert(payment: Payment): Promise<void>;
  update(payment: Payment): Promise<void>;
}

export interface LedgerRepository {
  append(journal: LedgerJournal): Promise<void>;
  listByReference(referenceType: string, referenceId: string): Promise<LedgerJournal[]>;
}

export interface IdempotencyStore {
  get(scope: IdempotencyScope): Promise<IdempotencyRecord<PaymentCoreResult> | undefined>;
  save(record: IdempotencyRecord<PaymentCoreResult>): Promise<void>;
}

export interface AuditRepository {
  append(event: AuditEvent): Promise<void>;
  listByEntity(entityType: string, entityId: string): Promise<AuditEvent[]>;
}

export interface TransactionRunner {
  run<TResult>(work: (ports: RepositoryPorts) => Promise<TResult>): Promise<TResult>;
}

export type RepositoryPorts = {
  payments: PaymentRepository;
  ledger: LedgerRepository;
  idempotency: IdempotencyStore;
  audit: AuditRepository;
};

export type PaymentCorePorts = RepositoryPorts & {
  transaction: TransactionRunner;
};
