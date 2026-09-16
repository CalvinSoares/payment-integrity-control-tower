import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { AuditEvent } from "../domain/audit/audit-event.js";
import { PAYMENT_STATES, type Payment, type PaymentState } from "../domain/payments/payment.js";
import type { IdempotencyRecord, IdempotencyScope } from "../domain/idempotency/idempotency.js";
import type { LedgerJournal } from "../domain/ledger/ledger.js";
import type { LedgerLine, LedgerDirection } from "../domain/ledger/ledger.js";
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
import { loadEnvironment } from "../config/env.js";

type PostgresExecutor = Pool | PoolClient;

type PaymentRow = QueryResultRow & {
  id: string;
  tenant_id: string;
  external_payment_id: string;
  amount_minor: string | number;
  currency: string;
  state: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type IdempotencyRow = QueryResultRow & {
  tenant_id: string;
  actor_id: string;
  operation: string;
  idempotency_key: string;
  fingerprint: string;
  result_json: PaymentCoreResult;
  created_at: Date | string;
  expires_at: Date | string;
};

type AuditRow = QueryResultRow & {
  audit_id: string;
  tenant_id: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  source_event_id: string | null;
  occurred_at: Date | string;
  metadata: Record<string, unknown>;
};

type LedgerRow = QueryResultRow & {
  journal_id: string;
  source_event_id: string;
  journal_created_at: Date | string;
  line_id: string;
  account_id: string;
  direction: LedgerDirection;
  amount_minor: string | number;
  currency: string;
  reference_type: string;
  reference_id: string;
};

function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function safeMinorUnits(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field} excede o limite seguro do JavaScript.`);
  return parsed;
}

function mapPayment(row: PaymentRow): Payment {
  if (!PAYMENT_STATES.includes(row.state as PaymentState)) {
    throw new Error(`Estado de pagamento desconhecido: ${row.state}`);
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    externalPaymentId: row.external_payment_id,
    amountMinor: safeMinorUnits(row.amount_minor, "amount_minor"),
    currency: row.currency.trim(),
    state: row.state as PaymentState,
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
  };
}

function mapLedgerJournal(rows: LedgerRow[]): LedgerJournal {
  const first = rows[0];
  if (!first) throw new Error("Não é possível mapear um journal vazio.");
  return {
    journalId: first.journal_id,
    sourceEventId: first.source_event_id,
    createdAt: isoDate(first.journal_created_at),
    lines: rows.map((row): LedgerLine => ({
      lineId: row.line_id,
      accountId: row.account_id,
      direction: row.direction,
      amountMinor: safeMinorUnits(row.amount_minor, "amount_minor"),
      currency: row.currency.trim(),
      referenceType: row.reference_type,
      referenceId: row.reference_id,
    })),
  };
}

export class PostgresPaymentRepository implements PaymentRepository {
  public constructor(private readonly db: PostgresExecutor) {}

  public async getById(id: string): Promise<Payment | undefined> {
    const result = await this.db.query<PaymentRow>(
      `SELECT id, tenant_id, external_payment_id, amount_minor, currency, state, created_at, updated_at
       FROM payments WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapPayment(result.rows[0]) : undefined;
  }

  public async getByExternalPaymentId(tenantId: string, externalPaymentId: string): Promise<Payment | undefined> {
    const result = await this.db.query<PaymentRow>(
      `SELECT id, tenant_id, external_payment_id, amount_minor, currency, state, created_at, updated_at
       FROM payments WHERE tenant_id = $1 AND external_payment_id = $2`,
      [tenantId, externalPaymentId],
    );
    return result.rows[0] ? mapPayment(result.rows[0]) : undefined;
  }

  public async insert(payment: Payment): Promise<void> {
    await this.db.query(
      `INSERT INTO payments
       (id, tenant_id, external_payment_id, amount_minor, currency, state, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        payment.id,
        payment.tenantId,
        payment.externalPaymentId,
        payment.amountMinor,
        payment.currency,
        payment.state,
        payment.createdAt,
        payment.updatedAt,
      ],
    );
  }

  public async update(payment: Payment): Promise<void> {
    const result = await this.db.query(
      `UPDATE payments
       SET state = $2, updated_at = $3
       WHERE id = $1`,
      [payment.id, payment.state, payment.updatedAt],
    );
    if (result.rowCount !== 1) throw new Error(`Pagamento ausente: ${payment.id}`);
  }
}

export class PostgresLedgerRepository implements LedgerRepository {
  public constructor(private readonly db: PostgresExecutor) {}

  public async append(journal: LedgerJournal): Promise<void> {
    await this.db.query(
      `INSERT INTO ledger_journals (journal_id, source_event_id, created_at)
       VALUES ($1, $2, $3)`,
      [journal.journalId, journal.sourceEventId, journal.createdAt],
    );
    for (const line of journal.lines) {
      await this.db.query(
        `INSERT INTO ledger_entries
         (line_id, journal_id, account_id, direction, amount_minor, currency, reference_type, reference_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          line.lineId,
          journal.journalId,
          line.accountId,
          line.direction,
          line.amountMinor,
          line.currency,
          line.referenceType,
          line.referenceId,
        ],
      );
    }
  }

  public async listByReference(referenceType: string, referenceId: string): Promise<LedgerJournal[]> {
    const result = await this.db.query<LedgerRow>(
      `SELECT
         j.journal_id,
         j.source_event_id,
         j.created_at AS journal_created_at,
         e.line_id,
         e.account_id,
         e.direction,
         e.amount_minor,
         e.currency,
         e.reference_type,
         e.reference_id
       FROM ledger_journals j
       INNER JOIN ledger_entries e ON e.journal_id = j.journal_id
       WHERE e.reference_type = $1 AND e.reference_id = $2
       ORDER BY j.created_at, e.line_id`,
      [referenceType, referenceId],
    );
    const grouped = new Map<string, LedgerRow[]>();
    for (const row of result.rows) grouped.set(row.journal_id, [...(grouped.get(row.journal_id) ?? []), row]);
    return [...grouped.values()].map(mapLedgerJournal);
  }
}

export class PostgresIdempotencyStore implements IdempotencyStore {
  public constructor(private readonly db: PostgresExecutor) {}

  public async get(scope: IdempotencyScope): Promise<IdempotencyRecord<PaymentCoreResult> | undefined> {
    const result = await this.db.query<IdempotencyRow>(
      `SELECT tenant_id, actor_id, operation, idempotency_key, fingerprint, result_json, created_at, expires_at
       FROM idempotency_records
       WHERE tenant_id = $1 AND actor_id = $2 AND operation = $3 AND idempotency_key = $4
         AND expires_at > NOW()`,
      [scope.tenantId, scope.actorId, scope.operation, scope.key],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      tenantId: row.tenant_id,
      actorId: row.actor_id,
      operation: row.operation,
      key: row.idempotency_key,
      fingerprint: row.fingerprint,
      result: row.result_json,
      createdAt: isoDate(row.created_at),
      expiresAt: isoDate(row.expires_at),
    };
  }

  public async save(record: IdempotencyRecord<PaymentCoreResult>): Promise<void> {
    await this.db.query(
      `INSERT INTO idempotency_records
       (tenant_id, actor_id, operation, idempotency_key, fingerprint, result_json, status, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'COMPLETED', $7, $8)`,
      [
        record.tenantId,
        record.actorId,
        record.operation,
        record.key,
        record.fingerprint,
        JSON.stringify(record.result),
        record.createdAt,
        record.expiresAt,
      ],
    );
  }
}

export class PostgresAuditRepository implements AuditRepository {
  public constructor(private readonly db: PostgresExecutor) {}

  public async append(event: AuditEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_events
       (audit_id, tenant_id, actor_id, action, entity_type, entity_id, source_event_id, occurred_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        event.auditId,
        event.tenantId,
        event.actorId,
        event.action,
        event.entityType,
        event.entityId,
        event.sourceEventId ?? null,
        event.occurredAt,
        JSON.stringify(event.metadata),
      ],
    );
  }

  public async listByEntity(entityType: string, entityId: string): Promise<AuditEvent[]> {
    const result = await this.db.query<AuditRow>(
      `SELECT audit_id, tenant_id, actor_id, action, entity_type, entity_id, source_event_id, occurred_at, metadata
       FROM audit_events
       WHERE entity_type = $1 AND entity_id = $2
       ORDER BY occurred_at, audit_id`,
      [entityType, entityId],
    );
    return result.rows.map((row) => ({
      auditId: row.audit_id,
      tenantId: row.tenant_id,
      actorId: row.actor_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      ...(row.source_event_id === null ? {} : { sourceEventId: row.source_event_id }),
      occurredAt: isoDate(row.occurred_at),
      metadata: row.metadata,
    }));
  }
}

export function createPostgresRepositoryPorts(db: PostgresExecutor): RepositoryPorts {
  return {
    payments: new PostgresPaymentRepository(db),
    ledger: new PostgresLedgerRepository(db),
    idempotency: new PostgresIdempotencyStore(db),
    audit: new PostgresAuditRepository(db),
  };
}

export class PostgresTransactionRunner implements TransactionRunner {
  public constructor(private readonly pool: Pool) {}

  public async run<TResult>(work: (ports: RepositoryPorts) => Promise<TResult>): Promise<TResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(createPostgresRepositoryPorts(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createPostgresPaymentCore(pool = new Pool({ connectionString: loadEnvironment().databaseUrl })): {
  service: PaymentCoreService;
  pool: Pool;
  ports: PaymentCorePorts;
} {
  const repositoryPorts = createPostgresRepositoryPorts(pool);
  const ports: PaymentCorePorts = {
    ...repositoryPorts,
    transaction: new PostgresTransactionRunner(pool),
  };
  return { service: new PaymentCoreService(ports), pool, ports };
}
