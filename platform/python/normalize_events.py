#!/usr/bin/env python3
"""Validate and normalize canonical payment events without external services."""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime
from typing import Any

REQUIRED_FIELDS = (
    "eventId", "eventType", "schemaVersion", "tenantId", "provider",
    "providerAccountId", "externalPaymentId", "externalEventId",
    "occurredAt", "receivedAt", "traceId", "payloadHash", "data",
)


def canonical_json(value: dict[str, Any]) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def payload_hash(data: dict[str, Any]) -> str:
    digest = hashlib.sha256(canonical_json(data).encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def validate_event(event: dict[str, Any]) -> list[str]:
    errors = [f"campo ausente: {field}" for field in REQUIRED_FIELDS if field not in event]
    if errors:
        return errors
    for field in REQUIRED_FIELDS:
        if field in ("data", "schemaVersion"):
            continue
        if not isinstance(event[field], str) or not event[field]:
            errors.append(f"campo inválido: {field}")
    if event.get("schemaVersion") != 1:
        errors.append("schemaVersion deve ser 1")
    if not isinstance(event.get("data"), dict):
        errors.append("data deve ser um objeto")
    for field in ("occurredAt", "receivedAt"):
        try:
            datetime.fromisoformat(str(event[field]).replace("Z", "+00:00"))
        except ValueError:
            errors.append(f"timestamp inválido: {field}")
    if isinstance(event.get("data"), dict) and event.get("payloadHash") != payload_hash(event["data"]):
        errors.append("payloadHash não corresponde a data")
    return errors


def normalize(event: dict[str, Any]) -> dict[str, Any]:
    return {**event, "normalizationVersion": "python-local-v1"}


def main() -> int:
    invalid = 0
    for line_number, line in enumerate(sys.stdin, start=1):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
            if not isinstance(event, dict):
                raise ValueError("evento deve ser um objeto")
            errors = validate_event(event)
            if errors:
                raise ValueError("; ".join(errors))
            print(json.dumps(normalize(event), ensure_ascii=False, separators=(",", ":")))
        except (TypeError, json.JSONDecodeError, ValueError) as error:
            invalid += 1
            print(f"linha {line_number}: {error}", file=sys.stderr)
    return 1 if invalid else 0


if __name__ == "__main__":
    raise SystemExit(main())
