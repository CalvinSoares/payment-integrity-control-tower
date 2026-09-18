import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { createPaymentEvent } from "../domain/events/payment-event.js";
import type { ExceptionFilters } from "../application/control-tower.js";
import type { ExceptionOperationsService } from "../application/exception-operations.js";
import type { EventIngestionService } from "../application/event-ingestion.js";
import type { DeadLetterService } from "../application/dead-letter.js";
import type { ReconciliationService, SettlementIngestionService } from "../application/settlement.js";
import type { ControlTowerQueries } from "../application/control-tower.js";
import type { Authenticator, AuthPrincipal } from "./auth.js";
import type { HealthChecker } from "./health.js";
import { MetricsRegistry } from "../observability/metrics.js";
import { consoleLogger, type StructuredLogger } from "../observability/logger.js";

export type ApiDependencies = {
  authenticator: Authenticator;
  eventIngestion: Pick<EventIngestionService, "receive">;
  deadLetters?: Pick<DeadLetterService, "requeue">;
  settlementIngestion: Pick<SettlementIngestionService, "receiveCsv">;
  reconciliation: Pick<ReconciliationService, "reconcile" | "reprocessException">;
  exceptions: Pick<ExceptionOperationsService, "resolve">;
  queries: ControlTowerQueries;
  maxBodyBytes?: number;
  health?: HealthChecker;
  metrics?: MetricsRegistry;
  logger?: StructuredLogger;
};

class ApiError extends Error {
  public constructor(public readonly statusCode: number, message: string, public readonly code: string) {
    super(message);
    this.name = "ApiError";
  }
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

async function readJson(request: IncomingMessage, maxBodyBytes: number): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) throw new ApiError(413, "Payload muito grande.", "payload_too_large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) throw new ApiError(413, "Payload muito grande.", "payload_too_large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("body object");
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "JSON inválido.", "invalid_json");
  }
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string") throw new ApiError(400, `${field} é obrigatório.`, "invalid_request");
  return value;
}

function principalTenant(principal: AuthPrincipal, requestedTenant?: string): void {
  if (requestedTenant !== undefined && requestedTenant !== principal.tenantId) {
    throw new ApiError(403, "A operação não pertence ao tenant autenticado.", "tenant_forbidden");
  }
}

function requireScope(principal: AuthPrincipal, scope: string): void {
  if (!principal.scopes.includes(scope) && !principal.scopes.includes("*")) {
    throw new ApiError(403, "O token não possui permissão para esta operação.", "forbidden");
  }
}

function domainStatus(code: string): number {
  if (code.includes("forbidden")) return 403;
  if (code.endsWith("_not_found")) return 404;
  if (code.includes("conflict") || code.includes("already_exists")) return 409;
  return 400;
}

function errorResponse(error: unknown): { statusCode: number; body: { error: string; code: string } } {
  if (error instanceof ApiError) return { statusCode: error.statusCode, body: { error: error.message, code: error.code } };
  if (error instanceof Error && error.name === "UnauthorizedError") return { statusCode: 401, body: { error: error.message, code: "unauthorized" } };
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const domainError = error as { code: string; message: string };
    return { statusCode: domainStatus(domainError.code), body: { error: domainError.message, code: domainError.code } };
  }
  return { statusCode: 500, body: { error: "Erro interno.", code: "internal_error" } };
}

async function route(request: IncomingMessage, response: ServerResponse, dependencies: ApiDependencies): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  if (request.method === "GET" && pathname === "/health/live") {
    json(response, 200, { status: "ok" });
    return;
  }
  if (request.method === "GET" && pathname === "/health/ready") {
    const result = dependencies.health ? await dependencies.health.readiness() : { status: "degraded" as const, checks: { health_checker: "failed" as const } };
    json(response, result.status === "ok" ? 200 : 503, result);
    return;
  }
  if (request.method === "GET" && pathname === "/metrics") {
    response.statusCode = 200;
    response.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
    response.end((dependencies.metrics ?? new MetricsRegistry()).toPrometheus() + "\n");
    return;
  }
  const principal = await dependencies.authenticator.authenticate(request);
  requireScope(principal, request.method === "GET" ? "control_tower:read" : "control_tower:write");
  const maxBodyBytes = dependencies.maxBodyBytes ?? 2 * 1024 * 1024;

  if (request.method === "POST" && pathname === "/payments/events") {
    const body = await readJson(request, maxBodyBytes);
    const event = createPaymentEvent(body as never);
    principalTenant(principal, event.tenantId);
    json(response, 202, await dependencies.eventIngestion.receive(event));
    return;
  }
  const deadLetterReplay = pathname.match(/^\/events\/dead-letter\/([^/]+)\/replay$/);
  if (request.method === "POST" && deadLetterReplay) {
    if (!dependencies.deadLetters) throw new ApiError(503, "Replay da DLQ não está configurado.", "dead_letter_unavailable");
    const body = await readJson(request, maxBodyBytes);
    json(response, 202, await dependencies.deadLetters.requeue({
      outboxId: decodeURIComponent(deadLetterReplay[1] ?? ""),
      tenantId: principal.tenantId,
      ...(body.availableAt === undefined ? {} : { availableAt: stringField(body, "availableAt") }),
    }));
    return;
  }
  if (request.method === "POST" && pathname === "/settlements/imports") {
    const body = await readJson(request, maxBodyBytes);
    json(response, 202, await dependencies.settlementIngestion.receiveCsv({
      tenantId: principal.tenantId,
      provider: stringField(body, "provider"),
      providerAccountId: stringField(body, "providerAccountId"),
      fileName: stringField(body, "fileName"),
      periodStart: stringField(body, "periodStart"),
      periodEnd: stringField(body, "periodEnd"),
      receivedAt: stringField(body, "receivedAt"),
      content: stringField(body, "content"),
    }));
    return;
  }
  if (request.method === "POST" && pathname === "/reconciliation-runs") {
    const body = await readJson(request, maxBodyBytes);
    json(response, 201, await dependencies.reconciliation.reconcile({
      batchId: stringField(body, "batchId"),
      tenantId: principal.tenantId,
      ruleVersion: stringField(body, "ruleVersion"),
      idempotencyKey: stringField(body, "idempotencyKey"),
      requestedAt: stringField(body, "requestedAt"),
    }));
    return;
  }
  const paymentTimeline = pathname.match(/^\/payments\/([^/]+)\/timeline$/);
  if (request.method === "GET" && paymentTimeline) {
    const result = await dependencies.queries.getPaymentTimeline(decodeURIComponent(paymentTimeline[1] ?? ""), principal.tenantId);
    if (!result) throw new ApiError(404, "Pagamento não encontrado.", "payment_not_found");
    json(response, 200, result);
    return;
  }
  const paymentLedger = pathname.match(/^\/payments\/([^/]+)\/ledger$/);
  if (request.method === "GET" && paymentLedger) {
    const result = await dependencies.queries.getPaymentLedger(decodeURIComponent(paymentLedger[1] ?? ""), principal.tenantId);
    if (!result) throw new ApiError(404, "Pagamento não encontrado.", "payment_not_found");
    json(response, 200, { paymentId: decodeURIComponent(paymentLedger[1] ?? ""), journals: result });
    return;
  }
  if (request.method === "GET" && pathname === "/exceptions") {
    const status = url.searchParams.get("status");
    const category = url.searchParams.get("category");
    const limit = url.searchParams.get("limit");
    const filters: ExceptionFilters = {
      ...(status === null ? {} : { status: status as NonNullable<ExceptionFilters["status"]> }),
      ...(category === null ? {} : { category: category as NonNullable<ExceptionFilters["category"]> }),
      ...(limit === null ? {} : { limit: Number(limit) }),
    };
    json(response, 200, { exceptions: await dependencies.queries.listExceptions(principal.tenantId, filters) });
    return;
  }
  const reprocess = pathname.match(/^\/exceptions\/([^/]+)\/reprocess$/);
  if (request.method === "POST" && reprocess) {
    const body = await readJson(request, maxBodyBytes);
    json(response, 200, await dependencies.reconciliation.reprocessException({
      exceptionId: decodeURIComponent(reprocess[1] ?? ""),
      actorId: principal.actorId,
      requestedAt: stringField(body, "requestedAt"),
    }));
    return;
  }
  const resolve = pathname.match(/^\/exceptions\/([^/]+)\/resolve$/);
  if (request.method === "POST" && resolve) {
    const body = await readJson(request, maxBodyBytes);
    const evidence = body.evidence;
    if (!Array.isArray(evidence) || evidence.some((item) => typeof item !== "string")) {
      throw new ApiError(400, "evidence deve ser uma lista de textos.", "invalid_request");
    }
    json(response, 200, await dependencies.exceptions.resolve({
      exceptionId: decodeURIComponent(resolve[1] ?? ""),
      tenantId: principal.tenantId,
      actorId: principal.actorId,
      reason: stringField(body, "reason"),
      evidence,
      resolvedAt: stringField(body, "resolvedAt"),
    }));
    return;
  }
  json(response, 404, { error: "Rota não encontrada.", code: "route_not_found" });
}

export function createApiServer(dependencies: ApiDependencies): Server {
  const metrics = dependencies.metrics ?? new MetricsRegistry();
  const logger = dependencies.logger ?? consoleLogger;
  return createServer((request, response) => {
    const startedAt = Date.now();
    route(request, response, { ...dependencies, metrics, logger }).catch((error: unknown) => {
      const result = errorResponse(error);
      if (result.statusCode >= 500) logger.error("api_internal_error", { method: request.method, path: request.url, statusCode: result.statusCode });
      if (!response.headersSent) json(response, result.statusCode, result.body);
      else response.destroy();
    }).finally(() => {
      metrics.increment("http_requests_total");
      metrics.increment(`http_responses_${response.statusCode || 500}_total`);
      logger.info("http_request", { method: request.method, path: request.url, statusCode: response.statusCode || 500, durationMs: Date.now() - startedAt });
    });
  });
}
