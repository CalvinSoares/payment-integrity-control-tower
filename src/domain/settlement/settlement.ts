import { createHash } from "node:crypto";
import { DomainError } from "../errors.js";

export type SettlementRow = {
  rowNumber: number;
  settlementId: string;
  externalPaymentId: string;
  settledAt: string;
  grossAmountMinor: number;
  feeAmountMinor: number;
  netAmountMinor: number;
  currency: string;
};

export type SettlementBatch = {
  batchId: string;
  tenantId: string;
  provider: string;
  providerAccountId: string;
  fileName: string;
  fileChecksum: string;
  periodStart: string;
  periodEnd: string;
  receivedAt: string;
  rows: SettlementRow[];
};

export type SettlementFileInput = {
  tenantId: string;
  provider: string;
  providerAccountId: string;
  fileName: string;
  periodStart: string;
  periodEnd: string;
  receivedAt: string;
  content: string;
};

const REQUIRED_HEADERS = [
  "settlement_id",
  "external_payment_id",
  "settled_at",
  "gross_amount_minor",
  "fee_amount_minor",
  "net_amount_minor",
  "currency",
] as const;

function requiredText(value: string, field: string): string {
  if (value.trim() === "") throw new DomainError("invalid_settlement_file", `${field} é obrigatório.`);
  return value.trim();
}

function isoDate(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new DomainError("invalid_settlement_file", `${field} deve ser uma data ISO válida.`);
  return new Date(parsed).toISOString();
}

function minorUnits(value: string, field: string, allowZero = true): number {
  if (!/^\d+$/.test(value.trim())) throw new DomainError("invalid_settlement_file", `${field} deve ser inteiro em centavos.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (!allowZero && parsed <= 0)) {
    throw new DomainError("invalid_settlement_file", `${field} está fora do intervalo seguro.`);
  }
  return parsed;
}

function csvFields(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      fields.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (quoted) throw new DomainError("invalid_settlement_file", "CSV contém aspas não fechadas.");
  fields.push(current.trim());
  return fields;
}

function checksum(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

export function settlementFileDeduplicationKey(input: Pick<SettlementFileInput, "provider" | "providerAccountId" | "fileName" | "periodStart" | "periodEnd"> & { fileChecksum: string }): string {
  return JSON.stringify([
    input.provider,
    input.providerAccountId,
    input.fileName,
    input.fileChecksum,
    input.periodStart,
    input.periodEnd,
  ]);
}

export function parseSettlementCsv(input: SettlementFileInput): SettlementBatch {
  const content = input.content.replace(/^\uFEFF/, "");
  const lines = content.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length < 2) throw new DomainError("invalid_settlement_file", "O arquivo precisa de cabeçalho e ao menos uma linha.");
  const headers = csvFields(lines[0] ?? "");
  if (headers.length !== REQUIRED_HEADERS.length || headers.some((header, index) => header !== REQUIRED_HEADERS[index])) {
    throw new DomainError("invalid_settlement_file", `Cabeçalho esperado: ${REQUIRED_HEADERS.join(",")}.`);
  }
  const rows = lines.slice(1).map((line, index) => {
    const fields = csvFields(line);
    if (fields.length !== REQUIRED_HEADERS.length) {
      throw new DomainError("invalid_settlement_file", `Linha ${index + 2} possui colunas inválidas.`);
    }
    const [settlementId, externalPaymentId, settledAt, gross, fee, net, currency] = fields;
    const normalizedCurrency = requiredText(currency ?? "", `linha ${index + 2} currency`).toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
      throw new DomainError("invalid_settlement_file", `Linha ${index + 2} possui currency inválida.`);
    }
    return {
      rowNumber: index + 2,
      settlementId: requiredText(settlementId ?? "", `linha ${index + 2} settlement_id`),
      externalPaymentId: requiredText(externalPaymentId ?? "", `linha ${index + 2} external_payment_id`),
      settledAt: isoDate(requiredText(settledAt ?? "", `linha ${index + 2} settled_at`), `linha ${index + 2} settled_at`),
      grossAmountMinor: minorUnits(gross ?? "", `linha ${index + 2} gross_amount_minor`, false),
      feeAmountMinor: minorUnits(fee ?? "", `linha ${index + 2} fee_amount_minor`),
      netAmountMinor: minorUnits(net ?? "", `linha ${index + 2} net_amount_minor`),
      currency: normalizedCurrency,
    };
  });
  const periodStart = isoDate(input.periodStart, "periodStart");
  const periodEnd = isoDate(input.periodEnd, "periodEnd");
  if (Date.parse(periodEnd) < Date.parse(periodStart)) {
    throw new DomainError("invalid_settlement_file", "periodEnd não pode ser anterior a periodStart.");
  }
  const provider = requiredText(input.provider, "provider");
  const providerAccountId = requiredText(input.providerAccountId, "providerAccountId");
  const fileName = requiredText(input.fileName, "fileName");
  const tenantId = requiredText(input.tenantId, "tenantId");
  const receivedAt = isoDate(input.receivedAt, "receivedAt");
  const fileChecksum = checksum(content);
  return {
    batchId: `batch:${fileChecksum.slice("sha256:".length, "sha256:".length + 24)}`,
    tenantId,
    provider,
    providerAccountId,
    fileName,
    fileChecksum,
    periodStart,
    periodEnd,
    receivedAt,
    rows,
  };
}
