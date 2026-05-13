-- Phase 3A: CRM Campaigns + Queue
-- Enums must be created outside of a transaction when using ADD VALUE;
-- CREATE TYPE is safe in a transaction.

CREATE TYPE "CrmCampaignStatus" AS ENUM (
  'DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'
);

CREATE TYPE "CrmCampaignMemberStatus" AS ENUM (
  'PENDING', 'IN_PROGRESS', 'CONTACTED', 'CALLBACK',
  'CONVERTED', 'SKIPPED', 'DO_NOT_CALL'
);

-- CrmCampaign: named outbound calling campaign
CREATE TABLE "CrmCampaign" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "description"     TEXT,
  "status"          "CrmCampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "scriptId"        TEXT,
  "checklistId"     TEXT,
  "createdByUserId" TEXT NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CrmCampaign_pkey" PRIMARY KEY ("id")
);

-- CrmCampaignMember: queue row — one contact per campaign
CREATE TABLE "CrmCampaignMember" (
  "id"               TEXT NOT NULL,
  "tenantId"         TEXT NOT NULL,
  "campaignId"       TEXT NOT NULL,
  "contactId"        TEXT NOT NULL,
  "assignedToUserId" TEXT,
  "status"           "CrmCampaignMemberStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount"     INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt"    TIMESTAMP(3),
  "sortOrder"        INTEGER NOT NULL DEFAULT 0,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CrmCampaignMember_pkey" PRIMARY KEY ("id")
);

-- Unique: a contact can only appear once per campaign
ALTER TABLE "CrmCampaignMember"
  ADD CONSTRAINT "CrmCampaignMember_campaignId_contactId_key"
    UNIQUE ("campaignId", "contactId");

-- Foreign keys: CrmCampaign
ALTER TABLE "CrmCampaign"
  ADD CONSTRAINT "CrmCampaign_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CrmCampaign_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CrmCampaign_scriptId_fkey"
    FOREIGN KEY ("scriptId") REFERENCES "CrmScript"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "CrmCampaign_checklistId_fkey"
    FOREIGN KEY ("checklistId") REFERENCES "CrmChecklist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Foreign keys: CrmCampaignMember
ALTER TABLE "CrmCampaignMember"
  ADD CONSTRAINT "CrmCampaignMember_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CrmCampaignMember_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "CrmCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CrmCampaignMember_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CrmCampaignMember_assignedToUserId_fkey"
    FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes
CREATE INDEX "CrmCampaign_tenantId_status_createdAt_idx"
  ON "CrmCampaign"("tenantId", "status", "createdAt");

CREATE INDEX "CrmCampaignMember_tenantId_campaignId_status_sortOrder_idx"
  ON "CrmCampaignMember"("tenantId", "campaignId", "status", "sortOrder");

CREATE INDEX "CrmCampaignMember_tenantId_assignedToUserId_status_idx"
  ON "CrmCampaignMember"("tenantId", "assignedToUserId", "status");
