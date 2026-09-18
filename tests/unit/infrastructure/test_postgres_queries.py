from __future__ import annotations

import unittest

from payment_integrity.infrastructure.postgres_queries import _map_journals, _map_payment, _minor


class PostgresQueriesTests(unittest.TestCase):
    def test_maps_payment_using_safe_integer_amount(self) -> None:
        result = _map_payment(("pay_1", "tenant_1", "ext_1", 1500, "BRL", "CAPTURED", "created", "updated"))

        self.assertEqual(result["amountMinor"], 1500)
        self.assertEqual(result["currency"], "BRL")

    def test_groups_ledger_lines_by_journal(self) -> None:
        result = _map_journals(
            [
                ("journal_1", "evt_1", "2026-09-18T10:00:00Z", "line_1", "cash", "DEBIT", 100, "BRL", "Payment", "pay_1"),
                ("journal_1", "evt_1", "2026-09-18T10:00:00Z", "line_2", "sales", "CREDIT", 100, "BRL", "Payment", "pay_1"),
            ]
        )

        self.assertEqual(len(result), 1)
        self.assertEqual(len(result[0]["lines"]), 2)  # type: ignore[arg-type]

    def test_rejects_unsafe_integer(self) -> None:
        with self.assertRaises(ValueError):
            _minor(9_007_199_254_740_992, "amountMinor")


if __name__ == "__main__":
    unittest.main()
