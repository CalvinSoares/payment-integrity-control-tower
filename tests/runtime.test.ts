import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvironment } from "../src/config/env.js";
import { configureHttpServer, postgresPoolOptions } from "../src/config/runtime.js";

const environment = loadEnvironment({
  NODE_ENV: "production",
  CONTROL_TOWER_API_TOKEN: "a".repeat(32),
  DATABASE_URL: "postgresql://integrity:secret@db.internal/payment_integrity",
  CONTROL_TOWER_API_TENANT_ID: "tenant_prod",
  CONTROL_TOWER_API_ACTOR_ID: "operator_prod",
  CONTROL_TOWER_REQUEST_TIMEOUT_MS: "30000",
  CONTROL_TOWER_MAX_BODY_BYTES: "1048576",
  CONTROL_TOWER_DB_POOL_MAX: "20",
});

describe("production runtime", () => {
  let server = createServer();

  afterEach(() => {
    server.close();
    server = createServer();
  });

  it("converts validated configuration into PostgreSQL pool options", () => {
    expect(postgresPoolOptions(environment)).toEqual({
      connectionString: environment.databaseUrl,
      max: 20,
      connectionTimeoutMillis: 30_000,
    });
  });

  it("applies bounded HTTP timeout settings", () => {
    configureHttpServer(server, environment);

    expect(server.requestTimeout).toBe(30_000);
    expect(server.headersTimeout).toBe(35_000);
  });
});
