export type SloSnapshot = {
  windowMinutes: number;
  totalRequests: number;
  serverErrors: number;
  latencyP95Ms: number;
  oldestPendingOutboxAgeMs: number;
  deadLetterCount: number;
  oldestOpenExceptionAgeMs: number;
};

export type SloAlert = {
  name: "api_availability" | "api_latency" | "outbox_lag" | "dead_letter_volume" | "exception_age";
  severity: "warning" | "critical";
  value: number;
  threshold: number;
  action: string;
};

export const sloTargets = {
  availabilityPercent: 99.9,
  latencyP95Ms: 500,
  outboxLagMs: 60_000,
  deadLetterCount: 0,
  openExceptionAgeMs: 24 * 60 * 60 * 1000,
} as const;

function availabilityPercent(snapshot: SloSnapshot): number {
  if (snapshot.totalRequests <= 0) return 100;
  return ((snapshot.totalRequests - snapshot.serverErrors) / snapshot.totalRequests) * 100;
}

export function evaluateSlo(snapshot: SloSnapshot): SloAlert[] {
  const alerts: SloAlert[] = [];
  const availability = availabilityPercent(snapshot);
  if (availability < sloTargets.availabilityPercent) {
    alerts.push({ name: "api_availability", severity: availability < 99 ? "critical" : "warning", value: availability, threshold: sloTargets.availabilityPercent, action: "Investigar erros 5xx e verificar /health/ready." });
  }
  if (snapshot.latencyP95Ms > sloTargets.latencyP95Ms) {
    alerts.push({ name: "api_latency", severity: snapshot.latencyP95Ms > 1_000 ? "critical" : "warning", value: snapshot.latencyP95Ms, threshold: sloTargets.latencyP95Ms, action: "Verificar consultas lentas, pool e saturação do banco." });
  }
  if (snapshot.oldestPendingOutboxAgeMs > sloTargets.outboxLagMs) {
    alerts.push({ name: "outbox_lag", severity: snapshot.oldestPendingOutboxAgeMs > 5 * 60_000 ? "critical" : "warning", value: snapshot.oldestPendingOutboxAgeMs, threshold: sloTargets.outboxLagMs, action: "Verificar worker, locks, dependência externa e mensagens PROCESSING expiradas." });
  }
  if (snapshot.deadLetterCount > sloTargets.deadLetterCount) {
    alerts.push({ name: "dead_letter_volume", severity: "critical", value: snapshot.deadLetterCount, threshold: sloTargets.deadLetterCount, action: "Investigar a causa e executar replay somente após validar a evidência." });
  }
  if (snapshot.oldestOpenExceptionAgeMs > sloTargets.openExceptionAgeMs) {
    alerts.push({ name: "exception_age", severity: "warning", value: snapshot.oldestOpenExceptionAgeMs, threshold: sloTargets.openExceptionAgeMs, action: "Atribuir a exceção a um operador e revisar o runbook de resolução." });
  }
  return alerts;
}
