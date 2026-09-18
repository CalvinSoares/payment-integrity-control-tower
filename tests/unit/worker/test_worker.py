from __future__ import annotations

import unittest

from payment_integrity.worker.worker import PostgresEventWorker, retry_delay_ms


class WorkerTests(unittest.TestCase):
    def test_retry_delay_is_exponential_and_capped(self) -> None:
        self.assertEqual(retry_delay_ms(1, 1000, 60000), 1000)
        self.assertEqual(retry_delay_ms(2, 1000, 60000), 2000)
        self.assertEqual(retry_delay_ms(10, 1000, 60000), 60000)

    def test_rejects_invalid_retry_policy(self) -> None:
        with self.assertRaises(ValueError):
            PostgresEventWorker("postgresql://unused", max_attempts=0)
        with self.assertRaises(ValueError):
            PostgresEventWorker("postgresql://unused", base_delay_ms=2000, max_delay_ms=1000)


if __name__ == "__main__":
    unittest.main()
