-- Timeline email dedupe unique constraint
-- Enforces idempotency for timeline writes linked to a source row
-- Allows multiple NULL linkedId rows (Postgres unique semantics)

ALTER TABLE "CrmTimelineEvent"
ADD CONSTRAINT "CrmTimelineEvent_tenantId_type_linkedId_key" UNIQUE ("tenantId", "type", "linkedId");
