"""Configuration required to compose the Python API."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping


def _value(source: Mapping[str, str], key: str, fallback: str) -> str:
    value = source.get(key, "").strip()
    return value or fallback


def _positive_int(source: Mapping[str, str], key: str, fallback: int) -> int:
    value = source.get(key, "").strip()
    if not value:
        return fallback
    try:
        parsed = int(value)
    except ValueError as error:
        raise ValueError(f"{key} deve ser um inteiro positivo.") from error
    if parsed <= 0:
        raise ValueError(f"{key} deve ser um inteiro positivo.")
    return parsed


@dataclass(frozen=True, slots=True)
class ApiSettings:
    database_url: str
    api_token: str
    tenant_id: str
    actor_id: str
    scopes: frozenset[str]
    max_body_bytes: int

    @classmethod
    def from_env(cls, source: Mapping[str, str] | None = None) -> "ApiSettings":
        values = os.environ if source is None else source
        node_env = values.get("NODE_ENV", "development").strip()
        if node_env not in {"development", "test", "production"}:
            raise ValueError("NODE_ENV inválido.")

        token = _value(values, "CONTROL_TOWER_API_TOKEN", "local-dev-token")
        database_url = _value(values, "DATABASE_URL", "postgresql://integrity:integrity_dev@localhost:5438/payment_integrity")
        if node_env == "production":
            if token == "local-dev-token" or len(token) < 32:
                raise ValueError("CONTROL_TOWER_API_TOKEN deve ter pelo menos 32 caracteres em produção.")
            if database_url.startswith("postgresql://integrity:integrity_dev@"):
                raise ValueError("DATABASE_URL de desenvolvimento não pode ser usada em produção.")

        scopes = frozenset(
            scope.strip()
            for scope in values.get("CONTROL_TOWER_API_SCOPES", "control_tower:read,control_tower:write").split(",")
            if scope.strip()
        )
        if not scopes:
            raise ValueError("CONTROL_TOWER_API_SCOPES precisa conter ao menos um escopo.")

        return cls(
            database_url=database_url,
            api_token=token,
            tenant_id=_value(values, "CONTROL_TOWER_API_TENANT_ID", "tenant_local"),
            actor_id=_value(values, "CONTROL_TOWER_API_ACTOR_ID", "operator_local"),
            scopes=scopes,
            max_body_bytes=_positive_int(values, "CONTROL_TOWER_MAX_BODY_BYTES", 2 * 1024 * 1024),
        )
