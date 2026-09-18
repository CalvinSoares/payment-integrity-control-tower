"""Domain results returned after event ingestion."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True, slots=True)
class IngestionReceipt:
    status: Literal["RECEIVED", "REPLAYED"]
    event_id: str
    inbox_id: str
    outbox_id: str

    def to_mapping(self) -> dict[str, str]:
        return {
            "status": self.status,
            "eventId": self.event_id,
            "inboxId": self.inbox_id,
            "outboxId": self.outbox_id,
        }
