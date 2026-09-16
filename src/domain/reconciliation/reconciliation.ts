export const RECONCILIATION_CATEGORIES = [
  "MISSING_PAYMENT",
  "DUPLICATE_SETTLEMENT",
  "AMOUNT_MISMATCH",
  "FEE_MISMATCH",
  "SETTLEMENT_DELAYED",
] as const;

export type ReconciliationCategory = (typeof RECONCILIATION_CATEGORIES)[number];
export type ReconciliationSeverity = "LOW" | "MEDIUM" | "HIGH";
export type ReconciliationRunStatus = "COMPLETED" | "EXCEPTION";
export type ReconciliationItemStatus = "MATCHED" | "EXCEPTION";
export type ExceptionStatus = "OPEN" | "REPROCESSING" | "RESOLVED";

export type ReconciliationRun = {
  runId: string;
  tenantId: string;
  batchId: string;
  ruleVersion: string;
  idempotencyKey: string;
  status: ReconciliationRunStatus;
  createdAt: string;
  completedAt: string;
  itemCount: number;
  exceptionCount: number;
};

export type ReconciliationItem = {
  itemId: string;
  runId: string;
  batchId: string;
  rowNumber: number;
  settlementId: string;
  externalPaymentId: string;
  paymentId?: string;
  status: ReconciliationItemStatus;
  category?: ReconciliationCategory;
  severity?: ReconciliationSeverity;
  expectedMinor?: number;
  observedMinor?: number;
  differenceMinor?: number;
  currency: string;
  evidence: string[];
  ruleVersion: string;
};

export type ExceptionCase = {
  exceptionId: string;
  tenantId: string;
  runId: string;
  itemId: string;
  batchId: string;
  category: ReconciliationCategory;
  severity: ReconciliationSeverity;
  status: ExceptionStatus;
  expectedMinor?: number;
  observedMinor?: number;
  differenceMinor?: number;
  currency: string;
  evidence: string[];
  ruleVersion: string;
  reprocessable: boolean;
  createdAt: string;
  resolvedAt?: string;
  resolution?: string;
};

export function severityFor(category: ReconciliationCategory): ReconciliationSeverity {
  if (category === "MISSING_PAYMENT" || category === "AMOUNT_MISMATCH" || category === "DUPLICATE_SETTLEMENT") return "HIGH";
  return "MEDIUM";
}
