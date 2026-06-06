-- Funder workspace activity feed. Funders remain separate from CRM contacts,
-- but still need an append-only timeline for SMS, email, notes, and profile activity.

CREATE TABLE "FunderTimelineEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "funderId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT,
  "metadata" JSONB,
  "linkedId" TEXT,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FunderTimelineEvent_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "FunderTimelineEvent"
  ADD CONSTRAINT "FunderTimelineEvent_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FunderTimelineEvent"
  ADD CONSTRAINT "FunderTimelineEvent_funderId_fkey"
  FOREIGN KEY ("funderId") REFERENCES "Funder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FunderTimelineEvent"
  ADD CONSTRAINT "FunderTimelineEvent_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "FunderTimelineEvent_tenantId_funderId_createdAt_idx"
  ON "FunderTimelineEvent"("tenantId", "funderId", "createdAt");

CREATE INDEX "FunderTimelineEvent_tenantId_type_createdAt_idx"
  ON "FunderTimelineEvent"("tenantId", "type", "createdAt");

CREATE INDEX "FunderTimelineEvent_funderId_linkedId_idx"
  ON "FunderTimelineEvent"("funderId", "linkedId");
