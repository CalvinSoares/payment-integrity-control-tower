"""Provider-agnostic settlement import rules."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone


class SettlementError(ValueError):
    """Raised when a settlement file violates the canonical contract."""


class SettlementNotFound(SettlementError):
    """Raised when a settlement entity is outside the requested tenant."""


REQUIRED_HEADERS = (
    "settlement_id",
    "external_payment_id",
    "settled_at",
    "gross_amount_minor",
    "fee_amount_minor",
    "net_amount_minor",
    "currency",
)


@dataclass(frozen=True, slots=True)
class SettlementRow:
    row_number: int
    settlement_id: str
    external_payment_id: str
    settled_at: str
    gross_amount_minor: int
    fee_amount_minor: int
    net_amount_minor: int
    currency: str

    def to_mapping(self) -> dict[str, object]:
        return {
            "rowNumber": self.row_number,
            "settlementId": self.settlement_id,
            "externalPaymentId": self.external_payment_id,
            "settledAt": self.settled_at,
            "grossAmountMinor": self.gross_amount_minor,
            "feeAmountMinor": self.fee_amount_minor,
            "netAmountMinor": self.net_amount_minor,
            "currency": self.currency,
        }


@dataclass(frozen=True, slots=True)
class SettlementBatch:
    batch_id: str
    tenant_id: str
    provider: str
    provider_account_id: str
    file_name: str
    file_checksum: str
    file_key: str
    period_start: str
    period_end: str
    received_at: str
    rows: tuple[SettlementRow, ...]

    def to_mapping(self) -> dict[str, object]:
        return {
            "batchId": self.batch_id,
            "tenantId": self.tenant_id,
            "provider": self.provider,
            "providerAccountId": self.provider_account_id,
            "fileName": self.file_name,
            "fileChecksum": self.file_checksum,
            "fileKey": self.file_key,
            "periodStart": self.period_start,
            "periodEnd": self.period_end,
            "receivedAt": self.received_at,
            "rows": [row.to_mapping() for row in self.rows],
        }


def _iso(value: str, field: str) -> str:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise SettlementError(f"{field} deve ser uma data ISO válida.") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def _minor(value: str, field: str, allow_zero: bool = True) -> int:
    if not value.isdecimal():
        raise SettlementError(f"{field} deve ser inteiro em centavos.")
    parsed = int(value)
    if not allow_zero and parsed <= 0:
        raise SettlementError(f"{field} está fora do intervalo seguro.")
    return parsed


def parse_settlement_csv(
    tenant_id: str,
    provider: str,
    provider_account_id: str,
    file_name: str,
    period_start: str,
    period_end: str,
    received_at: str,
    content: str,
) -> SettlementBatch:
    normalized_content = content.removeprefix("\ufeff")
    reader = csv.DictReader(io.StringIO(normalized_content))
    if tuple(reader.fieldnames or ()) != REQUIRED_HEADERS:
        raise SettlementError(f"Cabeçalho esperado: {','.join(REQUIRED_HEADERS)}.")

    rows: list[SettlementRow] = []
    for row_number, row in enumerate(reader, start=2):
        if None in row or any(value is None for value in row.values()):
            raise SettlementError(f"Linha {row_number} possui colunas inválidas.")
        currency = str(row["currency"]).strip().upper()
        if re.fullmatch(r"[A-Z]{3}", currency) is None:
            raise SettlementError(f"Linha {row_number} possui currency inválida.")
        settlement_id = str(row["settlement_id"]).strip()
        external_payment_id = str(row["external_payment_id"]).strip()
        if not settlement_id or not external_payment_id:
            raise SettlementError(f"Linha {row_number} possui identificador obrigatório vazio.")
        rows.append(
            SettlementRow(
                row_number=row_number,
                settlement_id=settlement_id,
                external_payment_id=external_payment_id,
                settled_at=_iso(str(row["settled_at"]).strip(), f"linha {row_number} settled_at"),
                gross_amount_minor=_minor(str(row["gross_amount_minor"]).strip(), f"linha {row_number} gross_amount_minor", False),
                fee_amount_minor=_minor(str(row["fee_amount_minor"]).strip(), f"linha {row_number} fee_amount_minor"),
                net_amount_minor=_minor(str(row["net_amount_minor"]).strip(), f"linha {row_number} net_amount_minor"),
                currency=currency,
            )
        )

    if not rows:
        raise SettlementError("O arquivo precisa de cabeçalho e ao menos uma linha.")
    start = _iso(period_start, "periodStart")
    end = _iso(period_end, "periodEnd")
    if end < start:
        raise SettlementError("periodEnd não pode ser anterior a periodStart.")
    for field, value in (("tenantId", tenant_id), ("provider", provider), ("providerAccountId", provider_account_id), ("fileName", file_name)):
        if not value.strip():
            raise SettlementError(f"{field} é obrigatório.")

    checksum = f"sha256:{hashlib.sha256(normalized_content.encode('utf-8')).hexdigest()}"
    batch_id = f"batch:{checksum.removeprefix('sha256:')[:24]}"
    file_key = json.dumps(
        [provider.strip(), provider_account_id.strip(), file_name.strip(), checksum, start, end],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return SettlementBatch(
        batch_id=batch_id,
        tenant_id=tenant_id.strip(),
        provider=provider.strip(),
        provider_account_id=provider_account_id.strip(),
        file_name=file_name.strip(),
        file_checksum=checksum,
        file_key=file_key,
        period_start=start,
        period_end=end,
        received_at=_iso(received_at, "receivedAt"),
        rows=tuple(rows),
    )
