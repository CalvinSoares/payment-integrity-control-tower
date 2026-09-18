"""Application port for settlement and reconciliation operations."""

from __future__ import annotations

from typing import Protocol


class SettlementService(Protocol):
    def receive_csv(self, **input_data: str) -> dict[str, object]:
        """Receive a settlement file idempotently."""

    def reconcile(self, batch_id: str, tenant_id: str, rule_version: str, idempotency_key: str, requested_at: str) -> dict[str, object]:
        """Run tenant-scoped reconciliation."""

    def resolve_exception(
        self,
        exception_id: str,
        tenant_id: str,
        actor_id: str,
        reason: str,
        evidence: list[str],
        resolved_at: str,
    ) -> dict[str, object]:
        """Resolve an exception with evidence and audit trail."""

    def reprocess_exception(self, exception_id: str, tenant_id: str, actor_id: str, requested_at: str) -> dict[str, object]:
        """Reprocess an exception using the current reconciliation rules."""
