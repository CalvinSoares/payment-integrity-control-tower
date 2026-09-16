import type { IntegrityScenario, ScenarioResult, ScenarioSignal } from "./types.js";

const DELAY_LIMIT_MS = 48 * 60 * 60 * 1000;

function hasDuplicateEvent(scenario: IntegrityScenario): boolean {
  const ids = new Set<string>();
  for (const current of scenario.steps) {
    if (ids.has(current.externalEventId)) return true;
    ids.add(current.externalEventId);
  }
  return false;
}

function hasOutOfOrderEvent(scenario: IntegrityScenario): boolean {
  return scenario.steps.some((current, index) => {
    const previous = scenario.steps[index - 1];
    return previous !== undefined && Date.parse(current.occurredAt) < Date.parse(previous.occurredAt);
  });
}

function hasAmountMismatch(scenario: IntegrityScenario): boolean {
  const captured = scenario.steps.find((current) => current.eventType === "captured");
  const settled = scenario.steps.find((current) => current.eventType === "settled");
  return captured?.amountMinor !== undefined && settled?.amountMinor !== undefined && captured.amountMinor !== settled.amountMinor;
}

function hasDelayedSettlement(scenario: IntegrityScenario): boolean {
  const captured = scenario.steps.find((current) => current.eventType === "captured");
  const settled = scenario.steps.find((current) => current.eventType === "settled");
  if (!captured || !settled) return false;
  return Date.parse(settled.occurredAt) - Date.parse(captured.occurredAt) > DELAY_LIMIT_MS;
}

function hasProviderTimeout(scenario: IntegrityScenario): boolean {
  return scenario.steps.some((current) => current.eventType === "timeout");
}

export function detectSignals(scenario: IntegrityScenario): ScenarioSignal[] {
  const signals: ScenarioSignal[] = [];
  if (hasDuplicateEvent(scenario)) signals.push("DUPLICATE_EVENT");
  if (hasOutOfOrderEvent(scenario)) signals.push("OUT_OF_ORDER");
  if (hasAmountMismatch(scenario)) signals.push("AMOUNT_MISMATCH");
  if (hasDelayedSettlement(scenario)) signals.push("SETTLEMENT_DELAYED");
  if (hasProviderTimeout(scenario)) signals.push("PROVIDER_TIMEOUT");
  return signals;
}

export function evaluateScenario(scenario: IntegrityScenario): ScenarioResult {
  const detectedSignals = detectSignals(scenario);
  const expected = [...scenario.expectedSignals].sort();
  const detected = [...detectedSignals].sort();
  const passed = expected.length === detected.length && expected.every((signal, index) => signal === detected[index]);
  return { scenarioId: scenario.id, detectedSignals, passed };
}
