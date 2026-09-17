export type Environment = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  defaultCurrency: string;
  logLevel: string;
  apiToken: string;
  apiTenantId: string;
  apiActorId: string;
  requestTimeoutMs: number;
  maxBodyBytes: number;
  databasePoolMax: number;
};

function positiveInteger(value: string | undefined, fallback: number, field: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} deve ser um inteiro positivo. Valor recebido: ${value}`);
  }
  return parsed;
}

function requiredProductionValue(source: NodeJS.ProcessEnv, nodeEnv: Environment["nodeEnv"], key: string): string {
  const value = source[key]?.trim() ?? "";
  if (nodeEnv === "production" && value === "") throw new Error(`${key} é obrigatório em produção.`);
  return value;
}

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  const nodeEnv = source.NODE_ENV ?? "development";
  if (nodeEnv !== "development" && nodeEnv !== "test" && nodeEnv !== "production") {
    throw new Error(`NODE_ENV inválido: ${nodeEnv}`);
  }

  const apiToken = requiredProductionValue(source, nodeEnv, "CONTROL_TOWER_API_TOKEN") || "local-dev-token";
  if (nodeEnv === "production" && apiToken.length < 32) throw new Error("CONTROL_TOWER_API_TOKEN deve ter pelo menos 32 caracteres em produção.");
  const databaseUrl = requiredProductionValue(source, nodeEnv, "DATABASE_URL") || "postgresql://integrity:integrity_dev@localhost:5438/payment_integrity";
  const apiTenantId = requiredProductionValue(source, nodeEnv, "CONTROL_TOWER_API_TENANT_ID") || "tenant_local";
  const apiActorId = requiredProductionValue(source, nodeEnv, "CONTROL_TOWER_API_ACTOR_ID") || "operator_local";
  const logLevel = source.APP_LOG_LEVEL ?? "info";
  if (!["debug", "info", "warn", "error"].includes(logLevel)) throw new Error(`APP_LOG_LEVEL inválido: ${logLevel}`);

  return {
    nodeEnv,
    port: positiveInteger(source.CONTROL_TOWER_API_PORT ?? source.PORT, 4100, "PORT"),
    databaseUrl,
    defaultCurrency: source.DEFAULT_CURRENCY ?? "BRL",
    logLevel,
    apiToken,
    apiTenantId,
    apiActorId,
    requestTimeoutMs: positiveInteger(source.CONTROL_TOWER_REQUEST_TIMEOUT_MS, 15_000, "CONTROL_TOWER_REQUEST_TIMEOUT_MS"),
    maxBodyBytes: positiveInteger(source.CONTROL_TOWER_MAX_BODY_BYTES, 2 * 1024 * 1024, "CONTROL_TOWER_MAX_BODY_BYTES"),
    databasePoolMax: positiveInteger(source.CONTROL_TOWER_DB_POOL_MAX, 10, "CONTROL_TOWER_DB_POOL_MAX"),
  };
}
