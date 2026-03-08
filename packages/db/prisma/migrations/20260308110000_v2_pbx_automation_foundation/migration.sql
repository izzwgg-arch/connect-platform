DO $$ BEGIN
  CREATE TYPE "CustomerTaskStatus" AS ENUM ('OPEN', 'DONE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CustomerTaskPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "CustomerTask" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT,
  "status" "CustomerTaskStatus" NOT NULL DEFAULT 'OPEN',
  "priority" "CustomerTaskPriority" NOT NULL DEFAULT 'MEDIUM',
  "dueAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "createdByUserId" TEXT NOT NULL,
  "completedByUserId" TEXT,
  CONSTRAINT "CustomerTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AutomationRule" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "triggerType" TEXT NOT NULL,
  "actionType" TEXT NOT NULL,
  "actionPayload" JSONB,
  "isEnabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "IvrSchedule" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "ivrId" TEXT NOT NULL,
  "recordingId" TEXT NOT NULL,
  "startTime" TIMESTAMP(3) NOT NULL,
  "endTime" TIMESTAMP(3) NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IvrSchedule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PbxCallEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "customerId" TEXT,
  "pbxTenantId" TEXT,
  "eventType" TEXT NOT NULL,
  "callId" TEXT,
  "fromNumber" TEXT,
  "toNumber" TEXT,
  "extension" TEXT,
  "status" TEXT,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PbxCallEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CustomerTask_tenantId_status_updatedAt_idx" ON "CustomerTask"("tenantId", "status", "updatedAt");
CREATE INDEX IF NOT EXISTS "CustomerTask_customerId_createdAt_idx" ON "CustomerTask"("customerId", "createdAt");
CREATE INDEX IF NOT EXISTS "AutomationRule_tenantId_triggerType_idx" ON "AutomationRule"("tenantId", "triggerType");
CREATE INDEX IF NOT EXISTS "IvrSchedule_tenantId_enabled_startTime_endTime_idx" ON "IvrSchedule"("tenantId", "enabled", "startTime", "endTime");
CREATE INDEX IF NOT EXISTS "PbxCallEvent_tenantId_createdAt_idx" ON "PbxCallEvent"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "PbxCallEvent_customerId_createdAt_idx" ON "PbxCallEvent"("customerId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "CustomerTask" ADD CONSTRAINT "CustomerTask_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "CustomerTask" ADD CONSTRAINT "CustomerTask_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "CustomerTask" ADD CONSTRAINT "CustomerTask_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "CustomerTask" ADD CONSTRAINT "CustomerTask_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "IvrSchedule" ADD CONSTRAINT "IvrSchedule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "PbxCallEvent" ADD CONSTRAINT "PbxCallEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "PbxCallEvent" ADD CONSTRAINT "PbxCallEvent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
