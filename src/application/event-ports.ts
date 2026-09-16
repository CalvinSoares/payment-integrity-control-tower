import type { InboxRecord, InboxStatus, OutboxRecord, OutboxStatus } from "../domain/events/event-status.js";

export interface InboxRepository {
  findByDeduplicationKey(deduplicationKey: string): Promise<InboxRecord | undefined>;
  insert(record: InboxRecord): Promise<void>;
  markStatus(inboxId: string, status: InboxStatus, details?: { error?: string; processedAt?: string }): Promise<void>;
}

export interface OutboxRepository {
  enqueue(record: OutboxRecord): Promise<void>;
  claimNext(now: string): Promise<OutboxRecord | undefined>;
  markStatus(outboxId: string, status: OutboxStatus, details?: { error?: string; publishedAt?: string }): Promise<void>;
}

export type EventRepositoryPorts = {
  inbox: InboxRepository;
  outbox: OutboxRepository;
};

export interface EventTransactionRunner {
  run<TResult>(work: (ports: EventRepositoryPorts) => Promise<TResult>): Promise<TResult>;
}

export type EventHandler = (event: import("../domain/events/payment-event.js").PaymentEvent, ports: EventRepositoryPorts) => Promise<void>;
