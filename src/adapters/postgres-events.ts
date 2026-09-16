import { Pool, type PoolClient } from "pg";
import type { EventRepositoryPorts, EventTransactionRunner, InboxRepository, OutboxRepository } from "../application/event-ports.js";
import type { InboxRecord, InboxStatus, OutboxRecord, OutboxStatus } from "../domain/events/event-status.js";
import type { PaymentEvent } from "../domain/events/payment-event.js";
import { loadEnvironment } from "../config/env.js";
import type { PostgresExecutor } from "./postgres.js";

type InboxRow = {
  inbox_id: string;
  event_id: string;
  deduplication_key: string;
  event_json: PaymentEvent;
  status: InboxStatus;
  attempts: number;
  last_error: string | null;
  received_at: Date | string;
  processed_at: Date | string | null;
};

type OutboxRow = {
  outbox_id: string;
  event_id: string;
  topic: string;
  event_json: PaymentEvent;
  status: OutboxStatus;
  attempts: number;
  available_at: Date | string;
  last_error: string | null;
  published_at: Date | string | null;
};

function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapInbox(row: InboxRow): InboxRecord {
  return {
    inboxId: row.inbox_id,
    deduplicationKey: row.deduplication_key,
    event: row.event_json,
    status: row.status,
    attempts: row.attempts,
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    receivedAt: isoDate(row.received_at),
    ...(row.processed_at === null ? {} : { processedAt: isoDate(row.processed_at) }),
  };
}

function mapOutbox(row: OutboxRow): OutboxRecord {
  return {
    outboxId: row.outbox_id,
    topic: row.topic,
    event: row.event_json,
    status: row.status,
    attempts: row.attempts,
    availableAt: isoDate(row.available_at),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    ...(row.published_at === null ? {} : { publishedAt: isoDate(row.published_at) }),
  };
}

export class PostgresInboxRepository implements InboxRepository {
  public constructor(private readonly db: PostgresExecutor) {}

  public async findByDeduplicationKey(deduplicationKey: string): Promise<InboxRecord | undefined> {
    const result = await this.db.query<InboxRow>(
      `SELECT inbox_id, event_id, deduplication_key, event_json, status, attempts, last_error, received_at, processed_at
       FROM event_inbox WHERE deduplication_key = $1`,
      [deduplicationKey],
    );
    return result.rows[0] ? mapInbox(result.rows[0]) : undefined;
  }

  public async insert(record: InboxRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO event_inbox
       (inbox_id, event_id, deduplication_key, tenant_id, provider, provider_account_id,
        external_event_id, event_type, schema_version, payload_hash, event_json, status, attempts, received_at, processed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15)`,
      [
        record.inboxId,
        record.event.eventId,
        record.deduplicationKey,
        record.event.tenantId,
        record.event.provider,
        record.event.providerAccountId,
        record.event.externalEventId,
        record.event.eventType,
        record.event.schemaVersion,
        record.event.payloadHash,
        JSON.stringify(record.event),
        record.status,
        record.attempts,
        record.receivedAt,
        record.processedAt ?? null,
      ],
    );
  }

  public async markStatus(inboxId: string, status: InboxStatus, details: { error?: string; processedAt?: string } = {}): Promise<void> {
    const result = await this.db.query(
      `UPDATE event_inbox
       SET status = $2,
           attempts = attempts + CASE WHEN $2 = 'PROCESSING' THEN 1 ELSE 0 END,
           last_error = COALESCE($3, last_error),
           processed_at = COALESCE($4, processed_at)
       WHERE inbox_id = $1`,
      [inboxId, status, details.error ?? null, details.processedAt ?? null],
    );
    if (result.rowCount !== 1) throw new Error(`Inbox ausente: ${inboxId}`);
  }
}

export class PostgresOutboxRepository implements OutboxRepository {
  public constructor(private readonly db: PostgresExecutor) {}

  public async enqueue(record: OutboxRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO event_outbox
       (outbox_id, event_id, topic, event_json, status, attempts, available_at, last_error, published_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)`,
      [
        record.outboxId,
        record.event.eventId,
        record.topic,
        JSON.stringify(record.event),
        record.status,
        record.attempts,
        record.availableAt,
        record.lastError ?? null,
        record.publishedAt ?? null,
      ],
    );
  }

  public async claimNext(now: string): Promise<OutboxRecord | undefined> {
    const result = await this.db.query<OutboxRow>(
      `WITH next_message AS (
         SELECT outbox_id
         FROM event_outbox
         WHERE status = 'PENDING' AND available_at <= $1
         ORDER BY available_at, outbox_id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE event_outbox outbox
       SET status = 'PROCESSING', attempts = outbox.attempts + 1
       FROM next_message
       WHERE outbox.outbox_id = next_message.outbox_id
       RETURNING outbox.outbox_id, outbox.event_id, outbox.topic, outbox.event_json,
                 outbox.status, outbox.attempts, outbox.available_at, outbox.last_error, outbox.published_at`,
      [now],
    );
    return result.rows[0] ? mapOutbox(result.rows[0]) : undefined;
  }

  public async markStatus(outboxId: string, status: OutboxStatus, details: { error?: string; publishedAt?: string } = {}): Promise<void> {
    const result = await this.db.query(
      `UPDATE event_outbox
       SET status = $2,
           last_error = COALESCE($3, last_error),
           published_at = COALESCE($4, published_at)
       WHERE outbox_id = $1`,
      [outboxId, status, details.error ?? null, details.publishedAt ?? null],
    );
    if (result.rowCount !== 1) throw new Error(`Outbox ausente: ${outboxId}`);
  }
}

export function createPostgresEventRepositoryPorts(db: PostgresExecutor): EventRepositoryPorts {
  return {
    inbox: new PostgresInboxRepository(db),
    outbox: new PostgresOutboxRepository(db),
  };
}

export class PostgresEventTransactionRunner implements EventTransactionRunner {
  public constructor(private readonly pool: Pool) {}

  public async run<TResult>(work: (ports: EventRepositoryPorts) => Promise<TResult>): Promise<TResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(createPostgresEventRepositoryPorts(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createPostgresEventPipeline(pool = new Pool({ connectionString: loadEnvironment().databaseUrl })): {
  transaction: PostgresEventTransactionRunner;
  pool: Pool;
} {
  return { transaction: new PostgresEventTransactionRunner(pool), pool };
}
