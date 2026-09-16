import { DomainError } from "../errors.js";

export type IdempotencyScope = {
  tenantId: string;
  actorId: string;
  operation: string;
  key: string;
};

export type IdempotencyRecord<TResult> = IdempotencyScope & {
  fingerprint: string;
  result: TResult;
  createdAt: string;
  expiresAt: string;
};

export function idempotencyScopeKey(scope: IdempotencyScope): string {
  return [scope.tenantId, scope.actorId, scope.operation, scope.key].join(":");
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  }
  return value;
}

export function fingerprintCommand(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function assertSameIdempotentCommand<TResult>(record: IdempotencyRecord<TResult>, fingerprint: string): TResult {
  if (record.fingerprint !== fingerprint) {
    throw new DomainError(
      "idempotency_conflict",
      "A chave de idempotência já foi usada com um payload diferente.",
    );
  }
  return record.result;
}
