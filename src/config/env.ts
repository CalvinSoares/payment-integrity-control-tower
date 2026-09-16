export type Environment = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  defaultCurrency: string;
  logLevel: string;
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

  return {
    nodeEnv,
    port: positiveInteger(source.PORT, 4100),
    databaseUrl: source.DATABASE_URL ?? "postgresql://integrity:integrity_dev@localhost:5438/payment_integrity",
    defaultCurrency: source.DEFAULT_CURRENCY ?? "BRL",
    logLevel: source.APP_LOG_LEVEL ?? "info",
  };
}
