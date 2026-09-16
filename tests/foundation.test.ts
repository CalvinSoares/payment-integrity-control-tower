import { describe, expect, it } from "vitest";
import { foundationScenarios } from "../src/foundation/fixtures.js";
import { detectSignals, evaluateScenario } from "../src/foundation/scenario-checker.js";

describe("foundation scenarios", () => {
  it("passes every deterministic scenario", () => {
    expect(foundationScenarios.map(evaluateScenario).every((result) => result.passed)).toBe(true);
  });

  it("does not create a signal for the happy path", () => {
    const scenario = foundationScenarios.find((item) => item.id === "happy-path");
    expect(scenario).toBeDefined();
    expect(detectSignals(scenario!)).toEqual([]);
  });

  it("detects duplicate events before financial processing", () => {
    const scenario = foundationScenarios.find((item) => item.id === "duplicate-event");
    expect(scenario).toBeDefined();
    expect(detectSignals(scenario!)).toContain("DUPLICATE_EVENT");
  });

  it("keeps money in minor units in the fixtures", () => {
    const scenario = foundationScenarios.find((item) => item.id === "amount-mismatch");
    expect(scenario?.steps[0]?.amountMinor).toBe(10000);
    expect(scenario?.steps[1]?.amountMinor).toBe(9800);
  });
});
