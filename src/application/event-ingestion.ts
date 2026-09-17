import { DomainError } from "../domain/errors.js";
import { eventDeduplicationKey, type PaymentEvent } from "../domain/events/payment-event.js";
import type { InboxRecord, OutboxRecord } from "../domain/events/event-status.js";
import type { EventHandler, EventRepositoryPorts, EventTransactionRunner } from "./event-ports.js";
import { defaultRetryPolicy, retryDelayMs, type RetryPolicy } from "./retry-policy.js";
import { MetricsRegistry } from "../observability/metrics.js";

export type IngestionReceipt = {
  status: "RECEIVED" | "REPLAYED";
  eventId: string;
  inboxId: string;
  outboxId: string;
};

export type WorkerResult = {
  status: "IDLE" | "APPLIED" | "RETRY_SCHEDULED" | "REJECTED";
  eventId?: string;
  error?: string;
  nextAttemptAt?: string;
  attempts?: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Erro desconhecido ao processar evento.";
}

export class EventIngestionService {
  public constructor(
    private readonly transaction: EventTransactionRunner,
    private readonly metrics: MetricsRegistry = new MetricsRegistry(),
  ) {}

  public async receive(event: PaymentEvent): Promise<IngestionReceipt> {
    const deduplicationKey = eventDeduplicationKey(event);
    return this.transaction.run(async (ports: EventRepositoryPorts) => {
      const existing = await ports.inbox.findByDeduplicationKey(deduplicationKey);
      if (existing) {
        if (existing.event.payloadHash !== event.payloadHash || existing.event.eventType !== event.eventType) {
          throw new DomainError("event_deduplication_conflict", "O evento externo já foi recebido com outro payload.");
        }
        this.metrics.increment("events_replayed_total");
        return {
          status: "REPLAYED",
          eventId: existing.event.eventId,
          inboxId: existing.inboxId,
          outboxId: `outbox:${existing.event.eventId}`,
        };
      }

      const record: InboxRecord = {
        inboxId: `inbox:${event.eventId}`,
        deduplicationKey,
        event,
        status: "RECEIVED",
        attempts: 0,
        receivedAt: event.receivedAt,
      };
      const outbox: OutboxRecord = {
        outboxId: `outbox:${event.eventId}`,
        topic: "payment-events.v1",
        event,
        status: "PENDING",
        attempts: 0,
        availableAt: event.receivedAt,
      };
      await ports.inbox.insert(record);
      await ports.outbox.enqueue(outbox);
      this.metrics.increment("events_received_total");
      return { status: "RECEIVED", eventId: event.eventId, inboxId: record.inboxId, outboxId: outbox.outboxId };
    });
  }
}

export class LocalEventWorker {
  public constructor(
    private readonly transaction: EventTransactionRunner,
    private readonly retryPolicy: RetryPolicy = defaultRetryPolicy,
    private readonly metrics: MetricsRegistry = new MetricsRegistry(),
    private readonly leaseMs = 5 * 60 * 1000,
  ) {}

  public async processNext(handler: EventHandler, now = new Date().toISOString()): Promise<WorkerResult> {
    return this.transaction.run(async (ports: EventRepositoryPorts) => {
      await ports.outbox.recoverStaleProcessing(now, this.leaseMs);
      const message = await ports.outbox.claimNext(now);
      if (!message) return { status: "IDLE" };

      const inbox = await ports.inbox.findByDeduplicationKey(eventDeduplicationKey(message.event));
      if (!inbox) {
        const error = "Inbox ausente para a mensagem do outbox.";
        await ports.outbox.markStatus(message.outboxId, "FAILED", { error });
        return { status: "REJECTED", eventId: message.event.eventId, error };
      }

      await ports.inbox.markStatus(inbox.inboxId, "PROCESSING");
      try {
        await handler(message.event, ports);
        const processedAt = new Date().toISOString();
        await ports.inbox.markStatus(inbox.inboxId, "APPLIED", { processedAt });
        await ports.outbox.markStatus(message.outboxId, "PUBLISHED", { publishedAt: processedAt });
        this.metrics.increment("events_applied_total");
        return { status: "APPLIED", eventId: message.event.eventId };
      } catch (error) {
        const messageText = errorMessage(error);
        const exhausted = message.attempts >= this.retryPolicy.maxAttempts;
        if (exhausted) {
          await ports.inbox.markStatus(inbox.inboxId, "REJECTED", { error: messageText });
          await ports.outbox.scheduleRetry(message.outboxId, now, messageText, true);
          this.metrics.increment("events_dead_lettered_total");
          return { status: "REJECTED", eventId: message.event.eventId, error: messageText, attempts: message.attempts };
        }
        const nextAttemptAt = new Date(Date.parse(now) + retryDelayMs(message.attempts, this.retryPolicy)).toISOString();
        await ports.inbox.markStatus(inbox.inboxId, "RECEIVED", { error: messageText });
        await ports.outbox.scheduleRetry(message.outboxId, nextAttemptAt, messageText, false);
        this.metrics.increment("events_retried_total");
        return {
          status: "RETRY_SCHEDULED",
          eventId: message.event.eventId,
          error: messageText,
          nextAttemptAt,
          attempts: message.attempts,
        };
      }
    });
  }
}
