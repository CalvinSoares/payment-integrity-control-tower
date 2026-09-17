package com.lemon.integrity.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.boot.test.mock.mockito.MockBean;
import com.fasterxml.jackson.databind.JsonNode;

import java.security.MessageDigest;
import java.util.Map;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

@SpringBootTest
@AutoConfigureMockMvc
class EventControllerTest {
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper mapper;
    @MockBean EventPersistenceService persistence;

    @BeforeEach
    void setUp() {
        when(persistence.receive(any(JsonNode.class)))
                .thenReturn(new IngestionReceipt("RECEIVED", "evt:java:001", "inbox:evt:java:001", "outbox:evt:java:001"));
    }

    @Test
    void acceptsCanonicalEventWithValidHash() throws Exception {
        Map<String, Object> data = Map.of("amountMinor", 1000, "currency", "BRL", "paymentId", "pay_java");
        String canonical = "{\"amountMinor\":1000,\"currency\":\"BRL\",\"paymentId\":\"pay_java\"}";
        String hash = "sha256:" + hex(MessageDigest.getInstance("SHA-256").digest(canonical.getBytes()));
        Map<String, Object> event = Map.ofEntries(
                Map.entry("eventId", "evt:java:001"), Map.entry("eventType", "payment.captured"), Map.entry("schemaVersion", 1),
                Map.entry("tenantId", "tenant_local"), Map.entry("provider", "simulator"), Map.entry("providerAccountId", "account_java"),
                Map.entry("externalPaymentId", "external_java"), Map.entry("externalEventId", "external_evt_java"),
                Map.entry("occurredAt", "2026-09-17T20:00:00Z"), Map.entry("receivedAt", "2026-09-17T20:00:01Z"),
                Map.entry("traceId", "trace:java"), Map.entry("payloadHash", hash), Map.entry("data", data));
        mvc.perform(post("/v1/events").header("Authorization", "Bearer local-dev-token")
                        .contentType(MediaType.APPLICATION_JSON).content(mapper.writeValueAsString(event)))
                .andExpect(status().isAccepted()).andExpect(jsonPath("$.status").value("RECEIVED"));
    }

    @Test
    void rejectsTamperedHash() throws Exception {
        mvc.perform(post("/v1/events").header("Authorization", "Bearer local-dev-token")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"eventId\":\"evt\",\"eventType\":\"payment.captured\",\"schemaVersion\":1,\"tenantId\":\"t\",\"provider\":\"p\",\"providerAccountId\":\"a\",\"externalPaymentId\":\"e\",\"externalEventId\":\"x\",\"occurredAt\":\"2026-09-17T20:00:00Z\",\"receivedAt\":\"2026-09-17T20:00:01Z\",\"traceId\":\"trace\",\"payloadHash\":\"sha256:bad\",\"data\":{\"amountMinor\":1}}"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.error").value("payload_hash_mismatch"));
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder();
        for (byte item : bytes) result.append(String.format("%02x", item));
        return result.toString();
    }
}
