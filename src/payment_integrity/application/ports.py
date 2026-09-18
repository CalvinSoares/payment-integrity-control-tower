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

    def ready(self) -> bool:
        """Return whether the event store is ready for requests."""

    def requeue_dead_letter(self, outbox_id: str, tenant_id: str, available_at: str | None = None) -> dict[str, str]:
        """Requeue a dead-letter message for the authenticated tenant."""


class EventHealthCheck(Protocol):
    """Minimal health port used by the API composition root."""

    def ready(self) -> bool:
        """Return whether the backing event store is ready."""
