from __future__ import annotations

import unittest

from payment_integrity.domain.settlements import SettlementError, parse_settlement_csv


CSV = "settlement_id,external_payment_id,settled_at,gross_amount_minor,fee_amount_minor,net_amount_minor,currency\nset_1,ext_1,2026-09-18T10:00:00Z,1000,50,950,brl\n"


class SettlementDomainTests(unittest.TestCase):
    def test_parses_normalizes_and_hashes_settlement_batch(self) -> None:
        batch = parse_settlement_csv(
            tenant_id="tenant_1",
            provider="simulator",
            provider_account_id="account_1",
            file_name="settlement.csv",
            period_start="2026-09-18T00:00:00Z",
            period_end="2026-09-18T23:59:59Z",
            received_at="2026-09-18T10:01:00Z",
            content=CSV,
        )

        self.assertTrue(batch.batch_id.startswith("batch:"))
        self.assertEqual(batch.rows[0].currency, "BRL")
        self.assertEqual(batch.rows[0].net_amount_minor, 950)
        self.assertEqual(batch.to_mapping()["tenantId"], "tenant_1")

    def test_rejects_period_in_reverse_order(self) -> None:
        with self.assertRaisesRegex(SettlementError, "periodEnd"):
            parse_settlement_csv(
                tenant_id="tenant_1",
                provider="simulator",
                provider_account_id="account_1",
                file_name="settlement.csv",
                period_start="2026-09-19T00:00:00Z",
                period_end="2026-09-18T00:00:00Z",
                received_at="2026-09-18T10:01:00Z",
                content=CSV,
            )

    def test_rejects_non_positive_gross_amount(self) -> None:
        with self.assertRaisesRegex(SettlementError, "gross_amount_minor"):
            parse_settlement_csv(
                tenant_id="tenant_1",
                provider="simulator",
                provider_account_id="account_1",
                file_name="settlement.csv",
                period_start="2026-09-18T00:00:00Z",
                period_end="2026-09-18T23:59:59Z",
                received_at="2026-09-18T10:01:00Z",
                content=CSV.replace(",1000,", ",0,"),
            )


if __name__ == "__main__":
    unittest.main()
