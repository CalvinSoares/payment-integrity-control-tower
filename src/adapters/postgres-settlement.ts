import { Pool, type PoolClient } from "pg";
import type { PaymentRepository } from "../application/ports.js";
import { PostgresAuditRepository } from "./postgres.js";
import type {
  ExceptionRepository,
  ReconciliationRepository,
  SettlementBatchRepository,
  SettlementRepositoryPorts,
  SettlementTransactionRunner,
} from "../application/settlement-ports.js";
import type { ExceptionCase, ReconciliationItem, ReconciliationRun, ExceptionStatus } from "../domain/reconciliation/reconciliation.js";
import type { SettlementBatch, SettlementRow } from "../domain/settlement/settlement.js";
import { loadEnvironment } from "../config/env.js";
import { PostgresPaymentRepository, type PostgresExecutor } from "./postgres.js";

type BatchRow = {
  batch_id: string;
  tenant_id: string;
  provider: string;
  provider_account_id: string;
  file_name: string;
  file_checksum: string;
  period_start: Date | string;
  period_end: Date | string;
  received_at: Date | string;
  rows_json: SettlementRow[];
};

type RunRow = {
  run_id: string;
  tenant_id: string;
  batch_id: string;
  rule_version: string;
  idempotency_key: string;
  status: ReconciliationRun["status"];
  created_at: Date | string;
  completed_at: Date | string;
  item_count: number;
  exception_count: number;
};

type ItemRow = {
  item_id: string;
  run_id: string;
  batch_id: string;
  row_number: number;
  settlement_id: string;
  external_payment_id: string;
  payment_id: string | null;
  status: ReconciliationItem["status"];
  category: NonNullable<ReconciliationItem["category"]> | null;
  severity: NonNullable<ReconciliationItem["severity"]> | null;
  expected_minor: string | number | null;
  observed_minor: string | number | null;
  difference_minor: string | number | null;
  currency: string;
  evidence_json: string[];
  rule_version: string;
};

type ExceptionRow = {
  exception_id: string;
  tenant_id: string;
  run_id: string;
  item_id: string;
  batch_id: string;
  category: ExceptionCase["category"];
  severity: ExceptionCase["severity"];
  status: ExceptionStatus;
  expected_minor: string | number | null;
  observed_minor: string | number | null;
  difference_minor: string | number | null;
  currency: string;
  evidence_json: string[];
  rule_version: string;
  reprocessable: boolean;
  created_at: Date | string;
  resolved_at: Date | string | null;
  resolution: string | null;
};

function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalMinor(value: string | number | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Valor monetário do settlement excede o limite seguro.");
  return parsed;
}

function mapBatch(row: BatchRow): SettlementBatch {
  return {
    batchId: row.batch_id,
    tenantId: row.tenant_id,
    provider: row.provider,
    providerAccountId: row.provider_account_id,
    fileName: row.file_name,
    fileChecksum: row.file_checksum,
    periodStart: isoDate(row.period_start),
    periodEnd: isoDate(row.period_end),
    receivedAt: isoDate(row.received_at),
    rows: row.rows_json,
  };
}

function mapRun(row: RunRow): ReconciliationRun {
  return {
    runId: row.run_id,
    tenantId: row.tenant_id,
    batchId: row.batch_id,
    ruleVersion: row.rule_version,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    createdAt: isoDate(row.created_at),
    completedAt: isoDate(row.completed_at),
    itemCount: row.item_count,
    exceptionCount: row.exception_count,
  };
}

function mapItem(row: ItemRow): ReconciliationItem {
  const expectedMinor = optionalMinor(row.expected_minor);
  const observedMinor = optionalMinor(row.observed_minor);
  const differenceMinor = optionalMinor(row.difference_minor);
  return {
    itemId: row.item_id,
    runId: row.run_id,
    batchId: row.batch_id,
    rowNumber: row.row_number,
    settlementId: row.settlement_id,
    externalPaymentId: row.external_payment_id,
    ...(row.payment_id === null ? {} : { paymentId: row.payment_id }),
    status: row.status,
    ...(row.category === null ? {} : { category: row.category }),
    ...(row.severity === null ? {} : { severity: row.severity }),
    ...(expectedMinor === undefined ? {} : { expectedMinor }),
    ...(observedMinor === undefined ? {} : { observedMinor }),
    ...(differenceMinor === undefined ? {} : { differenceMinor }),
    currency: row.currency.trim(),
    evidence: row.evidence_json,
    ruleVersion: row.rule_version,
  };
}

function mapException(row: ExceptionRow): ExceptionCase {
  const expectedMinor = optionalMinor(row.expected_minor);
  const observedMinor = optionalMinor(row.observed_minor);
  const differenceMinor = optionalMinor(row.difference_minor);
  return {
    exceptionId: row.exception_id,
    tenantId: row.tenant_id,
    runId: row.run_id,
    itemId: row.item_id,
    batchId: row.batch_id,
    category: row.category,
    severity: row.severity,
    status: row.status,
    ...(expectedMinor === undefined ? {} : { expectedMinor }),
    ...(observedMinor === undefined ? {} : { observedMinor }),
    ...(differenceMinor === undefined ? {} : { differenceMinor }),
    currency: row.currency.trim(),
    evidence: row.evidence_json,
    ruleVersion: row.rule_version,
    reprocessable: row.reprocessable,
    createdAt: isoDate(row.created_at),
    ...(row.resolved_at === null ? {} : { resolvedAt: isoDate(row.resolved_at) }),
    ...(row.resolution === null ? {} : { resolution: row.resolution }),
  };
}

export class PostgresSettlementBatchRepository implements SettlementBatchRepository {
  public constructor(private readonly db: PostgresExecutor) {}

  public async getById(batchId: string): Promise<SettlementBatch | undefined> {
    const result = await this.db.query<BatchRow>(
      `SELECT batch_id, tenant_id, provider, provider_account_id, file_name, file_checksum,
              period_start, period_end, received_at, rows_json
       FROM settlement_batches WHERE batch_id = $1`,
      [batchId],
    );
    return result.rows[0] ? mapBatch(result.rows[0]) : undefined;
  }

  public async findByFileKey(fileKey: string): Promise<SettlementBatch | undefined> {
    const result = await this.db.query<BatchRow>(
      `SELECT batch_id, tenant_id, provider, provider_account_id, file_name, file_checksum,
              period_start, period_end, received_at, rows_json
       FROM settlement_batches WHERE file_key = $1`,
      [fileKey],
    );
    return result.rows[0] ? mapBatch(result.rows[0]) : undefined;
  }

  public async insert(batch: SettlementBatch, fileKey: string): Promise<void> {
    await this.db.query(
      `INSERT INTO settlement_batches
       (batch_id, tenant_id, provider, provider_account_id, file_name, file_checksum, file_key,
        period_start, period_end, received_at, rows_json, row_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
      [
        batch.batchId,
        batch.tenantId,
        batch.provider,
        batch.providerAccountId,
        batch.fileName,
        batch.fileChecksum,
        fileKey,
        batch.periodStart,
        batch.periodEnd,
        batch.receivedAt,
        JSON.stringify(batch.rows),
        batch.rows.length,
      ],
    );
  }
}

export class PostgresReconciliationRepository implements ReconciliationRepository {
  public constructor(private readonly db: PostgresExecutor) {}

  public async findRun(batchId: string, ruleVersion: string, idempotencyKey: string): Promise<ReconciliationRun | undefined> {
    const result = await this.db.query<RunRow>(
      `SELECT run_id, tenant_id, batch_id, rule_version, idempotency_key, status, created_at,
              completed_at, item_count, exception_count
       FROM reconciliation_runs
       WHERE batch_id = $1 AND rule_version = $2 AND idempotency_key = $3`,
      [batchId, ruleVersion, idempotencyKey],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : undefined;
  }

  public async insertRun(run: ReconciliationRun): Promise<void> {
    await this.db.query(
      `INSERT INTO reconciliation_runs
       (run_id, tenant_id, batch_id, rule_version, idempotency_key, status, created_at, completed_at, item_count, exception_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [run.runId, run.tenantId, run.batchId, run.ruleVersion, run.idempotencyKey, run.status, run.createdAt, run.completedAt, run.itemCount, run.exceptionCount],
    );
  }

  public async updateRun(run: ReconciliationRun): Promise<void> {
    const result = await this.db.query(
      `UPDATE reconciliation_runs
       SET status = $2, completed_at = $3, item_count = $4, exception_count = $5
       WHERE run_id = $1`,
      [run.runId, run.status, run.completedAt, run.itemCount, run.exceptionCount],
    );
    if (result.rowCount !== 1) throw new Error(`Run de conciliação ausente: ${run.runId}`);
  }

  public async insertItem(item: ReconciliationItem): Promise<void> {
    await this.db.query(
      `INSERT INTO reconciliation_items
       (item_id, run_id, batch_id, row_number, settlement_id, external_payment_id, payment_id, status,
        category, severity, expected_minor, observed_minor, difference_minor, currency, evidence_json, rule_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16)`,
      [
        item.itemId,
        item.runId,
        item.batchId,
        item.rowNumber,
        item.settlementId,
        item.externalPaymentId,
        item.paymentId ?? null,
        item.status,
        item.category ?? null,
        item.severity ?? null,
        item.expectedMinor ?? null,
        item.observedMinor ?? null,
        item.differenceMinor ?? null,
        item.currency,
        JSON.stringify(item.evidence),
        item.ruleVersion,
      ],
    );
  }

  public async listItems(runId: string): Promise<ReconciliationItem[]> {
    const result = await this.db.query<ItemRow>(
      `SELECT item_id, run_id, batch_id, row_number, settlement_id, external_payment_id, payment_id,
              status, category, severity, expected_minor, observed_minor, difference_minor, currency,
              evidence_json, rule_version
       FROM reconciliation_items WHERE run_id = $1 ORDER BY row_number, item_id`,
      [runId],
    );
    return result.rows.map(mapItem);
  }
}

export class PostgresExceptionRepository implements ExceptionRepository {
  public constructor(private readonly db: PostgresExecutor) {}

  public async getById(exceptionId: string): Promise<ExceptionCase | undefined> {
    const result = await this.db.query<ExceptionRow>(
      `SELECT exception_id, tenant_id, run_id, item_id, batch_id, category, severity, status,
              expected_minor, observed_minor, difference_minor, currency, evidence_json, rule_version,
              reprocessable, created_at, resolved_at, resolution
       FROM exception_cases WHERE exception_id = $1`,
      [exceptionId],
    );
    return result.rows[0] ? mapException(result.rows[0]) : undefined;
  }

  public async insert(exception: ExceptionCase): Promise<void> {
    await this.db.query(
      `INSERT INTO exception_cases
       (exception_id, tenant_id, run_id, item_id, batch_id, category, severity, status, expected_minor,
        observed_minor, difference_minor, currency, evidence_json, rule_version, reprocessable, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16)`,
      [
        exception.exceptionId,
        exception.tenantId,
        exception.runId,
        exception.itemId,
        exception.batchId,
        exception.category,
        exception.severity,
        exception.status,
        exception.expectedMinor ?? null,
        exception.observedMinor ?? null,
        exception.differenceMinor ?? null,
        exception.currency,
        JSON.stringify(exception.evidence),
        exception.ruleVersion,
        exception.reprocessable,
        exception.createdAt,
      ],
    );
  }

  public async markReprocessing(exceptionId: string): Promise<void> {
    const result = await this.db.query("UPDATE exception_cases SET status = 'REPROCESSING' WHERE exception_id = $1", [exceptionId]);
    if (result.rowCount !== 1) throw new Error(`Exceção ausente: ${exceptionId}`);
  }

  public async markOpen(exceptionId: string): Promise<void> {
    const result = await this.db.query("UPDATE exception_cases SET status = 'OPEN' WHERE exception_id = $1", [exceptionId]);
    if (result.rowCount !== 1) throw new Error(`Exceção ausente: ${exceptionId}`);
  }

  public async markResolved(exceptionId: string, resolvedAt: string, resolution: string): Promise<void> {
    const result = await this.db.query(
      "UPDATE exception_cases SET status = 'RESOLVED', resolved_at = $2, resolution = $3 WHERE exception_id = $1",
      [exceptionId, resolvedAt, resolution],
    );
    if (result.rowCount !== 1) throw new Error(`Exceção ausente: ${exceptionId}`);
  }

  public async listByRun(runId: string): Promise<ExceptionCase[]> {
    const result = await this.db.query<ExceptionRow>(
      `SELECT exception_id, tenant_id, run_id, item_id, batch_id, category, severity, status,
              expected_minor, observed_minor, difference_minor, currency, evidence_json, rule_version,
              reprocessable, created_at, resolved_at, resolution
       FROM exception_cases WHERE run_id = $1 ORDER BY exception_id`,
      [runId],
    );
    return result.rows.map(mapException);
  }
}

export function createPostgresSettlementRepositoryPorts(db: PostgresExecutor, payments: PaymentRepository): SettlementRepositoryPorts {
  return {
    settlements: new PostgresSettlementBatchRepository(db),
    reconciliation: new PostgresReconciliationRepository(db),
    exceptions: new PostgresExceptionRepository(db),
    payments,
    audit: new PostgresAuditRepository(db),
  };
}

export class PostgresSettlementTransactionRunner implements SettlementTransactionRunner {
  public constructor(private readonly pool: Pool) {}

  public async run<TResult>(work: (ports: SettlementRepositoryPorts) => Promise<TResult>): Promise<TResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const ports = createPostgresSettlementRepositoryPorts(client, new PostgresPaymentRepository(client));
      const result = await work(ports);
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

export function createPostgresSettlementPipeline(pool = new Pool({ connectionString: loadEnvironment().databaseUrl })): {
  transaction: PostgresSettlementTransactionRunner;
  pool: Pool;
} {
  return { transaction: new PostgresSettlementTransactionRunner(pool), pool };
}
