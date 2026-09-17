export type Environment = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  defaultCurrency: string;
  logLevel: string;
  apiToken: string;
  apiTenantId: string;
  apiActorId: string;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`PORT deve ser um inteiro positivo. Valor recebido: ${value}`);
  }
  return parsed;
}

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  const nodeEnv = source.NODE_ENV ?? "development";
  if (nodeEnv !== "development" && nodeEnv !== "test" && nodeEnv !== "production") {
    throw new Error(`NODE_ENV inválido: ${nodeEnv}`);
  }

  const apiToken = source.CONTROL_TOWER_API_TOKEN ?? (nodeEnv === "production" ? "" : "local-dev-token");
  if (nodeEnv === "production" && apiToken.trim() === "") {
    throw new Error("CONTROL_TOWER_API_TOKEN é obrigatório em produção.");
  }

  return {
    nodeEnv,
    port: positiveInteger(source.CONTROL_TOWER_API_PORT ?? source.PORT, 4100),
    databaseUrl: source.DATABASE_URL ?? "postgresql://integrity:integrity_dev@localhost:5438/payment_integrity",
    defaultCurrency: source.DEFAULT_CURRENCY ?? "BRL",
    logLevel: source.APP_LOG_LEVEL ?? "info",
    apiToken,
    apiTenantId: source.CONTROL_TOWER_API_TENANT_ID ?? "tenant_local",
    apiActorId: source.CONTROL_TOWER_API_ACTOR_ID ?? "operator_local",
  };
}
