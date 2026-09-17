package com.lemon.integrity.api;

public record IngestionReceipt(String status, String eventId, String inboxId, String outboxId) {}
