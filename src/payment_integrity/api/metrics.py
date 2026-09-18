"""Small in-process metrics registry for local operation."""

from __future__ import annotations

from threading import Lock


class MetricsRegistry:
    def __init__(self) -> None:
        self._counters: dict[str, float] = {}
        self._lock = Lock()

    def increment(self, name: str, value: float = 1) -> None:
        if value < 0:
            raise ValueError("incremento de métrica inválido")
        metric_name = "".join(character if character.isalnum() or character == "_" else "_" for character in name)
        with self._lock:
            self._counters[metric_name] = self._counters.get(metric_name, 0) + value

    def to_prometheus(self) -> str:
        with self._lock:
            snapshot = dict(self._counters)
        return "\n".join(f"{name} {value:g}" for name, value in sorted(snapshot.items()))
