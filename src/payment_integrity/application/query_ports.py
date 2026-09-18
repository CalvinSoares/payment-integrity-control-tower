"""Read-side ports used by the control-tower API."""

from __future__ import annotations

from typing import Protocol


class ControlTowerQueries(Protocol):
    """Port for tenant-scoped payment and exception queries."""

    def get_payment_timeline(self, payment_id: str, tenant_id: str) -> dict[str, object] | None:
        """Return the payment timeline or ``None`` when it is not visible."""

    def get_payment_ledger(self, payment_id: str, tenant_id: str) -> list[dict[str, object]] | None:
        """Return immutable ledger journals for a visible payment."""

    def list_exceptions(
        self,
        tenant_id: str,
        status: str | None,
        category: str | None,
        limit: int,
    ) -> list[dict[str, object]]:
        """Return tenant-scoped reconciliation exceptions."""
