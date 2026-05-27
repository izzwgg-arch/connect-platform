-- CreateTable: CrmBulkEmailJob
CREATE TABLE "CrmBulkEmailJob" (
    "id"              TEXT NOT NULL,
    "tenantId"        TEXT NOT NULL,
    "createdByUserId" TEXT,
    "sourceType"      TEXT NOT NULL,
    "campaignId"      TEXT,
    "tagId"           TEXT,
    "contactIds"      JSONB,
    "templateId"      TEXT NOT NULL,
    "connectionId"    TEXT,
    "status"          TEXT NOT NULL DEFAULT 'QUEUED',
    "totalCount"      INTEGER NOT NULL DEFAULT 0,
    "queuedCount"     INTEGER NOT NULL DEFAULT 0,
    "sentCount"       INTEGER NOT NULL DEFAULT 0,
    "failedCount"     INTEGER NOT NULL DEFAULT 0,
    "skippedCount"    INTEGER NOT NULL DEFAULT 0,
    "errorSummary"    TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt"       TIMESTAMP(3),
    "completedAt"     TIMESTAMP(3),

    CONSTRAINT "CrmBulkEmailJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CrmBulkEmailRecipient
CREATE TABLE "CrmBulkEmailRecipient" (
    "id"             TEXT NOT NULL,
    "jobId"          TEXT NOT NULL,
    "tenantId"       TEXT NOT NULL,
    "contactId"      TEXT,
    "funderId"       TEXT,
    "toEmail"        TEXT NOT NULL,
    "status"         TEXT NOT NULL DEFAULT 'QUEUED',
    "skipReason"     TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "gmailMessageId" TEXT,
    "errorMessage"   TEXT,
    "sentAt"         TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmBulkEmailRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrmBulkEmailJob_tenantId_createdAt_idx" ON "CrmBulkEmailJob"("tenantId", "createdAt");
CREATE INDEX "CrmBulkEmailJob_tenantId_status_idx" ON "CrmBulkEmailJob"("tenantId", "status");

CREATE UNIQUE INDEX "CrmBulkEmailRecipient_idempotencyKey_key" ON "CrmBulkEmailRecipient"("idempotencyKey");
CREATE INDEX "CrmBulkEmailRecipient_jobId_status_idx" ON "CrmBulkEmailRecipient"("jobId", "status");
CREATE INDEX "CrmBulkEmailRecipient_tenantId_jobId_idx" ON "CrmBulkEmailRecipient"("tenantId", "jobId");

-- AddForeignKey
ALTER TABLE "CrmBulkEmailJob" ADD CONSTRAINT "CrmBulkEmailJob_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CrmBulkEmailJob" ADD CONSTRAINT "CrmBulkEmailJob_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CrmBulkEmailJob" ADD CONSTRAINT "CrmBulkEmailJob_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "CrmEmailTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CrmBulkEmailJob" ADD CONSTRAINT "CrmBulkEmailJob_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "CrmEmailConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CrmBulkEmailRecipient" ADD CONSTRAINT "CrmBulkEmailRecipient_jobId_fkey"
    FOREIGN KEY ("jobId") REFERENCES "CrmBulkEmailJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
