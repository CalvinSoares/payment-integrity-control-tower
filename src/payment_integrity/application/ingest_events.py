"""Application use case for receiving canonical payment events."""

from __future__ import annotations

from typing import Mapping

from payment_integrity.domain.payment_events import PaymentEvent
from payment_integrity.domain.receipts import IngestionReceipt

from .ports import EventStore


class IngestPaymentEvent:
    """Validate an event and delegate persistence to an infrastructure port."""

    def __init__(self, event_store: EventStore) -> None:
        self._event_store = event_store

    def execute(self, raw_event: Mapping[str, object]) -> IngestionReceipt:
        event = PaymentEvent.from_mapping(raw_event)
        return self._event_store.receive(event)
