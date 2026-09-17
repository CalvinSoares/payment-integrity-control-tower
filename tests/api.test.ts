import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiServer, type ApiDependencies } from "../src/api/server.js";
import { BearerTokenAuthenticator } from "../src/api/auth.js";
import { hashEventData, type PaymentEvent } from "../src/domain/events/payment-event.js";

function event(): PaymentEvent {
  const data = { paymentId: "pay_api", externalPaymentId: "external_api", amountMinor: 10000, currency: "BRL" };
  return {
    eventId: "evt:api:001",
    eventType: "payment.captured",
    schemaVersion: 1,
    tenantId: "tenant_a",
    provider: "simulator",
    providerAccountId: "account_api",
    externalPaymentId: "external_api",
    externalEventId: "external_evt_api",
    occurredAt: "2026-01-10T10:00:00Z",
    receivedAt: "2026-01-10T10:00:01Z",
    traceId: "trace_api",
    payloadHash: hashEventData(data),
    data,
  };
}

function httpCall(port: number, method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      port,
      method,
      path,
      headers: {
        ...(serialized === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(serialized) }),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> }));
    });
    req.on("error", reject);
    if (serialized !== undefined) req.write(serialized);
    req.end();
  });
}

describe("Control Tower API", () => {
  let port: number;
  let close: () => Promise<void>;
  let capturedTenant: string | undefined;
  let exceptionQuery: { limit?: number } | undefined;
  const timeline = {
    payment: {
      id: "pay_api",
      tenantId: "tenant_a",
      externalPaymentId: "external_api",
      amountMinor: 10000,
      currency: "BRL",
      state: "CAPTURED" as const,
      createdAt: "2026-01-10T10:00:00Z",
      updatedAt: "2026-01-10T10:00:00Z",
    },
    events: [],
    ledger: [],
    audit: [],
    settlementItems: [],
    exceptions: [],
  };
  const dependencies: ApiDependencies = {
    authenticator: new BearerTokenAuthenticator("test-token", { tenantId: "tenant_a", actorId: "actor_a", scopes: ["control_tower:read", "control_tower:write"] }),
    eventIngestion: { receive: async (received) => { capturedTenant = received.tenantId; return { status: "RECEIVED", eventId: received.eventId, inboxId: "inbox", outboxId: "outbox" }; } },
    settlementIngestion: { receiveCsv: async () => ({ status: "RECEIVED", batchId: "batch_api", rowCount: 1 }) },
    reconciliation: {
      reconcile: async () => ({ run: {} as never, items: [], exceptions: [] }),
      reprocessException: async () => ({ run: {} as never, items: [], exceptions: [], resolved: true }),
    },
    exceptions: { resolve: async () => ({} as never) },
    queries: {
      getPaymentTimeline: async () => timeline,
      getPaymentLedger: async () => [],
      listExceptions: async (_tenantId, filters) => { exceptionQuery = filters; return []; },
    },
  };

  beforeAll(async () => {
    const server = createApiServer(dependencies);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Servidor de teste não abriu porta.");
    port = address.port;
    close = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  afterAll(async () => close());

  it("requires bearer authentication", async () => {
    const response = await httpCall(port, "GET", "/exceptions");
    expect(response.status).toBe(401);
  });

  it("returns bad request for a malformed event body", async () => {
    const response = await httpCall(port, "POST", "/payments/events", { eventId: "missing-data" }, "test-token");
    expect(response.status).toBe(400);
  });

  it("accepts a canonical event for the authenticated tenant", async () => {
    const response = await httpCall(port, "POST", "/payments/events", event(), "test-token");
    expect(response.status).toBe(202);
    expect(capturedTenant).toBe("tenant_a");
  });

  it("blocks an event forged for another tenant", async () => {
    const response = await httpCall(port, "POST", "/payments/events", { ...event(), tenantId: "tenant_b" }, "test-token");
    expect(response.status).toBe(403);
  });

  it("returns tenant-scoped timeline and parses exception filters", async () => {
    const timelineResponse = await httpCall(port, "GET", "/payments/pay_api/timeline", undefined, "test-token");
    const exceptionResponse = await httpCall(port, "GET", "/exceptions?status=OPEN&limit=999", undefined, "test-token");
    expect(timelineResponse.status).toBe(200);
    expect((timelineResponse.body.payment as Record<string, unknown>).tenantId).toBe("tenant_a");
    expect(exceptionResponse.status).toBe(200);
    expect(exceptionQuery?.limit).toBe(999);
  });
});
