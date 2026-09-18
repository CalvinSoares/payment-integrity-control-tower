from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping


def _positive_integer(source: Mapping[str, str], key: str, fallback: int) -> int:
    value = source.get(key, "").strip()
    if not value:
        return fallback
    try:
        parsed = int(value)
    except ValueError as error:
        raise ValueError(f"{key} deve ser um inteiro positivo. Valor recebido: {value}") from error
    if parsed <= 0:
        raise ValueError(f"{key} deve ser um inteiro positivo. Valor recebido: {value}")
    return parsed


def _first_positive(source: Mapping[str, str], keys: tuple[str, ...], fallback: int) -> int:
    for key in keys:
        if source.get(key, "").strip():
            return _positive_integer(source, key, fallback)
    return fallback


def _production_value(source: Mapping[str, str], node_env: str, key: str, fallback: str) -> str:
    value = source.get(key, "").strip()
    if node_env == "production" and not value:
        raise ValueError(f"{key} é obrigatório em produção.")
    return value or fallback


@dataclass(frozen=True)
class Environment:
    node_env: str
    port: int
    database_url: str
    api_token: str
    api_tenant_id: str
    api_actor_id: str
    api_scopes: tuple[str, ...]
    log_level: str
    max_body_bytes: int
    worker_poll_ms: int
    worker_lease_ms: int


def load_environment(source: Mapping[str, str] | None = None) -> Environment:
    values = os.environ if source is None else source
    node_env = values.get("NODE_ENV", "development").strip()
    if node_env not in {"development", "test", "production"}:
        raise ValueError(f"NODE_ENV inválido: {node_env}")

    api_token = _production_value(values, node_env, "CONTROL_TOWER_API_TOKEN", "local-dev-token")
    if node_env == "production" and len(api_token) < 32:
        raise ValueError("CONTROL_TOWER_API_TOKEN deve ter pelo menos 32 caracteres em produção.")
    database_url = _production_value(
        values,
        node_env,
        "DATABASE_URL",
        "postgresql://integrity:integrity_dev@localhost:5438/payment_integrity",
    )
    tenant_id = _production_value(values, node_env, "CONTROL_TOWER_API_TENANT_ID", "tenant_local")
    actor_id = _production_value(values, node_env, "CONTROL_TOWER_API_ACTOR_ID", "operator_local")
    scope_text = values.get("CONTROL_TOWER_API_SCOPES", "control_tower:read,control_tower:write")
    scopes = tuple(scope.strip() for scope in scope_text.split(",") if scope.strip())
    if not scopes:
        raise ValueError("CONTROL_TOWER_API_SCOPES precisa conter ao menos um escopo.")
    log_level = values.get("APP_LOG_LEVEL", "info").strip().lower()
    if log_level not in {"debug", "info", "warn", "error"}:
        raise ValueError(f"APP_LOG_LEVEL inválido: {log_level}")
    return Environment(
        node_env=node_env,
        port=_first_positive(values, ("CONTROL_TOWER_PYTHON_API_PORT", "CONTROL_TOWER_API_PORT", "PORT"), 4100),
        database_url=database_url,
        api_token=api_token,
        api_tenant_id=tenant_id,
        api_actor_id=actor_id,
        api_scopes=scopes,
        log_level=log_level,
        max_body_bytes=_positive_integer(values, "CONTROL_TOWER_MAX_BODY_BYTES", 2 * 1024 * 1024),
        worker_poll_ms=_positive_integer(values, "CONTROL_TOWER_WORKER_POLL_MS", 250),
        worker_lease_ms=_positive_integer(values, "CONTROL_TOWER_WORKER_LEASE_MS", 5 * 60 * 1000),
    )
