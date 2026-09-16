import { DomainError } from "../errors.js";

export const PAYMENT_STATES = [
  "CREATED",
  "AUTHORIZED",
  "CAPTURED",
  "SETTLED",
  "PAID_OUT",
  "CANCELED",
  "VOIDED",
  "REFUNDED",
  "CHARGEBACK",
] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];

export type Payment = {
  id: string;
  tenantId: string;
  externalPaymentId: string;
  amountMinor: number;
  currency: string;
  state: PaymentState;
  createdAt: string;
  updatedAt: string;
};

export type CreatePaymentInput = {
  id: string;
  tenantId: string;
  externalPaymentId: string;
  amountMinor: number;
  currency: string;
  occurredAt: string;
};

const TRANSITIONS: Record<PaymentState, readonly PaymentState[]> = {
  CREATED: ["AUTHORIZED", "CANCELED"],
  AUTHORIZED: ["CAPTURED", "VOIDED", "CANCELED"],
  CAPTURED: ["SETTLED", "REFUNDED", "CHARGEBACK"],
  SETTLED: ["PAID_OUT", "REFUNDED", "CHARGEBACK"],
  PAID_OUT: ["REFUNDED", "CHARGEBACK"],
  CANCELED: [],
  VOIDED: [],
  REFUNDED: [],
  CHARGEBACK: [],
};

export function assertMoney(amountMinor: number, currency: string): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new DomainError("invalid_amount", "amountMinor deve ser um inteiro seguro maior que zero.");
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new DomainError("invalid_currency", "currency deve usar um código ISO 4217 de três letras.");
  }
}

function assertRequired(value: string, field: string): void {
  if (value.trim() === "") {
    throw new DomainError("invalid_payment", `${field} é obrigatório.`);
  }
}

function assertIsoDate(value: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new DomainError("invalid_date", "occurredAt deve ser uma data ISO válida.");
  }
}

export function createPayment(input: CreatePaymentInput): Payment {
  assertRequired(input.id, "id");
  assertRequired(input.tenantId, "tenantId");
  assertRequired(input.externalPaymentId, "externalPaymentId");
  assertMoney(input.amountMinor, input.currency);
  assertIsoDate(input.occurredAt);

  return {
    id: input.id,
    tenantId: input.tenantId,
    externalPaymentId: input.externalPaymentId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    state: "CREATED",
    createdAt: input.occurredAt,
    updatedAt: input.occurredAt,
  };
}

export function canTransitionPayment(from: PaymentState, to: PaymentState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transitionPayment(payment: Payment, targetState: PaymentState, occurredAt: string): Payment {
  assertIsoDate(occurredAt);
  if (!canTransitionPayment(payment.state, targetState)) {
    throw new DomainError(
      "invalid_payment_transition",
      `Transição de pagamento inválida: ${payment.state} → ${targetState}.`,
    );
  }

  return {
    ...payment,
    state: targetState,
    updatedAt: occurredAt,
  };
}
