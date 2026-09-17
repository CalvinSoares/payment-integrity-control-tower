import { DomainError } from "../domain/errors.js";
import { eventDeduplicationKey } from "../domain/events/payment-event.js";
import type { EventTransactionRunner } from "./event-ports.js";

export type DeadLetterReplayInput = {
  outboxId: string;
  tenantId: string;
  availableAt?: string;
};

export type DeadLetterReplayResult = {
  status: "REQUEUED";
  outboxId: string;
  eventId: string;
  deduplicationKey: string;
  availableAt: string;
};

export class DeadLetterService {
  public constructor(private readonly transaction: EventTransactionRunner) {}

  public async requeue(input: DeadLetterReplayInput): Promise<DeadLetterReplayResult> {
    const availableAt = input.availableAt ?? new Date().toISOString();
    return this.transaction.run(async (ports) => {
      const outbox = await ports.outbox.findById(input.outboxId);
      if (!outbox) throw new DomainError("event_not_found", "Mensagem não encontrada.");
      if (outbox.event.tenantId !== input.tenantId) {
        throw new DomainError("event_tenant_forbidden", "A mensagem não pertence ao tenant autenticado.");
      }
      if (outbox.status !== "DEAD_LETTER") {
        throw new DomainError("event_replay_conflict", "A mensagem não está na DLQ.");
      }
      await ports.outbox.requeueDeadLetter(input.outboxId, availableAt);
      return {
        status: "REQUEUED",
        outboxId: outbox.outboxId,
        eventId: outbox.event.eventId,
        deduplicationKey: eventDeduplicationKey(outbox.event),
        availableAt,
      };
    });
  }
}
