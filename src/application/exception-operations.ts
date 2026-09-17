import { DomainError } from "../domain/errors.js";
import type { ExceptionCase } from "../domain/reconciliation/reconciliation.js";
import type { SettlementRepositoryPorts, SettlementTransactionRunner } from "./settlement-ports.js";

export class ExceptionOperationsService {
  public constructor(private readonly transaction: SettlementTransactionRunner) {}

  public async resolve(input: {
    exceptionId: string;
    tenantId: string;
    actorId: string;
    reason: string;
    evidence: string[];
    resolvedAt: string;
  }): Promise<ExceptionCase> {
    if (input.reason.trim() === "") throw new DomainError("invalid_exception_resolution", "reason é obrigatório.");
    if (input.evidence.length === 0) throw new DomainError("invalid_exception_resolution", "evidence é obrigatório.");
    return this.transaction.run(async (ports: SettlementRepositoryPorts) => {
      const exception = await ports.exceptions.getById(input.exceptionId);
      if (!exception || exception.tenantId !== input.tenantId) {
        throw new DomainError("exception_not_found", "Exceção não encontrada.");
      }
      if (exception.status === "RESOLVED") return exception;
      await ports.exceptions.markResolved(
        exception.exceptionId,
        input.resolvedAt,
        `${input.reason} | evidências: ${input.evidence.join(", ")}`,
      );
      await ports.audit.append({
        auditId: `audit:exception-resolve:${exception.exceptionId}:${input.resolvedAt}`,
        tenantId: exception.tenantId,
        actorId: input.actorId,
        action: "EXCEPTION_RESOLVED",
        entityType: "ExceptionCase",
        entityId: exception.exceptionId,
        occurredAt: input.resolvedAt,
        metadata: { reason: input.reason, evidence: input.evidence, category: exception.category },
      });
      const resolved = await ports.exceptions.getById(exception.exceptionId);
      if (!resolved) throw new Error("Exceção resolvida não pôde ser recarregada.");
      return resolved;
    });
  }
}
