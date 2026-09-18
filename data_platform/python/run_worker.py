from __future__ import annotations

import logging
import os
import signal

from .worker import PostgresEventWorker, default_database_url
from .payment_processor import PaymentEventProcessor


def main() -> None:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s")
    stopped = False

    def stop(_signum: int, _frame: object) -> None:
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGINT, stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, stop)

    worker = PostgresEventWorker(
        default_database_url(),
        handler=PaymentEventProcessor(os.getenv("CONTROL_TOWER_WORKER_ACTOR_ID", "system:processor")),
        max_attempts=int(os.getenv("CONTROL_TOWER_WORKER_MAX_ATTEMPTS", "3")),
        base_delay_ms=int(os.getenv("CONTROL_TOWER_WORKER_BASE_DELAY_MS", "1000")),
        max_delay_ms=int(os.getenv("CONTROL_TOWER_WORKER_MAX_DELAY_MS", "60000")),
        lease_ms=int(os.getenv("CONTROL_TOWER_WORKER_LEASE_MS", "300000")),
    )
    worker.run_forever(int(os.getenv("CONTROL_TOWER_WORKER_POLL_MS", "250")), lambda: stopped)


if __name__ == "__main__":
    main()
