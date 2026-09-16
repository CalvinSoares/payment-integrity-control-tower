import { createHash } from "node:crypto";
import { DomainError } from "../errors.js";
import { assertMoney } from "../payments/payment.js";

export const PAYMENT_EVENT_TYPES = [
  "payment.authorized",
  "payment.captured",
  "payment.settled",
  "payment.paid_out",
  "payment.canceled",
  "payment.voided",
  "payment.refunded",
  "payment.chargeback",
  "provider.timeout",
] as const;

export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];

export type PaymentEventData = {
  paymentId: string;
  externalPaymentId: string;
  amountMinor?: number;
  currency?: string;
};

export type PaymentEvent = {
  eventId: string;
  eventType: PaymentEventType;
  schemaVersion: 1;
  tenantId: string;
  provider: string;
  providerAccountId: string;
  externalPaymentId: string;
  externalEventId: string;
  occurredAt: string;
  receivedAt: string;
  traceId: string;
  payloadHash: string;
  data: PaymentEventData;
};

function assertText(value: string, field: string): void {
  if (value.trim() === "") throw new DomainError("invalid_event", `${field} é obrigatório.`);
}

function assertDate(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new DomainError("invalid_event_date", `${field} deve ser uma data ISO válida.`);
  }
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  }
  return value;
}

export function hashEventData(data: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(normalize(data))).digest("hex")}`;
}

export function eventDeduplicationKey(event: Pick<PaymentEvent, "provider" | "providerAccountId" | "externalEventId">): string {
  return JSON.stringify([event.provider, event.providerAccountId, event.externalEventId]);
}

export function createPaymentEvent(input: PaymentEvent): PaymentEvent {
  assertText(input.eventId, "eventId");
  assertText(input.eventType, "eventType");
  if (!PAYMENT_EVENT_TYPES.includes(input.eventType)) {
    throw new DomainError("unknown_event_type", `Tipo de evento não suportado: ${input.eventType}`);
  }
  if (input.schemaVersion !== 1) throw new DomainError("unsupported_event_schema", "schemaVersion deve ser 1.");
  assertText(input.tenantId, "tenantId");
  assertText(input.provider, "provider");
  assertText(input.providerAccountId, "providerAccountId");
  assertText(input.externalPaymentId, "externalPaymentId");
  assertText(input.externalEventId, "externalEventId");
  assertText(input.traceId, "traceId");
  assertDate(input.occurredAt, "occurredAt");
  assertDate(input.receivedAt, "receivedAt");
  assertText(input.data.paymentId, "data.paymentId");
  assertText(input.data.externalPaymentId, "data.externalPaymentId");
  if (input.data.amountMinor !== undefined) {
    if (input.data.currency === undefined) throw new DomainError("invalid_event", "currency é obrigatório com amountMinor.");
    assertMoney(input.data.amountMinor, input.data.currency);
  }
  if (input.data.externalPaymentId !== input.externalPaymentId) {
    throw new DomainError("invalid_event", "externalPaymentId do envelope e dos dados deve ser igual.");
  }
  if (input.payloadHash !== hashEventData(input.data)) {
    throw new DomainError("invalid_event_hash", "payloadHash não corresponde aos dados canônicos.");
  }
  return input;
}
