import type { AuditEvent } from "../domain/audit/audit-event.js";
import { idempotencyScopeKey, type IdempotencyRecord, type IdempotencyScope } from "../domain/idempotency/idempotency.js";
import type { LedgerJournal } from "../domain/ledger/ledger.js";
import type { Payment } from "../domain/payments/payment.js";
import type {
  AuditRepository,
  IdempotencyStore,
  LedgerRepository,
  PaymentCorePorts,
  PaymentCoreResult,
  PaymentRepository,
  TransactionRunner,
} from "../application/ports.js";
import { PaymentCoreService } from "../application/payment-core.js";

export class InMemoryPaymentRepository implements PaymentRepository {
  private readonly items = new Map<string, Payment>();

  public getById(id: string): Payment | undefined {
    return this.items.get(id);
  }

  public getByExternalPaymentId(tenantId: string, externalPaymentId: string): Payment | undefined {
    return [...this.items.values()].find(
      (payment) => payment.tenantId === tenantId && payment.externalPaymentId === externalPaymentId,
    );
  }

  public insert(payment: Payment): void {
    if (this.items.has(payment.id)) throw new Error(`Pagamento duplicado: ${payment.id}`);
    this.items.set(payment.id, payment);
  }

  public update(payment: Payment): void {
    if (!this.items.has(payment.id)) throw new Error(`Pagamento ausente: ${payment.id}`);
    this.items.set(payment.id, payment);
  }
}

export class InMemoryLedgerRepository implements LedgerRepository {
  private readonly items = new Map<string, LedgerJournal>();

  public append(journal: LedgerJournal): void {
    if (this.items.has(journal.journalId)) throw new Error(`Journal duplicado: ${journal.journalId}`);
    this.items.set(journal.journalId, journal);
  }

  public listByReference(referenceType: string, referenceId: string): LedgerJournal[] {
    return [...this.items.values()].filter((journal) =>
      journal.lines.some((line) => line.referenceType === referenceType && line.referenceId === referenceId),
    );
  }

  public get size(): number {
    return this.items.size;
  }
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly items = new Map<string, IdempotencyRecord<PaymentCoreResult>>();

  public get(scope: IdempotencyScope): IdempotencyRecord<PaymentCoreResult> | undefined {
    return this.items.get(idempotencyScopeKey(scope));
  }

  public save(record: IdempotencyRecord<PaymentCoreResult>): void {
    this.items.set(idempotencyScopeKey(record), record);
  }
}

export class InMemoryAuditRepository implements AuditRepository {
  private readonly items: AuditEvent[] = [];

  public append(event: AuditEvent): void {
    this.items.push(event);
  }

  public listByEntity(entityType: string, entityId: string): AuditEvent[] {
    return this.items.filter((event) => event.entityType === entityType && event.entityId === entityId);
  }

  public get size(): number {
    return this.items.length;
  }
}

export class InMemoryTransactionRunner implements TransactionRunner {
  public run<TResult>(work: () => TResult): TResult {
    return work();
  }
}

export function createInMemoryPaymentCore(): {
  service: PaymentCoreService;
  payments: InMemoryPaymentRepository;
  ledger: InMemoryLedgerRepository;
  idempotency: InMemoryIdempotencyStore;
  audit: InMemoryAuditRepository;
} {
  const payments = new InMemoryPaymentRepository();
  const ledger = new InMemoryLedgerRepository();
  const idempotency = new InMemoryIdempotencyStore();
  const audit = new InMemoryAuditRepository();
  const ports: PaymentCorePorts = {
    payments,
    ledger,
    idempotency,
    audit,
    transaction: new InMemoryTransactionRunner(),
  };
  return { service: new PaymentCoreService(ports), payments, ledger, idempotency, audit };
}
