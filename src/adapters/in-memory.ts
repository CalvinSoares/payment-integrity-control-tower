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
  RepositoryPorts,
  TransactionRunner,
} from "../application/ports.js";
import { PaymentCoreService } from "../application/payment-core.js";

export class InMemoryPaymentRepository implements PaymentRepository {
  private readonly items = new Map<string, Payment>();

  public async getById(id: string): Promise<Payment | undefined> {
    return this.items.get(id);
  }

  public async getByExternalPaymentId(tenantId: string, externalPaymentId: string): Promise<Payment | undefined> {
    return [...this.items.values()].find(
      (payment) => payment.tenantId === tenantId && payment.externalPaymentId === externalPaymentId,
    );
  }

  public async insert(payment: Payment): Promise<void> {
    if (this.items.has(payment.id)) throw new Error(`Pagamento duplicado: ${payment.id}`);
    this.items.set(payment.id, payment);
  }

  public async update(payment: Payment): Promise<void> {
    if (!this.items.has(payment.id)) throw new Error(`Pagamento ausente: ${payment.id}`);
    this.items.set(payment.id, payment);
  }
}

export class InMemoryLedgerRepository implements LedgerRepository {
  private readonly items = new Map<string, LedgerJournal>();

  public async append(journal: LedgerJournal): Promise<void> {
    if (this.items.has(journal.journalId)) throw new Error(`Journal duplicado: ${journal.journalId}`);
    this.items.set(journal.journalId, journal);
  }

  public async listByReference(referenceType: string, referenceId: string): Promise<LedgerJournal[]> {
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

  public async get(scope: IdempotencyScope): Promise<IdempotencyRecord<PaymentCoreResult> | undefined> {
    return this.items.get(idempotencyScopeKey(scope));
  }

  public async save(record: IdempotencyRecord<PaymentCoreResult>): Promise<void> {
    this.items.set(idempotencyScopeKey(record), record);
  }
}

export class InMemoryAuditRepository implements AuditRepository {
  private readonly items: AuditEvent[] = [];

  public async append(event: AuditEvent): Promise<void> {
    this.items.push(event);
  }

  public async listByEntity(entityType: string, entityId: string): Promise<AuditEvent[]> {
    return this.items.filter((event) => event.entityType === entityType && event.entityId === entityId);
  }

  public get size(): number {
    return this.items.length;
  }
}

export class InMemoryTransactionRunner implements TransactionRunner {
  public constructor(private readonly ports: RepositoryPorts) {}

  public async run<TResult>(work: (ports: RepositoryPorts) => Promise<TResult>): Promise<TResult> {
    return work(this.ports);
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
  const repositoryPorts: RepositoryPorts = {
    payments,
    ledger,
    idempotency,
    audit,
  };
  const ports: PaymentCorePorts = {
    ...repositoryPorts,
    transaction: new InMemoryTransactionRunner(repositoryPorts),
  };
  return { service: new PaymentCoreService(ports), payments, ledger, idempotency, audit };
}
