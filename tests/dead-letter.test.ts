import { describe, expect, it } from "vitest";
import { createInMemoryEventPipeline } from "../src/adapters/in-memory-events.js";
import { DeadLetterService } from "../src/application/dead-letter.js";
import { EventIngestionService, LocalEventWorker } from "../src/application/event-ingestion.js";
import { SimulatorEventAdapter } from "../src/adapters/provider-events.js";

function event() {
  const occurredAt = "2026-01-10T10:00:00Z";
  return new SimulatorEventAdapter().normalize({
    step: { eventType: "captured", externalEventId: "ops_evt_001", occurredAt, amountMinor: 1000, currency: "BRL", provider: "simulator" },
    context: {
      tenantId: "tenant_ops",
      providerAccountId: "account_ops",
      paymentId: "pay_ops",
      externalPaymentId: "provider_ops",
      traceId: "trace_ops",
      receivedAt: occurredAt,
    },
  });
}

describe("dead-letter operations", () => {
  it("requeues only a tenant-owned dead-letter event and gives it a fresh retry budget", async () => {
    const { transaction, outbox } = createInMemoryEventPipeline();
    const ingestion = new EventIngestionService(transaction);
    const worker = new LocalEventWorker(transaction);
    const deadLetters = new DeadLetterService(transaction);
    const received = event();
    await ingestion.receive(received);

    const first = await worker.processNext(async () => { throw new Error("permanent"); }, "2026-01-10T10:00:01Z");
    const second = await worker.processNext(async () => { throw new Error("permanent"); }, first.nextAttemptAt);
    await worker.processNext(async () => { throw new Error("permanent"); }, second.nextAttemptAt);
    const replay = await deadLetters.requeue({ outboxId: `outbox:${received.eventId}`, tenantId: "tenant_ops", availableAt: "2026-01-10T10:05:00Z" });

    expect(replay.status).toBe("REQUEUED");
    expect(outbox.getById(`outbox:${received.eventId}`)).toMatchObject({ status: "PENDING", attempts: 0, availableAt: "2026-01-10T10:05:00Z" });
    expect((await worker.processNext(async () => undefined, replay.availableAt)).status).toBe("APPLIED");
  });

  it("returns a stale processing message to the queue", async () => {
    const { transaction, outbox } = createInMemoryEventPipeline();
    await new EventIngestionService(transaction).receive(event());
    await transaction.run((ports) => ports.outbox.claimNext("2026-01-10T10:00:00Z"));

    const recovered = await transaction.run((ports) => ports.outbox.recoverStaleProcessing("2026-01-10T10:01:01Z", 60_000));

    expect(recovered).toBe(1);
    expect(outbox.getById("outbox:evt:simulator:ops_evt_001")).toMatchObject({ status: "PENDING", availableAt: "2026-01-10T10:01:01Z" });
  });
});
