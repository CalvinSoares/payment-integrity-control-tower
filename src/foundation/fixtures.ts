import type { IntegrityScenario } from "./types.js";

const step = (
  eventType: IntegrityScenario["steps"][number]["eventType"],
  externalEventId: string,
  occurredAt: string,
  amountMinor?: number,
): IntegrityScenario["steps"][number] => ({
  eventType,
  externalEventId,
  occurredAt,
  ...(amountMinor === undefined ? {} : { amountMinor }),
  currency: "BRL",
  provider: "simulator",
});

export const foundationScenarios: IntegrityScenario[] = [
  {
    id: "happy-path",
    title: "Ciclo íntegro",
    description: "Autorização, captura, liquidação e repasse com o mesmo valor.",
    steps: [
      step("authorized", "evt-auth-001", "2026-01-10T10:00:00Z", 10000),
      step("captured", "evt-cap-001", "2026-01-10T10:01:00Z", 10000),
      step("settled", "evt-set-001", "2026-01-11T10:00:00Z", 10000),
      step("paid_out", "evt-pay-001", "2026-01-12T10:00:00Z", 10000),
    ],
    expectedSignals: [],
  },
  {
    id: "duplicate-event",
    title: "Evento duplicado",
    description: "O mesmo evento de captura é recebido duas vezes.",
    steps: [
      step("captured", "evt-cap-dup", "2026-01-10T10:01:00Z", 10000),
      step("captured", "evt-cap-dup", "2026-01-10T10:01:00Z", 10000),
    ],
    expectedSignals: ["DUPLICATE_EVENT"],
  },
  {
    id: "out-of-order",
    title: "Evento fora de ordem",
    description: "A liquidação chega com horário anterior à captura.",
    steps: [
      step("captured", "evt-cap-order", "2026-01-10T10:01:00Z", 10000),
      step("settled", "evt-set-order", "2026-01-10T09:59:00Z", 10000),
    ],
    expectedSignals: ["OUT_OF_ORDER"],
  },
  {
    id: "amount-mismatch",
    title: "Valor divergente",
    description: "A liquidação informa valor menor que o capturado.",
    steps: [
      step("captured", "evt-cap-amount", "2026-01-10T10:01:00Z", 10000),
      step("settled", "evt-set-amount", "2026-01-11T10:00:00Z", 9800),
    ],
    expectedSignals: ["AMOUNT_MISMATCH"],
  },
  {
    id: "delayed-settlement",
    title: "Liquidação atrasada",
    description: "A liquidação ocorre mais de 48 horas depois da captura.",
    steps: [
      step("captured", "evt-cap-delay", "2026-01-10T10:01:00Z", 10000),
      step("settled", "evt-set-delay", "2026-01-13T10:02:00Z", 10000),
    ],
    expectedSignals: ["SETTLEMENT_DELAYED"],
  },
  {
    id: "provider-timeout",
    title: "Timeout do provedor",
    description: "A consulta externa não retorna confirmação dentro do prazo.",
    steps: [step("timeout", "attempt-timeout-001", "2026-01-10T10:05:00Z")],
    expectedSignals: ["PROVIDER_TIMEOUT"],
  },
];
