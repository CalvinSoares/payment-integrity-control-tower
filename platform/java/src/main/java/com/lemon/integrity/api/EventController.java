package com.lemon.integrity.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.*;

@RestController
@RequestMapping("/v1")
public class EventController {
    private final ObjectMapper mapper;
    private final String apiToken;

    public EventController(ObjectMapper mapper, @Value("${CONTROL_TOWER_API_TOKEN:local-dev-token}") String apiToken) {
        this.mapper = mapper;
        this.apiToken = apiToken;
    }

    @GetMapping("/health/live")
    public Map<String, String> live() {
        return Map.of("status", "ok", "service", "payment-integrity-java");
    }

    @PostMapping("/events")
    public ResponseEntity<?> receive(@RequestHeader(value = "Authorization", required = false) String authorization,
                                     @RequestBody JsonNode event) {
        if (!("Bearer " + apiToken).equals(authorization)) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(Map.of("error", "unauthorized"));
        }
        List<String> missing = requiredFields(event);
        if (!missing.isEmpty() || event.path("schemaVersion").asInt(-1) != 1 || !event.path("data").isObject()) {
            return ResponseEntity.badRequest().body(Map.of("error", "invalid_event", "missing", missing));
        }
        String expectedHash = "sha256:" + sha256(canonicalJson(event.get("data")));
        if (!expectedHash.equals(event.path("payloadHash").asText())) {
            return ResponseEntity.badRequest().body(Map.of("error", "payload_hash_mismatch"));
        }
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(Map.of(
                "status", "RECEIVED",
                "eventId", event.path("eventId").asText()));
    }

    private List<String> requiredFields(JsonNode event) {
        List<String> missing = new ArrayList<>();
        for (String field : List.of("eventId", "eventType", "schemaVersion", "tenantId", "provider",
                "providerAccountId", "externalPaymentId", "externalEventId", "occurredAt", "receivedAt",
                "traceId", "payloadHash", "data")) {
            if (!event.hasNonNull(field)) missing.add(field);
        }
        return missing;
    }

    private String canonicalJson(JsonNode node) {
        if (node.isObject()) {
            List<String> names = new ArrayList<>();
            node.fieldNames().forEachRemaining(names::add);
            Collections.sort(names);
            StringBuilder result = new StringBuilder("{");
            for (int i = 0; i < names.size(); i++) {
                if (i > 0) result.append(',');
                String name = names.get(i);
                result.append(quote(name)).append(':').append(canonicalJson(node.get(name)));
            }
            return result.append('}').toString();
        }
        if (node.isArray()) {
            StringBuilder result = new StringBuilder("[");
            for (int i = 0; i < node.size(); i++) {
                if (i > 0) result.append(',');
                result.append(canonicalJson(node.get(i)));
            }
            return result.append(']').toString();
        }
        return node.toString();
    }

    private String quote(String value) {
        try {
            return mapper.writeValueAsString(value);
        } catch (Exception error) {
            throw new IllegalStateException("failed to canonicalize JSON", error);
        }
    }

    private String sha256(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder();
            for (byte item : digest) result.append(String.format("%02x", item));
            return result.toString();
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }
}
