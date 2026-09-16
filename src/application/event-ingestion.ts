import { DomainError } from "../domain/errors.js";
import { eventDeduplicationKey, type PaymentEvent } from "../domain/events/payment-event.js";
import type { InboxRecord, OutboxRecord } from "../domain/events/event-status.js";
import type { EventHandler, EventRepositoryPorts, EventTransactionRunner } from "./event-ports.js";

export type IngestionReceipt = {
  status: "RECEIVED" | "REPLAYED";
  eventId: string;
  inboxId: string;
  outboxId: string;
};

export type WorkerResult = {
  status: "IDLE" | "APPLIED" | "REJECTED";
  eventId?: string;
  error?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Erro desconhecido ao processar evento.";
}

export class EventIngestionService {
  public constructor(private readonly transaction: EventTransactionRunner) {}

  public async receive(event: PaymentEvent): Promise<IngestionReceipt> {
    const deduplicationKey = eventDeduplicationKey(event);
    return this.transaction.run(async (ports: EventRepositoryPorts) => {
      const existing = await ports.inbox.findByDeduplicationKey(deduplicationKey);
      if (existing) {
        if (existing.event.payloadHash !== event.payloadHash || existing.event.eventType !== event.eventType) {
          throw new DomainError("event_deduplication_conflict", "O evento externo já foi recebido com outro payload.");
        }
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
      return { status: "RECEIVED", eventId: event.eventId, inboxId: record.inboxId, outboxId: outbox.outboxId };
    });
  }
}

export class LocalEventWorker {
  public constructor(private readonly transaction: EventTransactionRunner) {}

  public async processNext(handler: EventHandler, now = new Date().toISOString()): Promise<WorkerResult> {
    return this.transaction.run(async (ports: EventRepositoryPorts) => {
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
        return { status: "APPLIED", eventId: message.event.eventId };
      } catch (error) {
        const messageText = errorMessage(error);
        await ports.inbox.markStatus(inbox.inboxId, "REJECTED", { error: messageText });
        await ports.outbox.markStatus(message.outboxId, "FAILED", { error: messageText });
        return { status: "REJECTED", eventId: message.event.eventId, error: messageText };
      }
    });
  }
}
