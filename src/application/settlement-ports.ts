import type { PaymentRepository } from "./ports.js";
import type { AuditRepository } from "./ports.js";
import type { ExceptionCase, ReconciliationItem, ReconciliationRun } from "../domain/reconciliation/reconciliation.js";
import type { SettlementBatch } from "../domain/settlement/settlement.js";

export interface SettlementBatchRepository {
  getById(batchId: string): Promise<SettlementBatch | undefined>;
  findByFileKey(fileKey: string): Promise<SettlementBatch | undefined>;
  insert(batch: SettlementBatch, fileKey: string): Promise<void>;
}

export interface ReconciliationRepository {
  findRun(batchId: string, ruleVersion: string, idempotencyKey: string): Promise<ReconciliationRun | undefined>;
  insertRun(run: ReconciliationRun): Promise<void>;
  updateRun(run: ReconciliationRun): Promise<void>;
  insertItem(item: ReconciliationItem): Promise<void>;
  listItems(runId: string): Promise<ReconciliationItem[]>;
}

export interface ExceptionRepository {
  getById(exceptionId: string): Promise<ExceptionCase | undefined>;
  insert(exception: ExceptionCase): Promise<void>;
  markReprocessing(exceptionId: string): Promise<void>;
  markOpen(exceptionId: string): Promise<void>;
  markResolved(exceptionId: string, resolvedAt: string, resolution: string): Promise<void>;
  listByRun(runId: string): Promise<ExceptionCase[]>;
}

export type SettlementRepositoryPorts = {
  settlements: SettlementBatchRepository;
  reconciliation: ReconciliationRepository;
  exceptions: ExceptionRepository;
  payments: PaymentRepository;
  audit: AuditRepository;
};

export interface SettlementTransactionRunner {
  run<TResult>(work: (ports: SettlementRepositoryPorts) => Promise<TResult>): Promise<TResult>;
}
