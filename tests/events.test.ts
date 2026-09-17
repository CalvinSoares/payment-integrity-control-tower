import { describe, expect, it } from "vitest";
import { EventIngestionService, LocalEventWorker } from "../src/application/event-ingestion.js";
import { createInMemoryEventPipeline } from "../src/adapters/in-memory-events.js";
import { AxxonEventAdapter, SimulatorEventAdapter } from "../src/adapters/provider-events.js";
import { createPaymentEvent, hashEventData, type PaymentEvent } from "../src/domain/events/payment-event.js";

function paymentEvent(overrides: Partial<PaymentEvent> = {}): PaymentEvent {
  const data = {
    paymentId: "pay_001",
    externalPaymentId: "provider_pay_001",
    amountMinor: 10000,
    currency: "BRL",
  };
  return createPaymentEvent({
    eventId: "evt:simulator:evt-cap-001",
    eventType: "payment.captured",
    schemaVersion: 1,
    tenantId: "tenant_a",
    provider: "simulator",
    providerAccountId: "simulator_account",
    externalPaymentId: "provider_pay_001",
    externalEventId: "evt-cap-001",
    occurredAt: "2026-01-10T10:01:00Z",
    receivedAt: "2026-01-10T10:01:01Z",
    traceId: "trace_001",
    payloadHash: hashEventData(data),
    data,
    ...overrides,
  });
}

describe("payment events", () => {
  it("hashes canonical data independent of property order", () => {
    expect(hashEventData({ b: 2, a: 1 })).toBe(hashEventData({ a: 1, b: 2 }));
  });

  it("rejects a tampered payload hash", () => {
    expect(() => paymentEvent({ payloadHash: "sha256:tampered" })).toThrow("payloadHash");
  });

  it("normalizes Axxon and simulator inputs into the same contract", () => {
    const axxon = new AxxonEventAdapter().normalize({
      tenantId: "tenant_a",
      providerAccountId: "account_001",
      id: "axxon_evt_001",
      status: "captured",
      paymentId: "pay_001",
      externalPaymentId: "provider_pay_001",
      amountMinor: 10000,
      currency: "BRL",
      occurredAt: "2026-01-10T10:01:00Z",
      receivedAt: "2026-01-10T10:01:01Z",
      traceId: "trace_001",
    });
    const simulator = new SimulatorEventAdapter().normalize({
      step: {
        eventType: "captured",
        externalEventId: "sim_evt_001",
        occurredAt: "2026-01-10T10:01:00Z",
        amountMinor: 10000,
        currency: "BRL",
        provider: "simulator",
      },
      context: {
        tenantId: "tenant_a",
        providerAccountId: "simulator_account",
        paymentId: "pay_001",
        externalPaymentId: "provider_pay_001",
        traceId: "trace_001",
      },
    });

    expect(axxon.eventType).toBe(simulator.eventType);
    expect(axxon.data).toEqual(simulator.data);
    expect(axxon.provider).toBe("axxon");
    expect(simulator.provider).toBe("simulator");
  });
});

describe("event ingestion and local worker", () => {
  it("deduplicates an external event and does not duplicate the outbox", async () => {
    const { transaction, inbox, outbox } = createInMemoryEventPipeline();
    const ingestion = new EventIngestionService(transaction);
    const event = paymentEvent();

    const first = await ingestion.receive(event);
    const replay = await ingestion.receive(event);

    expect(first.status).toBe("RECEIVED");
    expect(replay.status).toBe("REPLAYED");
    expect(inbox.size).toBe(1);
    expect(outbox.size).toBe(1);
  });

  it("rejects the same external id with a different payload", async () => {
    const { transaction } = createInMemoryEventPipeline();
    const ingestion = new EventIngestionService(transaction);
    await ingestion.receive(paymentEvent());

    await expect(
      ingestion.receive(
        paymentEvent({
          eventId: "evt:simulator:evt-cap-002",
          externalEventId: "evt-cap-001",
          data: {
            paymentId: "pay_001",
            externalPaymentId: "provider_pay_001",
            amountMinor: 9800,
            currency: "BRL",
          },
          payloadHash: hashEventData({
            paymentId: "pay_001",
            externalPaymentId: "provider_pay_001",
            amountMinor: 9800,
            currency: "BRL",
          }),
        }),
      ),
    ).rejects.toThrow("outro payload");
  });

  it("processes one outbox event and marks inbox and outbox", async () => {
    const { transaction, outbox } = createInMemoryEventPipeline();
    const ingestion = new EventIngestionService(transaction);
    const worker = new LocalEventWorker(transaction);
    const event = paymentEvent();
    await ingestion.receive(event);
    const handled: string[] = [];

    const result = await worker.processNext(async (received) => {
      handled.push(received.eventId);
    }, "2026-01-10T10:02:00Z");

    expect(result).toEqual({ status: "APPLIED", eventId: event.eventId });
    expect(handled).toEqual([event.eventId]);
    expect(outbox.getById(`outbox:${event.eventId}`)?.status).toBe("PUBLISHED");
    expect((await worker.processNext(async () => undefined, "2026-01-10T10:02:00Z")).status).toBe("IDLE");
  });

  it("records handler failures without leaving a processing lock", async () => {
    const { transaction, outbox } = createInMemoryEventPipeline();
    const ingestion = new EventIngestionService(transaction);
    const worker = new LocalEventWorker(transaction);
    const event = paymentEvent({ eventId: "evt:simulator:evt-fail-001", externalEventId: "evt-fail-001" });
    await ingestion.receive(event);

    const result = await worker.processNext(async () => {
      throw new Error("falha controlada");
    }, "2026-01-10T10:02:00Z");

    expect(result.status).toBe("RETRY_SCHEDULED");
    expect(result.nextAttemptAt).toBe("2026-01-10T10:02:01.000Z");
    expect(outbox.getById(`outbox:${event.eventId}`)?.status).toBe("PENDING");
  });

  it("retries with backoff and applies when the handler recovers", async () => {
    const { transaction, outbox } = createInMemoryEventPipeline();
    const ingestion = new EventIngestionService(transaction);
    const worker = new LocalEventWorker(transaction);
    const event = paymentEvent({ eventId: "evt:simulator:evt-retry-001", externalEventId: "evt-retry-001" });
    await ingestion.receive(event);
    let attempts = 0;

    const first = await worker.processNext(async () => {
      attempts += 1;
      throw new Error("transient");
    }, "2026-01-10T10:02:00Z");
    const second = await worker.processNext(async () => {
      attempts += 1;
    }, first.nextAttemptAt);

    expect(first.status).toBe("RETRY_SCHEDULED");
    expect(second.status).toBe("APPLIED");
    expect(attempts).toBe(2);
    expect(outbox.getById(`outbox:${event.eventId}`)?.status).toBe("PUBLISHED");
  });

  it("moves an event to the dead-letter queue after the retry budget", async () => {
    const { transaction, outbox } = createInMemoryEventPipeline();
    const ingestion = new EventIngestionService(transaction);
    const worker = new LocalEventWorker(transaction);
    const event = paymentEvent({ eventId: "evt:simulator:evt-dlq-001", externalEventId: "evt-dlq-001" });
    await ingestion.receive(event);
    const first = await worker.processNext(async () => { throw new Error("permanent"); }, "2026-01-10T10:02:00Z");
    const second = await worker.processNext(async () => { throw new Error("permanent"); }, first.nextAttemptAt);
    const third = await worker.processNext(async () => { throw new Error("permanent"); }, second.nextAttemptAt);

    expect(third.status).toBe("REJECTED");
    expect(third.attempts).toBe(3);
    expect(outbox.getById(`outbox:${event.eventId}`)?.status).toBe("DEAD_LETTER");
  });
});
