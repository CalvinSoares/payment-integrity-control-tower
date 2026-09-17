import { DomainError } from "../domain/errors.js";
import {
  severityFor,
  type ExceptionCase,
  type ReconciliationCategory,
  type ReconciliationItem,
  type ReconciliationRun,
} from "../domain/reconciliation/reconciliation.js";
import { parseSettlementCsv, settlementFileDeduplicationKey, type SettlementBatch, type SettlementFileInput, type SettlementRow } from "../domain/settlement/settlement.js";
import type { Payment } from "../domain/payments/payment.js";
import type { SettlementRepositoryPorts, SettlementTransactionRunner } from "./settlement-ports.js";

export type SettlementIngestionReceipt = {
  status: "RECEIVED" | "REPLAYED";
  batchId: string;
  rowCount: number;
};

export type ReconciliationResult = {
  run: ReconciliationRun;
  items: ReconciliationItem[];
  exceptions: ExceptionCase[];
};

export type ReprocessResult = ReconciliationResult & { resolved: boolean };

type Issue = {
  category: ReconciliationCategory;
  expectedMinor?: number;
  observedMinor?: number;
  differenceMinor?: number;
};

function evidenceFor(batch: SettlementBatch, row: SettlementRow, payment?: Payment): string[] {
  return [
    `settlement:${batch.batchId}:${row.rowNumber}`,
    `settlement-record:${row.settlementId}`,
    ...(payment === undefined ? [] : [`payment:${payment.id}`]),
  ];
}

function issuesFor(batch: SettlementBatch, row: SettlementRow, payment: Payment | undefined, seenSettlementIds: Set<string>, seenPaymentIds: Set<string>): Issue[] {
  if (seenSettlementIds.has(row.settlementId) || seenPaymentIds.has(row.externalPaymentId)) {
    return [{ category: "DUPLICATE_SETTLEMENT", observedMinor: row.grossAmountMinor, differenceMinor: 0 }];
  }
  seenSettlementIds.add(row.settlementId);
  seenPaymentIds.add(row.externalPaymentId);
  if (!payment) return [{ category: "MISSING_PAYMENT", observedMinor: row.grossAmountMinor }];
  const issues: Issue[] = [];
  if (payment.amountMinor !== row.grossAmountMinor) {
    issues.push({
      category: "AMOUNT_MISMATCH",
      expectedMinor: payment.amountMinor,
      observedMinor: row.grossAmountMinor,
      differenceMinor: row.grossAmountMinor - payment.amountMinor,
    });
  }
  if (row.netAmountMinor + row.feeAmountMinor !== row.grossAmountMinor) {
    issues.push({
      category: "FEE_MISMATCH",
      expectedMinor: row.grossAmountMinor,
      observedMinor: row.netAmountMinor + row.feeAmountMinor,
      differenceMinor: row.netAmountMinor + row.feeAmountMinor - row.grossAmountMinor,
    });
  }
  if (Date.parse(row.settledAt) - Date.parse(payment.updatedAt) > 48 * 60 * 60 * 1000) {
    issues.push({ category: "SETTLEMENT_DELAYED", differenceMinor: 0 });
  }
  return issues;
}

export class SettlementIngestionService {
  public constructor(private readonly transaction: SettlementTransactionRunner) {}

  public async receiveCsv(input: SettlementFileInput): Promise<SettlementIngestionReceipt> {
    const batch = parseSettlementCsv(input);
    const fileKey = settlementFileDeduplicationKey({ ...input, fileChecksum: batch.fileChecksum });
    return this.transaction.run(async (ports) => {
      const existing = await ports.settlements.findByFileKey(fileKey);
      if (existing) return { status: "REPLAYED", batchId: existing.batchId, rowCount: existing.rows.length };
      await ports.settlements.insert(batch, fileKey);
      return { status: "RECEIVED", batchId: batch.batchId, rowCount: batch.rows.length };
    });
  }
}

export class ReconciliationService {
  public constructor(private readonly transaction: SettlementTransactionRunner) {}

  public async reconcile(command: {
    batchId: string;
    tenantId: string;
    ruleVersion: string;
    idempotencyKey: string;
    requestedAt: string;
  }): Promise<ReconciliationResult> {
    return this.transaction.run((ports) => this.reconcileWithPorts(ports, command));
  }

  public async reprocessException(command: {
    exceptionId: string;
    actorId: string;
    requestedAt: string;
  }): Promise<ReprocessResult> {
    return this.transaction.run(async (ports) => {
      const exception = await ports.exceptions.getById(command.exceptionId);
      if (!exception) throw new DomainError("exception_not_found", "Exceção não encontrada.");
      if (!exception.reprocessable) throw new DomainError("exception_not_reprocessable", "Exceção não pode ser reprocessada.");
      await ports.exceptions.markReprocessing(exception.exceptionId);
      const result = await this.reconcileWithPorts(ports, {
        batchId: exception.batchId,
        tenantId: exception.tenantId,
        ruleVersion: exception.ruleVersion,
        idempotencyKey: `reprocess:${exception.exceptionId}:${command.requestedAt}`,
        requestedAt: command.requestedAt,
      });
      const exceptionLocation = exception.itemId.split(":").slice(-2).join(":");
      const remainsOpen = result.exceptions.some(
        (current) => current.category === exception.category && current.itemId.endsWith(`:${exceptionLocation}`),
      );
      if (remainsOpen) await ports.exceptions.markOpen(exception.exceptionId);
      else await ports.exceptions.markResolved(exception.exceptionId, command.requestedAt, `Reprocessado por ${command.actorId}.`);
      await ports.audit.append({
        auditId: `audit:exception-reprocess:${exception.exceptionId}:${command.requestedAt}`,
        tenantId: exception.tenantId,
        actorId: command.actorId,
        action: "EXCEPTION_REPROCESSED",
        entityType: "ExceptionCase",
        entityId: exception.exceptionId,
        occurredAt: command.requestedAt,
        metadata: { newRunId: result.run.runId, resolved: !remainsOpen, category: exception.category },
      });
      return { ...result, resolved: !remainsOpen };
    });
  }

  private async reconcileWithPorts(
    ports: SettlementRepositoryPorts,
    command: { batchId: string; tenantId: string; ruleVersion: string; idempotencyKey: string; requestedAt: string },
  ): Promise<ReconciliationResult> {
    const existing = await ports.reconciliation.findRun(command.batchId, command.ruleVersion, command.idempotencyKey);
    if (existing) {
      const items = await ports.reconciliation.listItems(existing.runId);
      const exceptions = await ports.exceptions.listByRun(existing.runId);
      return { run: existing, items, exceptions };
    }
    const batch = await ports.settlements.getById(command.batchId);
    if (!batch || batch.tenantId !== command.tenantId) throw new DomainError("settlement_batch_not_found", "Lote de settlement não encontrado.");
    const runId = `recon:${batch.batchId}:${command.ruleVersion}:${command.idempotencyKey}`;
    const startedRun: ReconciliationRun = {
      runId,
      tenantId: batch.tenantId,
      batchId: batch.batchId,
      ruleVersion: command.ruleVersion,
      idempotencyKey: command.idempotencyKey,
      status: "COMPLETED",
      createdAt: command.requestedAt,
      completedAt: command.requestedAt,
      itemCount: 0,
      exceptionCount: 0,
    };
    await ports.reconciliation.insertRun(startedRun);
    const items: ReconciliationItem[] = [];
    const exceptions: ExceptionCase[] = [];
    const seenSettlementIds = new Set<string>();
    const seenPaymentIds = new Set<string>();
    for (const row of batch.rows) {
      const payment = await ports.payments.getByExternalPaymentId(batch.tenantId, row.externalPaymentId);
      const issues = issuesFor(batch, row, payment, seenSettlementIds, seenPaymentIds);
      if (issues.length === 0) {
        const item: ReconciliationItem = {
          itemId: `${runId}:${row.rowNumber}:MATCHED`,
          runId,
          batchId: batch.batchId,
          rowNumber: row.rowNumber,
          settlementId: row.settlementId,
          externalPaymentId: row.externalPaymentId,
          ...(payment === undefined ? {} : { paymentId: payment.id }),
          status: "MATCHED",
          currency: row.currency,
          evidence: evidenceFor(batch, row, payment),
          ruleVersion: command.ruleVersion,
        };
        items.push(item);
        await ports.reconciliation.insertItem(item);
        continue;
      }
      for (const issue of issues) {
        const itemId = `${runId}:${row.rowNumber}:${issue.category}`;
        const item: ReconciliationItem = {
          itemId,
          runId,
          batchId: batch.batchId,
          rowNumber: row.rowNumber,
          settlementId: row.settlementId,
          externalPaymentId: row.externalPaymentId,
          ...(payment === undefined ? {} : { paymentId: payment.id }),
          status: "EXCEPTION",
          category: issue.category,
          severity: severityFor(issue.category),
          ...(issue.expectedMinor === undefined ? {} : { expectedMinor: issue.expectedMinor }),
          ...(issue.observedMinor === undefined ? {} : { observedMinor: issue.observedMinor }),
          ...(issue.differenceMinor === undefined ? {} : { differenceMinor: issue.differenceMinor }),
          currency: row.currency,
          evidence: evidenceFor(batch, row, payment),
          ruleVersion: command.ruleVersion,
        };
        const exception: ExceptionCase = {
          exceptionId: `exception:${itemId}`,
          tenantId: batch.tenantId,
          runId,
          itemId,
          batchId: batch.batchId,
          category: issue.category,
          severity: severityFor(issue.category),
          status: "OPEN",
          ...(issue.expectedMinor === undefined ? {} : { expectedMinor: issue.expectedMinor }),
          ...(issue.observedMinor === undefined ? {} : { observedMinor: issue.observedMinor }),
          ...(issue.differenceMinor === undefined ? {} : { differenceMinor: issue.differenceMinor }),
          currency: row.currency,
          evidence: item.evidence,
          ruleVersion: command.ruleVersion,
          reprocessable: true,
          createdAt: command.requestedAt,
        };
        items.push(item);
        exceptions.push(exception);
        await ports.reconciliation.insertItem(item);
        await ports.exceptions.insert(exception);
      }
    }
    const run: ReconciliationRun = {
      runId,
      tenantId: batch.tenantId,
      batchId: batch.batchId,
      ruleVersion: command.ruleVersion,
      idempotencyKey: command.idempotencyKey,
      status: exceptions.length === 0 ? "COMPLETED" : "EXCEPTION",
      createdAt: command.requestedAt,
      completedAt: command.requestedAt,
      itemCount: items.length,
      exceptionCount: exceptions.length,
    };
    await ports.reconciliation.updateRun(run);
    return { run, items, exceptions };
  }
}
