import { describe, expect, it } from "vitest";
import { loadEnvironment } from "../src/config/env.js";

describe("runtime configuration", () => {
  it("keeps local defaults convenient outside production", () => {
    const environment = loadEnvironment({ NODE_ENV: "development" });

    expect(environment.apiToken).toBe("local-dev-token");
    expect(environment.requestTimeoutMs).toBe(15_000);
    expect(environment.maxBodyBytes).toBe(2 * 1024 * 1024);
    expect(environment.databasePoolMax).toBe(10);
  });

  it("fails fast when production secrets and identity are absent", () => {
    expect(() => loadEnvironment({ NODE_ENV: "production" })).toThrow("CONTROL_TOWER_API_TOKEN");
    expect(() => loadEnvironment({ NODE_ENV: "production", CONTROL_TOWER_API_TOKEN: "a".repeat(32) })).toThrow("DATABASE_URL");
  });

  it("accepts an explicit production configuration and rejects weak tokens", () => {
    const source = {
      NODE_ENV: "production",
      CONTROL_TOWER_API_TOKEN: "a".repeat(32),
      DATABASE_URL: "postgresql://integrity:secret@db.internal/payment_integrity",
      CONTROL_TOWER_API_TENANT_ID: "tenant_prod",
      CONTROL_TOWER_API_ACTOR_ID: "operator_prod",
      CONTROL_TOWER_REQUEST_TIMEOUT_MS: "30000",
      CONTROL_TOWER_MAX_BODY_BYTES: "1048576",
      CONTROL_TOWER_DB_POOL_MAX: "20",
    };

    expect(loadEnvironment(source)).toMatchObject({ nodeEnv: "production", requestTimeoutMs: 30_000, maxBodyBytes: 1_048_576, databasePoolMax: 20 });
    expect(() => loadEnvironment({ ...source, CONTROL_TOWER_API_TOKEN: "short" })).toThrow("32 caracteres");
  });
});
