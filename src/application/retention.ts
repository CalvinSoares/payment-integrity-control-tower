import type { IdempotencyStore, TransactionRunner } from "./ports.js";

export type RetentionCleanupInput = {
  now?: string;
  limit?: number;
};

export type RetentionCleanupResult = {
  deletedIdempotencyRecords: number;
  executedAt: string;
  limit: number;
};

export class RetentionService {
  public constructor(private readonly transaction: TransactionRunner) {}

  public async cleanupExpiredIdempotency(input: RetentionCleanupInput = {}): Promise<RetentionCleanupResult> {
    const executedAt = input.now ?? new Date().toISOString();
    const limit = input.limit ?? 500;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 10_000) {
      throw new Error("O limite de retenção deve ser um inteiro entre 1 e 10000.");
    }
    const deletedIdempotencyRecords = await this.transaction.run(async (ports) => {
      return ports.idempotency.deleteExpired(executedAt, limit);
    });
    return { deletedIdempotencyRecords, executedAt, limit };
  }
}

export type IdempotencyRetentionStore = Pick<IdempotencyStore, "deleteExpired">;
