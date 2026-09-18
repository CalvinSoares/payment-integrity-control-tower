import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPaymentCore } from "../src/adapters/postgres.js";
import { RetentionService } from "../src/application/retention.js";
import { loadEnvironment } from "../src/config/env.js";

const runDbTests = process.env.RUN_DB_TESTS === "1";

describe.skipIf(!runDbTests)("Postgres operations", () => {
  const pool = new Pool({ connectionString: loadEnvironment().databaseUrl });
  const { ports } = createPostgresPaymentCore(pool);

  beforeAll(async () => {
    await pool.query("SELECT 1");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM idempotency_records WHERE idempotency_key LIKE 'retention_test_%'");
    await pool.end();
  });

  it("cleans expired idempotency records without deleting active records", async () => {
    await ports.idempotency.save({
      tenantId: "tenant_retention",
      actorId: "actor_retention",
      operation: "retention.test",
      key: "retention_test_expired",
      fingerprint: "fingerprint",
      result: { payment: { id: "retention-placeholder" } as never, journal: null },
      createdAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-01-02T00:00:00Z",
    });
    await ports.idempotency.save({
      tenantId: "tenant_retention",
      actorId: "actor_retention",
      operation: "retention.test",
      key: "retention_test_active",
      fingerprint: "fingerprint",
      result: { payment: { id: "retention-placeholder" } as never, journal: null },
      createdAt: "2026-01-01T00:00:00Z",
      expiresAt: "2099-02-01T00:00:00Z",
    });

    const result = await new RetentionService(ports.transaction).cleanupExpiredIdempotency({ now: "2026-01-10T00:00:00Z", limit: 10 });

    expect(result.deletedIdempotencyRecords).toBe(1);
    expect(await ports.idempotency.get({ tenantId: "tenant_retention", actorId: "actor_retention", operation: "retention.test", key: "retention_test_expired" })).toBeUndefined();
    expect(await ports.idempotency.get({ tenantId: "tenant_retention", actorId: "actor_retention", operation: "retention.test", key: "retention_test_active" })).toBeDefined();
  });
});
