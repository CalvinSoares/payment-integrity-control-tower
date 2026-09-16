import type { PaymentEvent } from "./payment-event.js";

export type InboxStatus = "RECEIVED" | "PROCESSING" | "APPLIED" | "REJECTED";
export type OutboxStatus = "PENDING" | "PROCESSING" | "PUBLISHED" | "FAILED";

export type InboxRecord = {
  inboxId: string;
  deduplicationKey: string;
  event: PaymentEvent;
  status: InboxStatus;
  attempts: number;
  lastError?: string;
  receivedAt: string;
  processedAt?: string;
};

export type OutboxRecord = {
  outboxId: string;
  topic: string;
  event: PaymentEvent;
  status: OutboxStatus;
  attempts: number;
  availableAt: string;
  lastError?: string;
  publishedAt?: string;
};
