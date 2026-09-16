-- Creative Studio (2026-09-16): images, AI video, designs, and the memory that
-- learns from how they are used.
--
-- PURELY ADDITIVE AND SAFE ON A LIVE DATABASE: nineteen new tables, no existing
-- table, column or row is touched. Generated with prisma migrate diff from HEAD's
-- schema to HEAD + the Creative models only (the shared worktree also carries
-- another session's unfinished models, which are deliberately NOT in here), then
-- reviewed by hand.
--
-- See docs/ai-context/AGENT_HANDOFF_CREATIVE_STUDIO_2026-09-15.md

-- CreateTable
CREATE TABLE "CreativeProject" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'image',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "brief" TEXT,
    "brandKitId" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'company',
    "ownerUserId" TEXT,
    "spentMicros" INTEGER NOT NULL DEFAULT 0,
    "lastOpenedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CreativeProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeDocument" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "doc" JSONB NOT NULL,
    "updatedByType" TEXT NOT NULL DEFAULT 'user',
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreativeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeOperation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorUserId" TEXT,
    "op" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreativeOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "parentVersionId" TEXT,
    "branch" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'user',
    "actorUserId" TEXT,
    "summary" TEXT,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreativeVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeAsset" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "thumbKey" TEXT,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "sha256" TEXT,
    "scanStatus" TEXT NOT NULL DEFAULT 'pending',
    "scanDetail" TEXT,
    "license" JSONB,
    "meta" JSONB,
    "favourite" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CreativeAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeReference" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "assetIds" TEXT[],
    "notes" TEXT,
    "consent" JSONB,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreativeReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeBrandKit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "guidance" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreativeBrandKit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeBrandKitItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandKitId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "assetId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreativeBrandKitItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT,
    "capability" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "idempotencyKey" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "engineId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "progressNote" TEXT,
    "workerId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "providerJobId" TEXT,
    "error" TEXT,
    "errorCode" TEXT,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "requestedByUserId" TEXT,
    "turnId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "CreativeJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeGeneration" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT,
    "jobId" TEXT,
    "capability" TEXT NOT NULL,
    "request" TEXT NOT NULL,
    "builtPrompt" TEXT,
    "negative" TEXT,
    "engineId" TEXT NOT NULL,
    "engineVersion" TEXT,
    "params" JSONB,
    "seed" TEXT,
    "referenceIds" TEXT[],
    "outputAssetIds" TEXT[],
    "workerId" TEXT,
    "renderMs" INTEGER,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "evaluation" JSONB,
    "outcome" TEXT,
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreativeGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeFeedback" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "projectId" TEXT,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT,
    "signal" TEXT NOT NULL,
    "reasonCodes" TEXT[],
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreativeFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeMemoryItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "userId" TEXT,
    "projectId" TEXT,
    "dimension" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "statement" TEXT NOT NULL,
    "evidenceCount" INTEGER NOT NULL DEFAULT 1,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.34,
    "status" TEXT NOT NULL DEFAULT 'suggested',
    "origin" TEXT NOT NULL DEFAULT 'auto',
    "lastEvidenceAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreativeMemoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeMemoryEvidence" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "memoryItemId" TEXT NOT NULL,
    "feedbackId" TEXT,
    "operationId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreativeMemoryEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeEngine" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "placement" TEXT NOT NULL DEFAULT 'hosted',
    "capabilities" TEXT[],
    "model" TEXT NOT NULL,
    "license" TEXT NOT NULL,
    "commercialOk" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "limits" JSONB,
    "costModel" JSONB,
    "secretKey" TEXT,
    "notes" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreativeEngine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeEngineStat" (
    "id" TEXT NOT NULL,
    "engineId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "runs" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "acceptedFirstTime" INTEGER NOT NULL DEFAULT 0,
    "totalMs" INTEGER NOT NULL DEFAULT 0,
    "p95Ms" INTEGER NOT NULL DEFAULT 0,
    "totalCostMicros" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreativeEngineStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeWorker" (
    "id" TEXT NOT NULL,
    "pool" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "gpuModel" TEXT,
    "vramGb" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "currentJobId" TEXT,
    "version" TEXT,
    "capabilities" TEXT[],
    "lastHeartbeatAt" TIMESTAMP(3),
    "stats" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreativeWorker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeUsage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT,
    "capability" TEXT NOT NULL,
    "engineId" TEXT,
    "measure" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "wasted" BOOLEAN NOT NULL DEFAULT false,
    "period" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreativeUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeQuota" (
    "tenantId" TEXT NOT NULL,
    "videoSeconds" INTEGER NOT NULL DEFAULT 120,
    "images" INTEGER NOT NULL DEFAULT 1000,
    "storageGb" INTEGER NOT NULL DEFAULT 20,
    "maxConcurrent" INTEGER NOT NULL DEFAULT 2,
    "premiumEngines" BOOLEAN NOT NULL DEFAULT false,
    "warnedPeriod" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreativeQuota_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "CreativeAuditEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "result" TEXT NOT NULL DEFAULT 'ok',
    "detail" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreativeAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreativeProject_tenantId_status_idx" ON "CreativeProject"("tenantId", "status");

-- CreateIndex
CREATE INDEX "CreativeProject_tenantId_updatedAt_idx" ON "CreativeProject"("tenantId", "updatedAt");

-- CreateIndex
CREATE INDEX "CreativeProject_tenantId_ownerUserId_idx" ON "CreativeProject"("tenantId", "ownerUserId");

-- CreateIndex
CREATE INDEX "CreativeDocument_tenantId_idx" ON "CreativeDocument"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CreativeDocument_projectId_type_key" ON "CreativeDocument"("projectId", "type");

-- CreateIndex
CREATE INDEX "CreativeOperation_documentId_revision_idx" ON "CreativeOperation"("documentId", "revision");

-- CreateIndex
CREATE INDEX "CreativeOperation_tenantId_createdAt_idx" ON "CreativeOperation"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "CreativeVersion_tenantId_createdAt_idx" ON "CreativeVersion"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreativeVersion_projectId_number_key" ON "CreativeVersion"("projectId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "CreativeAsset_storageKey_key" ON "CreativeAsset"("storageKey");

-- CreateIndex
CREATE INDEX "CreativeAsset_tenantId_kind_createdAt_idx" ON "CreativeAsset"("tenantId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "CreativeAsset_tenantId_projectId_idx" ON "CreativeAsset"("tenantId", "projectId");

-- CreateIndex
CREATE INDEX "CreativeAsset_expiresAt_idx" ON "CreativeAsset"("expiresAt");

-- CreateIndex
CREATE INDEX "CreativeAsset_sha256_idx" ON "CreativeAsset"("sha256");

-- CreateIndex
CREATE INDEX "CreativeReference_tenantId_kind_idx" ON "CreativeReference"("tenantId", "kind");

-- CreateIndex
CREATE INDEX "CreativeBrandKit_tenantId_idx" ON "CreativeBrandKit"("tenantId");

-- CreateIndex
CREATE INDEX "CreativeBrandKitItem_brandKitId_type_idx" ON "CreativeBrandKitItem"("brandKitId", "type");

-- CreateIndex
CREATE INDEX "CreativeBrandKitItem_tenantId_idx" ON "CreativeBrandKitItem"("tenantId");

-- CreateIndex
CREATE INDEX "CreativeJob_status_priority_createdAt_idx" ON "CreativeJob"("status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "CreativeJob_tenantId_createdAt_idx" ON "CreativeJob"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "CreativeJob_leaseExpiresAt_idx" ON "CreativeJob"("leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreativeJob_tenantId_idempotencyKey_key" ON "CreativeJob"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "CreativeGeneration_tenantId_createdAt_idx" ON "CreativeGeneration"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "CreativeGeneration_projectId_createdAt_idx" ON "CreativeGeneration"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "CreativeGeneration_engineId_createdAt_idx" ON "CreativeGeneration"("engineId", "createdAt");

-- CreateIndex
CREATE INDEX "CreativeFeedback_tenantId_createdAt_idx" ON "CreativeFeedback"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "CreativeFeedback_tenantId_userId_createdAt_idx" ON "CreativeFeedback"("tenantId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "CreativeMemoryItem_tenantId_status_idx" ON "CreativeMemoryItem"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CreativeMemoryItem_tenantId_scope_userId_dimension_key" ON "CreativeMemoryItem"("tenantId", "scope", "userId", "dimension");

-- CreateIndex
CREATE INDEX "CreativeMemoryEvidence_memoryItemId_createdAt_idx" ON "CreativeMemoryEvidence"("memoryItemId", "createdAt");

-- CreateIndex
CREATE INDEX "CreativeEngineStat_day_idx" ON "CreativeEngineStat"("day");

-- CreateIndex
CREATE UNIQUE INDEX "CreativeEngineStat_engineId_capability_day_key" ON "CreativeEngineStat"("engineId", "capability", "day");

-- CreateIndex
CREATE INDEX "CreativeWorker_status_lastHeartbeatAt_idx" ON "CreativeWorker"("status", "lastHeartbeatAt");

-- CreateIndex
CREATE INDEX "CreativeUsage_tenantId_period_idx" ON "CreativeUsage"("tenantId", "period");

-- CreateIndex
CREATE INDEX "CreativeUsage_period_capability_idx" ON "CreativeUsage"("period", "capability");

-- CreateIndex
CREATE INDEX "CreativeAuditEvent_tenantId_createdAt_idx" ON "CreativeAuditEvent"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "CreativeAuditEvent_action_createdAt_idx" ON "CreativeAuditEvent"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "CreativeProject" ADD CONSTRAINT "CreativeProject_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeProject" ADD CONSTRAINT "CreativeProject_brandKitId_fkey" FOREIGN KEY ("brandKitId") REFERENCES "CreativeBrandKit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeDocument" ADD CONSTRAINT "CreativeDocument_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CreativeProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeOperation" ADD CONSTRAINT "CreativeOperation_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "CreativeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeVersion" ADD CONSTRAINT "CreativeVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CreativeProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeAsset" ADD CONSTRAINT "CreativeAsset_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeAsset" ADD CONSTRAINT "CreativeAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CreativeProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeReference" ADD CONSTRAINT "CreativeReference_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeBrandKit" ADD CONSTRAINT "CreativeBrandKit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeBrandKitItem" ADD CONSTRAINT "CreativeBrandKitItem_brandKitId_fkey" FOREIGN KEY ("brandKitId") REFERENCES "CreativeBrandKit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeJob" ADD CONSTRAINT "CreativeJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeJob" ADD CONSTRAINT "CreativeJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CreativeProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeGeneration" ADD CONSTRAINT "CreativeGeneration_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeGeneration" ADD CONSTRAINT "CreativeGeneration_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CreativeProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeGeneration" ADD CONSTRAINT "CreativeGeneration_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "CreativeJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeFeedback" ADD CONSTRAINT "CreativeFeedback_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeMemoryItem" ADD CONSTRAINT "CreativeMemoryItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeMemoryEvidence" ADD CONSTRAINT "CreativeMemoryEvidence_memoryItemId_fkey" FOREIGN KEY ("memoryItemId") REFERENCES "CreativeMemoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeUsage" ADD CONSTRAINT "CreativeUsage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeQuota" ADD CONSTRAINT "CreativeQuota_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeAuditEvent" ADD CONSTRAINT "CreativeAuditEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

