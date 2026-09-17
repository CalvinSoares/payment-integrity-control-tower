export type HealthResult = {
  status: "ok" | "degraded";
  checks: Record<string, "ok" | "failed">;
};

export interface HealthChecker {
  readiness(): Promise<HealthResult>;
}

export class PostgresHealthChecker implements HealthChecker {
  public constructor(private readonly query: () => Promise<unknown>) {}

  public async readiness(): Promise<HealthResult> {
    try {
      await this.query();
      return { status: "ok", checks: { postgres: "ok" } };
    } catch {
      return { status: "degraded", checks: { postgres: "failed" } };
    }
  }
}
