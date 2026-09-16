export type ProviderKind = "acquirer" | "gateway" | "bank" | "scheme" | "processor" | "simulator";

export type ScenarioSignal =
  | "DUPLICATE_EVENT"
  | "OUT_OF_ORDER"
  | "AMOUNT_MISMATCH"
  | "SETTLEMENT_DELAYED"
  | "PROVIDER_TIMEOUT";

export type ScenarioStep = {
  eventType: "authorized" | "captured" | "settled" | "paid_out" | "timeout";
  externalEventId: string;
  occurredAt: string;
  amountMinor?: number;
  currency?: string;
  provider: ProviderKind;
};

export type IntegrityScenario = {
  id: string;
  title: string;
  description: string;
  steps: ScenarioStep[];
  expectedSignals: ScenarioSignal[];
};

export type ScenarioResult = {
  scenarioId: string;
  detectedSignals: ScenarioSignal[];
  passed: boolean;
};
