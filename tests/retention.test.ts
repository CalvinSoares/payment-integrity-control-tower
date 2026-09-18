import { describe, expect, it } from "vitest";
import { createInMemoryPaymentCore } from "../src/adapters/in-memory.js";
import { RetentionService } from "../src/application/retention.js";

describe("idempotency retention", () => {
  it("removes expired idempotency records in bounded batches", async () => {
    const { transaction, idempotency } = createInMemoryPaymentCore();
    await idempotency.save({
      tenantId: "tenant_ops",
      actorId: "actor_ops",
      operation: "payment.create",
      key: "expired",
      fingerprint: "fingerprint",
      result: undefined as never,
      createdAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-01-02T00:00:00Z",
    });
    await idempotency.save({
      tenantId: "tenant_ops",
      actorId: "actor_ops",
      operation: "payment.create",
      key: "active",
      fingerprint: "fingerprint",
      result: undefined as never,
      createdAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-02-01T00:00:00Z",
    });

    const result = await new RetentionService(transaction).cleanupExpiredIdempotency({ now: "2026-01-10T00:00:00Z", limit: 1 });

    expect(result.deletedIdempotencyRecords).toBe(1);
    expect(await idempotency.get({ tenantId: "tenant_ops", actorId: "actor_ops", operation: "payment.create", key: "expired" })).toBeUndefined();
    expect(await idempotency.get({ tenantId: "tenant_ops", actorId: "actor_ops", operation: "payment.create", key: "active" })).toBeDefined();
  });
});
