import type { PaymentRepository } from "../application/ports.js";
import type {
  ExceptionRepository,
  ReconciliationRepository,
  SettlementBatchRepository,
  SettlementRepositoryPorts,
  SettlementTransactionRunner,
} from "../application/settlement-ports.js";
import type { ExceptionCase, ReconciliationItem, ReconciliationRun } from "../domain/reconciliation/reconciliation.js";
import type { SettlementBatch } from "../domain/settlement/settlement.js";

export class InMemorySettlementBatchRepository implements SettlementBatchRepository {
  private readonly batches = new Map<string, SettlementBatch>();
  private readonly keys = new Map<string, string>();

  public async getById(batchId: string): Promise<SettlementBatch | undefined> {
    return this.batches.get(batchId);
  }

  public async findByFileKey(fileKey: string): Promise<SettlementBatch | undefined> {
    const batchId = this.keys.get(fileKey);
    return batchId === undefined ? undefined : this.batches.get(batchId);
  }

  public async insert(batch: SettlementBatch, fileKey: string): Promise<void> {
    if (this.batches.has(batch.batchId) || this.keys.has(fileKey)) throw new Error("Lote de settlement duplicado.");
    this.batches.set(batch.batchId, batch);
    this.keys.set(fileKey, batch.batchId);
  }
}

export class InMemoryReconciliationRepository implements ReconciliationRepository {
  private readonly runs = new Map<string, ReconciliationRun>();
  private readonly items = new Map<string, ReconciliationItem>();

  public async findRun(batchId: string, ruleVersion: string, idempotencyKey: string): Promise<ReconciliationRun | undefined> {
    return [...this.runs.values()].find(
      (run) => run.batchId === batchId && run.ruleVersion === ruleVersion && run.idempotencyKey === idempotencyKey,
    );
  }

  public async insertRun(run: ReconciliationRun): Promise<void> {
    if (this.runs.has(run.runId)) throw new Error(`Run de conciliação duplicado: ${run.runId}`);
    this.runs.set(run.runId, run);
  }

  public async updateRun(run: ReconciliationRun): Promise<void> {
    if (!this.runs.has(run.runId)) throw new Error(`Run de conciliação ausente: ${run.runId}`);
    this.runs.set(run.runId, run);
  }

  public async insertItem(item: ReconciliationItem): Promise<void> {
    if (this.items.has(item.itemId)) throw new Error(`Item de conciliação duplicado: ${item.itemId}`);
    this.items.set(item.itemId, item);
  }

  public async listItems(runId: string): Promise<ReconciliationItem[]> {
    return [...this.items.values()].filter((item) => item.runId === runId);
  }
}

export class InMemoryExceptionRepository implements ExceptionRepository {
  private readonly items = new Map<string, ExceptionCase>();

  public async getById(exceptionId: string): Promise<ExceptionCase | undefined> {
    return this.items.get(exceptionId);
  }

  public async insert(exception: ExceptionCase): Promise<void> {
    if (this.items.has(exception.exceptionId)) throw new Error(`Exceção duplicada: ${exception.exceptionId}`);
    this.items.set(exception.exceptionId, exception);
  }

  public async markReprocessing(exceptionId: string): Promise<void> {
    const current = this.items.get(exceptionId);
    if (!current) throw new Error(`Exceção ausente: ${exceptionId}`);
    this.items.set(exceptionId, { ...current, status: "REPROCESSING" });
  }

  public async markOpen(exceptionId: string): Promise<void> {
    const current = this.items.get(exceptionId);
    if (!current) throw new Error(`Exceção ausente: ${exceptionId}`);
    this.items.set(exceptionId, { ...current, status: "OPEN" });
  }

  public async markResolved(exceptionId: string, resolvedAt: string, resolution: string): Promise<void> {
    const current = this.items.get(exceptionId);
    if (!current) throw new Error(`Exceção ausente: ${exceptionId}`);
    this.items.set(exceptionId, { ...current, status: "RESOLVED", resolvedAt, resolution });
  }

  public async listByRun(runId: string): Promise<ExceptionCase[]> {
    return [...this.items.values()].filter((item) => item.runId === runId);
  }
}

export class InMemorySettlementTransactionRunner implements SettlementTransactionRunner {
  public constructor(private readonly ports: SettlementRepositoryPorts) {}

  public async run<TResult>(work: (ports: SettlementRepositoryPorts) => Promise<TResult>): Promise<TResult> {
    return work(this.ports);
  }
}

export function createInMemorySettlementPipeline(payments: PaymentRepository): {
  transaction: InMemorySettlementTransactionRunner;
  settlements: InMemorySettlementBatchRepository;
  reconciliation: InMemoryReconciliationRepository;
  exceptions: InMemoryExceptionRepository;
} {
  const settlements = new InMemorySettlementBatchRepository();
  const reconciliation = new InMemoryReconciliationRepository();
  const exceptions = new InMemoryExceptionRepository();
  const ports: SettlementRepositoryPorts = { settlements, reconciliation, exceptions, payments };
  return {
    transaction: new InMemorySettlementTransactionRunner(ports),
    settlements,
    reconciliation,
    exceptions,
  };
}
