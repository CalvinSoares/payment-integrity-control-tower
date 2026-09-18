"""Ports consumed by application use cases.

Concrete implementations belong in ``infrastructure``. Keeping these
interfaces here prevents database and provider details from leaking inward.
"""

from __future__ import annotations

from typing import Protocol

from payment_integrity.domain.payment_events import PaymentEvent
from payment_integrity.domain.receipts import IngestionReceipt


class EventStore(Protocol):
    """Persistence port for canonical payment events."""

    def receive(self, event: PaymentEvent) -> IngestionReceipt:
        """Persist or replay an event using its deduplication identity."""


class EventHealthCheck(Protocol):
    """Minimal health port used by the API composition root."""

    def ready(self) -> bool:
        """Return whether the backing event store is ready."""
