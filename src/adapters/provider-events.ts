import type { ScenarioStep } from "../foundation/types.js";
import { createPaymentEvent, hashEventData, type PaymentEvent, type PaymentEventType } from "../domain/events/payment-event.js";

export interface ProviderEventAdapter<TInput> {
  readonly provider: string;
  normalize(input: TInput): PaymentEvent;
}

export type AxxonPaymentWebhook = {
  tenantId: string;
  providerAccountId: string;
  id: string;
  status: "authorized" | "captured" | "settled" | "paid_out" | "canceled" | "voided" | "refunded" | "chargeback";
  paymentId: string;
  externalPaymentId: string;
  amountMinor?: number;
  currency?: string;
  occurredAt: string;
  receivedAt: string;
  traceId: string;
};

const axxonTypes: Record<AxxonPaymentWebhook["status"], PaymentEventType> = {
  authorized: "payment.authorized",
  captured: "payment.captured",
  settled: "payment.settled",
  paid_out: "payment.paid_out",
  canceled: "payment.canceled",
  voided: "payment.voided",
  refunded: "payment.refunded",
  chargeback: "payment.chargeback",
};

export class AxxonEventAdapter implements ProviderEventAdapter<AxxonPaymentWebhook> {
  public readonly provider = "axxon";

  public normalize(input: AxxonPaymentWebhook): PaymentEvent {
    const data = {
      paymentId: input.paymentId,
      externalPaymentId: input.externalPaymentId,
      ...(input.amountMinor === undefined ? {} : { amountMinor: input.amountMinor }),
      ...(input.currency === undefined ? {} : { currency: input.currency }),
    };
    return createPaymentEvent({
      eventId: `evt:${this.provider}:${input.id}`,
      eventType: axxonTypes[input.status],
      schemaVersion: 1,
      tenantId: input.tenantId,
      provider: this.provider,
      providerAccountId: input.providerAccountId,
      externalPaymentId: input.externalPaymentId,
      externalEventId: input.id,
      occurredAt: input.occurredAt,
      receivedAt: input.receivedAt,
      traceId: input.traceId,
      payloadHash: hashEventData(data),
      data,
    });
  }
}

export type SimulatorEventContext = {
  tenantId: string;
  providerAccountId: string;
  paymentId: string;
  externalPaymentId: string;
  traceId: string;
  receivedAt?: string;
};

const simulatorTypes: Record<ScenarioStep["eventType"], PaymentEventType> = {
  authorized: "payment.authorized",
  captured: "payment.captured",
  settled: "payment.settled",
  paid_out: "payment.paid_out",
  timeout: "provider.timeout",
};

export class SimulatorEventAdapter implements ProviderEventAdapter<{ step: ScenarioStep; context: SimulatorEventContext }> {
  public readonly provider = "simulator";

  public normalize(input: { step: ScenarioStep; context: SimulatorEventContext }): PaymentEvent {
    const { step, context } = input;
    const data = {
      paymentId: context.paymentId,
      externalPaymentId: context.externalPaymentId,
      ...(step.amountMinor === undefined ? {} : { amountMinor: step.amountMinor }),
      ...(step.currency === undefined ? {} : { currency: step.currency }),
    };
    return createPaymentEvent({
      eventId: `evt:simulator:${step.externalEventId}`,
      eventType: simulatorTypes[step.eventType],
      schemaVersion: 1,
      tenantId: context.tenantId,
      provider: this.provider,
      providerAccountId: context.providerAccountId,
      externalPaymentId: context.externalPaymentId,
      externalEventId: step.externalEventId,
      occurredAt: step.occurredAt,
      receivedAt: context.receivedAt ?? step.occurredAt,
      traceId: context.traceId,
      payloadHash: hashEventData(data),
      data,
    });
  }
}
