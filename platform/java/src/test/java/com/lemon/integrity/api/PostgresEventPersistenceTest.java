package com.lemon.integrity.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.security.MessageDigest;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

@SpringBootTest
@EnabledIfEnvironmentVariable(named = "RUN_JAVA_DB_TESTS", matches = "true")
class PostgresEventPersistenceTest {
    @Autowired EventPersistenceService persistence;
    @Autowired ObjectMapper mapper;
    @Autowired JdbcTemplate jdbc;

    @Test
    void persistsAuditAndReplaysTheSameEvent() throws Exception {
        JsonNode event = event("evt:java:db-test-" + System.nanoTime());
        IngestionReceipt first = persistence.receive(event);
        IngestionReceipt replay = persistence.receive(event);

        assertEquals("RECEIVED", first.status());
        assertEquals("REPLAYED", replay.status());
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM event_inbox WHERE event_id = ?", Integer.class, first.eventId()));
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM event_outbox WHERE event_id = ?", Integer.class, first.eventId()));
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM audit_events WHERE source_event_id = ?", Integer.class, first.eventId()));
    }

    private JsonNode event(String eventId) throws Exception {
        Map<String, Object> data = Map.of("amountMinor", 1000, "currency", "BRL", "externalPaymentId", "external_java_db", "paymentId", "pay_java_db");
        String canonical = "{\"amountMinor\":1000,\"currency\":\"BRL\",\"externalPaymentId\":\"external_java_db\",\"paymentId\":\"pay_java_db\"}";
        String hash = "sha256:" + hex(MessageDigest.getInstance("SHA-256").digest(canonical.getBytes()));
        return mapper.valueToTree(Map.ofEntries(
                Map.entry("eventId", eventId), Map.entry("eventType", "payment.captured"), Map.entry("schemaVersion", 1),
                Map.entry("tenantId", "tenant_java_db"), Map.entry("provider", "simulator"), Map.entry("providerAccountId", "account_java_db"),
                Map.entry("externalPaymentId", "external_java_db"), Map.entry("externalEventId", "external_evt_java_db"),
                Map.entry("occurredAt", "2026-09-17T20:00:00Z"), Map.entry("receivedAt", "2026-09-17T20:00:01Z"),
                Map.entry("traceId", "trace:java:db"), Map.entry("payloadHash", hash), Map.entry("data", data)));
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder();
        for (byte item : bytes) result.append(String.format("%02x", item));
        return result.toString();
    }
}
