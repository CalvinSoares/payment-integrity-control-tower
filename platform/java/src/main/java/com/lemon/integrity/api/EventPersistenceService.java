package com.lemon.integrity.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;

@Service
public class EventPersistenceService {
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public EventPersistenceService(JdbcTemplate jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    @Transactional
    public IngestionReceipt receive(JsonNode event) {
        String eventId = event.path("eventId").asText();
        String deduplicationKey = deduplicationKey(event);
        ExistingEvent existing = findByDeduplicationKey(deduplicationKey);
        if (existing != null) return replayOrConflict(existing, event);

        String inboxId = "inbox:" + eventId;
        String outboxId = "outbox:" + eventId;
        String eventJson = event.toString();
        String receivedAt = event.path("receivedAt").asText();
        String occurredAt = event.path("occurredAt").asText();
        String tenantId = event.path("tenantId").asText();

        jdbc.update("""
                INSERT INTO event_inbox
                  (inbox_id, event_id, deduplication_key, tenant_id, provider,
                   provider_account_id, external_event_id, event_type, schema_version,
                   payload_hash, event_json, status, attempts, received_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, 'RECEIVED', 0, ?::timestamptz)
                ON CONFLICT DO NOTHING
                """, inboxId, eventId, deduplicationKey, tenantId,
                event.path("provider").asText(), event.path("providerAccountId").asText(),
                event.path("externalEventId").asText(), event.path("eventType").asText(),
                event.path("schemaVersion").asInt(), event.path("payloadHash").asText(),
                eventJson, receivedAt);

        existing = findByDeduplicationKey(deduplicationKey);
        if (existing == null || !existing.eventId().equals(eventId)) return replayOrConflict(existing, event);

        jdbc.update("""
                INSERT INTO event_outbox
                  (outbox_id, event_id, topic, event_json, status, attempts, available_at)
                VALUES (?, ?, 'payment-events.v1', ?::jsonb, 'PENDING', 0, ?::timestamptz)
                ON CONFLICT DO NOTHING
                """, outboxId, eventId, eventJson, receivedAt);

        jdbc.update("""
                INSERT INTO audit_events
                  (audit_id, tenant_id, actor_id, action, entity_type, entity_id,
                   source_event_id, occurred_at, metadata)
                VALUES (?, ?, ?, 'EVENT_RECEIVED', 'PaymentEvent', ?, ?, ?::timestamptz, ?::jsonb)
                ON CONFLICT (audit_id) DO NOTHING
                """, "audit:" + eventId, tenantId, "system:ingestion", eventId, eventId,
                occurredAt, mapper.createObjectNode()
                        .put("eventType", event.path("eventType").asText())
                        .put("provider", event.path("provider").asText())
                        .put("deduplicationKey", deduplicationKey).toString());

        return new IngestionReceipt("RECEIVED", eventId, inboxId, outboxId);
    }

    private IngestionReceipt replayOrConflict(ExistingEvent existing, JsonNode incoming) {
        if (existing == null) throw new IllegalStateException("event_id já existe com outra chave de deduplicação");
        if (!existing.payloadHash().equals(incoming.path("payloadHash").asText())
                || !existing.eventType().equals(incoming.path("eventType").asText())) {
            throw new IllegalArgumentException("O evento externo já foi recebido com outro payload.");
        }
        return new IngestionReceipt("REPLAYED", existing.eventId(), existing.inboxId(), "outbox:" + existing.eventId());
    }

    private ExistingEvent findByDeduplicationKey(String key) {
        List<ExistingEvent> rows = jdbc.query("""
                SELECT inbox_id, event_id, event_type, payload_hash
                FROM event_inbox WHERE deduplication_key = ?
                """, (result, row) -> new ExistingEvent(
                result.getString("inbox_id"), result.getString("event_id"),
                result.getString("event_type"), result.getString("payload_hash")), key);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private String deduplicationKey(JsonNode event) {
        try {
            return mapper.writeValueAsString(List.of(
                    event.path("provider").asText(),
                    event.path("providerAccountId").asText(),
                    event.path("externalEventId").asText()));
        } catch (Exception error) {
            throw new IllegalStateException("Não foi possível criar a chave de deduplicação", error);
        }
    }

    private record ExistingEvent(String inboxId, String eventId, String eventType, String payloadHash) {}
}
