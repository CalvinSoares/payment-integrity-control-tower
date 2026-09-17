import type { Server } from "node:http";
import type { Environment } from "./env.js";

export function postgresPoolOptions(environment: Environment): {
  connectionString: string;
  max: number;
  connectionTimeoutMillis: number;
} {
  return {
    connectionString: environment.databaseUrl,
    max: environment.databasePoolMax,
    connectionTimeoutMillis: environment.requestTimeoutMs,
  };
}

export function configureHttpServer(server: Server, environment: Environment): void {
  server.requestTimeout = environment.requestTimeoutMs;
  server.headersTimeout = Math.min(environment.requestTimeoutMs + 5_000, 120_000);
}
