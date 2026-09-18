"""Transitional PostgreSQL settlement adapter.

The current SQL implementation still lives in the legacy module while the
reconciliation tables are migrated. This adapter is the explicit boundary so
the application and API no longer import that module directly.
"""

from __future__ import annotations

from typing import cast

from data_platform.python.settlement import (
    PostgresSettlementService as LegacyPostgresSettlementService,
    SettlementError as LegacySettlementError,
    SettlementNotFound as LegacySettlementNotFound,
)

from payment_integrity.application.settlement_ports import SettlementService
from payment_integrity.domain.settlements import SettlementError, SettlementNotFound


class PostgresSettlementService:
    """Expose the legacy PostgreSQL implementation through the new port."""

    def __init__(self, database_url: str, actor_id: str = "system:settlement", delegate: SettlementService | None = None) -> None:
        self._delegate = delegate or cast(SettlementService, LegacyPostgresSettlementService(database_url, actor_id))

    def receive_csv(self, **input_data: str) -> dict[str, object]:
        try:
            return self._delegate.receive_csv(**input_data)
        except LegacySettlementError as error:
            raise SettlementError(str(error)) from error

    def reconcile(self, batch_id: str, tenant_id: str, rule_version: str, idempotency_key: str, requested_at: str) -> dict[str, object]:
        try:
            return self._delegate.reconcile(batch_id, tenant_id, rule_version, idempotency_key, requested_at)
        except LegacySettlementNotFound as error:
            raise SettlementNotFound(str(error)) from error
        except LegacySettlementError as error:
            raise SettlementError(str(error)) from error

    def resolve_exception(
        self,
        exception_id: str,
        tenant_id: str,
        actor_id: str,
        reason: str,
        evidence: list[str],
        resolved_at: str,
    ) -> dict[str, object]:
        try:
            return self._delegate.resolve_exception(exception_id, tenant_id, actor_id, reason, evidence, resolved_at)
        except LegacySettlementNotFound as error:
            raise SettlementNotFound(str(error)) from error
        except LegacySettlementError as error:
            raise SettlementError(str(error)) from error

    def reprocess_exception(self, exception_id: str, tenant_id: str, actor_id: str, requested_at: str) -> dict[str, object]:
        try:
            return self._delegate.reprocess_exception(exception_id, tenant_id, actor_id, requested_at)
        except LegacySettlementNotFound as error:
            raise SettlementNotFound(str(error)) from error
        except LegacySettlementError as error:
            raise SettlementError(str(error)) from error
