import type { ControlTowerQueries, ExceptionFilters, PaymentTimeline } from "../application/control-tower.js";
import { PostgresAuditRepository, PostgresLedgerRepository, PostgresPaymentRepository, type PostgresExecutor } from "./postgres.js";
import type { ExceptionCase } from "../domain/reconciliation/reconciliation.js";

type ExceptionRow = {
  exception_id: string;
  tenant_id: string;
  run_id: string;
  item_id: string;
  batch_id: string;
  category: ExceptionCase["category"];
  severity: ExceptionCase["severity"];
  status: ExceptionCase["status"];
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
  if (!Number.isSafeInteger(parsed)) throw new Error("Valor monetário da exceção excede o limite seguro.");
  return parsed;
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

export class PostgresControlTowerQueries implements ControlTowerQueries {
  public constructor(private readonly db: PostgresExecutor) {}

  public async getPaymentTimeline(paymentId: string, tenantId: string): Promise<PaymentTimeline | undefined> {
    const payment = await new PostgresPaymentRepository(this.db).getById(paymentId);
    if (!payment || payment.tenantId !== tenantId) return undefined;
    const [events, audit, ledger, settlementItems, exceptionRows] = await Promise.all([
      this.db.query<{ event_id: string; event_type: string; occurred_at: Date | string; provider: string; status: string }>(
        `SELECT event_id, event_type, (event_json->>'occurredAt')::timestamptz AS occurred_at, provider, status
         FROM event_inbox
         WHERE tenant_id = $1 AND (event_json->'data'->>'paymentId' = $2 OR external_event_id = $3)
         ORDER BY (event_json->>'occurredAt')::timestamptz, event_id`,
        [tenantId, paymentId, paymentId],
      ),
      new PostgresAuditRepository(this.db).listByEntity("Payment", paymentId),
      new PostgresLedgerRepository(this.db).listByReference("Payment", paymentId),
      this.db.query<{ item_id: string; status: string; category: string | null; run_id: string; evidence_json: string[] }>(
        `SELECT item_id, status, category, run_id, evidence_json
         FROM reconciliation_items
         WHERE external_payment_id = $1
         ORDER BY item_id`,
        [payment.externalPaymentId],
      ),
      this.db.query<ExceptionRow>(
        `SELECT exception_id, tenant_id, run_id, item_id, batch_id, category, severity, status,
                expected_minor, observed_minor, difference_minor, currency, evidence_json, rule_version,
                reprocessable, created_at, resolved_at, resolution
         FROM exception_cases
         WHERE tenant_id = $1 AND (item_id IN (
           SELECT item_id FROM reconciliation_items WHERE external_payment_id = $2
         ) OR item_id IN (
           SELECT item_id FROM reconciliation_items WHERE payment_id = $3
         ))
         ORDER BY created_at, exception_id`,
        [tenantId, payment.externalPaymentId, paymentId],
      ),
    ]);
    return {
      payment,
      events: events.rows.map((row) => ({
        eventId: row.event_id,
        eventType: row.event_type,
        occurredAt: isoDate(row.occurred_at),
        provider: row.provider,
        status: row.status,
      })),
      ledger,
      audit: audit.map((event) => ({
        auditId: event.auditId,
        action: event.action,
        actorId: event.actorId,
        occurredAt: event.occurredAt,
        metadata: event.metadata,
      })),
      settlementItems: settlementItems.rows.map((row) => ({
        itemId: row.item_id,
        status: row.status,
        ...(row.category === null ? {} : { category: row.category }),
        runId: row.run_id,
        evidence: row.evidence_json,
      })),
      exceptions: exceptionRows.rows.map(mapException),
    };
  }

  public async getPaymentLedger(paymentId: string, tenantId: string) {
    const payment = await new PostgresPaymentRepository(this.db).getById(paymentId);
    if (!payment || payment.tenantId !== tenantId) return undefined;
    return new PostgresLedgerRepository(this.db).listByReference("Payment", paymentId);
  }

  public async listExceptions(tenantId: string, filters: ExceptionFilters): Promise<ExceptionCase[]> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
    const values: Array<string | number> = [tenantId];
    const conditions = ["tenant_id = $1"];
    if (filters.status !== undefined) {
      values.push(filters.status);
      conditions.push(`status = $${values.length}`);
    }
    if (filters.category !== undefined) {
      values.push(filters.category);
      conditions.push(`category = $${values.length}`);
    }
    values.push(limit);
    const result = await this.db.query<ExceptionRow>(
      `SELECT exception_id, tenant_id, run_id, item_id, batch_id, category, severity, status,
              expected_minor, observed_minor, difference_minor, currency, evidence_json, rule_version,
              reprocessable, created_at, resolved_at, resolution
       FROM exception_cases
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, exception_id DESC
       LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(mapException);
  }
}
