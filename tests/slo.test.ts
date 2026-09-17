import { describe, expect, it } from "vitest";
import { evaluateSlo } from "../src/observability/slo.js";

const healthy = {
  windowMinutes: 60,
  totalRequests: 10_000,
  serverErrors: 5,
  latencyP95Ms: 250,
  oldestPendingOutboxAgeMs: 5_000,
  deadLetterCount: 0,
  oldestOpenExceptionAgeMs: 60 * 60 * 1000,
};

describe("SLO evaluation", () => {
  it("does not alert for a healthy window", () => {
    expect(evaluateSlo(healthy)).toEqual([]);
  });

  it("raises actionable alerts when operational limits are exceeded", () => {
    const alerts = evaluateSlo({ ...healthy, serverErrors: 200, latencyP95Ms: 1_200, oldestPendingOutboxAgeMs: 10 * 60_000, deadLetterCount: 2, oldestOpenExceptionAgeMs: 48 * 60 * 60 * 1000 });

    expect(alerts.map((alert) => alert.name)).toEqual(["api_availability", "api_latency", "outbox_lag", "dead_letter_volume", "exception_age"]);
    expect(alerts.find((alert) => alert.name === "dead_letter_volume")?.severity).toBe("critical");
  });
});
