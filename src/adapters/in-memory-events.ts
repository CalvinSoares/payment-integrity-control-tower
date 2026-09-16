import type { InboxRecord, InboxStatus, OutboxRecord, OutboxStatus } from "../domain/events/event-status.js";
import type { EventRepositoryPorts, EventTransactionRunner, InboxRepository, OutboxRepository } from "../application/event-ports.js";

export class InMemoryInboxRepository implements InboxRepository {
  private readonly items = new Map<string, InboxRecord>();

  public async findByDeduplicationKey(deduplicationKey: string): Promise<InboxRecord | undefined> {
    return [...this.items.values()].find((item) => item.deduplicationKey === deduplicationKey);
  }

  public async insert(record: InboxRecord): Promise<void> {
    if (this.items.has(record.inboxId)) throw new Error(`Inbox duplicada: ${record.inboxId}`);
    if ([...this.items.values()].some((item) => item.deduplicationKey === record.deduplicationKey)) {
      throw new Error(`Chave de deduplicação duplicada: ${record.deduplicationKey}`);
    }
    this.items.set(record.inboxId, record);
  }

  public async markStatus(inboxId: string, status: InboxStatus, details: { error?: string; processedAt?: string } = {}): Promise<void> {
    const current = this.items.get(inboxId);
    if (!current) throw new Error(`Inbox ausente: ${inboxId}`);
    this.items.set(inboxId, {
      ...current,
      status,
      attempts: status === "PROCESSING" ? current.attempts + 1 : current.attempts,
      ...(details.error === undefined ? {} : { lastError: details.error }),
      ...(details.processedAt === undefined ? {} : { processedAt: details.processedAt }),
    });
  }

  public get size(): number {
    return this.items.size;
  }
}

export class InMemoryOutboxRepository implements OutboxRepository {
  private readonly items = new Map<string, OutboxRecord>();

  public async enqueue(record: OutboxRecord): Promise<void> {
    if (this.items.has(record.outboxId)) throw new Error(`Outbox duplicado: ${record.outboxId}`);
    this.items.set(record.outboxId, record);
  }

  public async claimNext(now: string): Promise<OutboxRecord | undefined> {
    const next = [...this.items.values()]
      .filter((item) => item.status === "PENDING" && Date.parse(item.availableAt) <= Date.parse(now))
      .sort((left, right) => left.availableAt.localeCompare(right.availableAt))[0];
    if (!next) return undefined;
    const claimed = { ...next, status: "PROCESSING" as const, attempts: next.attempts + 1 };
    this.items.set(next.outboxId, claimed);
    return claimed;
  }

  public async markStatus(outboxId: string, status: OutboxStatus, details: { error?: string; publishedAt?: string } = {}): Promise<void> {
    const current = this.items.get(outboxId);
    if (!current) throw new Error(`Outbox ausente: ${outboxId}`);
    this.items.set(outboxId, {
      ...current,
      status,
      ...(details.error === undefined ? {} : { lastError: details.error }),
      ...(details.publishedAt === undefined ? {} : { publishedAt: details.publishedAt }),
    });
  }

  public get size(): number {
    return this.items.size;
  }

  public getById(outboxId: string): OutboxRecord | undefined {
    return this.items.get(outboxId);
  }
}

export class InMemoryEventTransactionRunner implements EventTransactionRunner {
  public constructor(private readonly ports: EventRepositoryPorts) {}

  public async run<TResult>(work: (ports: EventRepositoryPorts) => Promise<TResult>): Promise<TResult> {
    return work(this.ports);
  }
}

export function createInMemoryEventPipeline(): {
  transaction: InMemoryEventTransactionRunner;
  inbox: InMemoryInboxRepository;
  outbox: InMemoryOutboxRepository;
} {
  const inbox = new InMemoryInboxRepository();
  const outbox = new InMemoryOutboxRepository();
  const ports: EventRepositoryPorts = { inbox, outbox };
  return { transaction: new InMemoryEventTransactionRunner(ports), inbox, outbox };
}
