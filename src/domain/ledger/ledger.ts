import { DomainError } from "../errors.js";
import { assertMoney } from "../payments/payment.js";

export type LedgerDirection = "DEBIT" | "CREDIT";

export type LedgerLineInput = {
  accountId: string;
  direction: LedgerDirection;
  amountMinor: number;
  currency: string;
  referenceType: string;
  referenceId: string;
};

export type LedgerLine = LedgerLineInput & {
  lineId: string;
};

export type LedgerJournal = {
  journalId: string;
  sourceEventId: string;
  createdAt: string;
  lines: LedgerLine[];
};

export type CreateLedgerJournalInput = {
  journalId: string;
  sourceEventId: string;
  createdAt: string;
  lines: LedgerLineInput[];
};

function assertText(value: string, field: string): void {
  if (value.trim() === "") {
    throw new DomainError("invalid_ledger", `${field} é obrigatório.`);
  }
}

export function assertBalancedJournal(journal: LedgerJournal): void {
  if (journal.lines.length < 2) {
    throw new DomainError("unbalanced_ledger", "Um journal precisa ter pelo menos duas linhas.");
  }

  const currencies = new Set(journal.lines.map((line) => line.currency));
  if (currencies.size !== 1) {
    throw new DomainError("mixed_currency_ledger", "Um journal não pode misturar moedas.");
  }

  const debitTotal = journal.lines
    .filter((line) => line.direction === "DEBIT")
    .reduce((total, line) => total + line.amountMinor, 0);
  const creditTotal = journal.lines
    .filter((line) => line.direction === "CREDIT")
    .reduce((total, line) => total + line.amountMinor, 0);

  if (debitTotal !== creditTotal) {
    throw new DomainError(
      "unbalanced_ledger",
      `Journal desbalanceado: débito ${debitTotal}, crédito ${creditTotal}.`,
    );
  }
}

export function createLedgerJournal(input: CreateLedgerJournalInput): LedgerJournal {
  assertText(input.journalId, "journalId");
  assertText(input.sourceEventId, "sourceEventId");
  if (!Number.isFinite(Date.parse(input.createdAt))) {
    throw new DomainError("invalid_date", "createdAt deve ser uma data ISO válida.");
  }

  const journal: LedgerJournal = {
    journalId: input.journalId,
    sourceEventId: input.sourceEventId,
    createdAt: input.createdAt,
    lines: input.lines.map((line, index) => {
      assertText(line.accountId, "accountId");
      assertText(line.referenceType, "referenceType");
      assertText(line.referenceId, "referenceId");
      assertMoney(line.amountMinor, line.currency);
      return { ...line, lineId: `${input.journalId}:line:${index + 1}` };
    }),
  };

  assertBalancedJournal(journal);
  return journal;
}
