import type { ExceptionCase, ExceptionStatus, ReconciliationCategory } from "../domain/reconciliation/reconciliation.js";
import type { LedgerJournal } from "../domain/ledger/ledger.js";
import type { Payment } from "../domain/payments/payment.js";

export type PaymentTimeline = {
  payment: Payment;
  events: Array<{ eventId: string; eventType: string; occurredAt: string; provider: string; status: string }>;
  ledger: LedgerJournal[];
  audit: Array<{ auditId: string; action: string; actorId: string; occurredAt: string; metadata: Record<string, unknown> }>;
  settlementItems: Array<{ itemId: string; status: string; category?: string; runId: string; evidence: string[] }>;
  exceptions: ExceptionCase[];
};

export type ExceptionFilters = {
  status?: ExceptionStatus;
  category?: ReconciliationCategory;
  limit?: number;
};

export interface ControlTowerQueries {
  getPaymentTimeline(paymentId: string, tenantId: string): Promise<PaymentTimeline | undefined>;
  getPaymentLedger(paymentId: string, tenantId: string): Promise<LedgerJournal[] | undefined>;
  listExceptions(tenantId: string, filters: ExceptionFilters): Promise<ExceptionCase[]>;
}
