export type AuditEvent = {
  auditId: string;
  tenantId: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  sourceEventId?: string;
  occurredAt: string;
  metadata: Record<string, unknown>;
};
