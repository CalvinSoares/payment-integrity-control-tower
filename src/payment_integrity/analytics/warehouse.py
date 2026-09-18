"""DuckDB warehouse adapter for curated payment-event Parquet files."""

from __future__ import annotations

from pathlib import Path

import duckdb


def build_warehouse(parquet_path: Path, database_path: Path) -> None:
    database_path.parent.mkdir(parents=True, exist_ok=True)
    connection = duckdb.connect(str(database_path))
    try:
        connection.execute(
            """
            CREATE OR REPLACE TABLE payment_events AS
            SELECT DISTINCT ON (event_id)
                "eventId" AS event_id,
                "eventType" AS event_type,
                "schemaVersion" AS schema_version,
                "tenantId" AS tenant_id,
                provider,
                "providerAccountId" AS provider_account_id,
                "externalPaymentId" AS external_payment_id,
                "externalEventId" AS external_event_id,
                occurredAt::TIMESTAMP AS occurred_at,
                receivedAt::TIMESTAMP AS received_at,
                traceId AS trace_id,
                payloadHash AS payload_hash,
                to_json(data) AS data_json,
                normalizationVersion AS normalization_version
            FROM read_parquet(?)
            ORDER BY event_id, received_at DESC
            """,
            [str(parquet_path)],
        )
        connection.execute(
            """
            CREATE OR REPLACE VIEW tenant_event_summary AS
            SELECT tenant_id, event_type, COUNT(*) AS event_count,
                   MIN(received_at) AS first_received_at,
                   MAX(received_at) AS last_received_at
            FROM payment_events
            GROUP BY tenant_id, event_type
            ORDER BY tenant_id, event_type
            """
        )
    finally:
        connection.close()
