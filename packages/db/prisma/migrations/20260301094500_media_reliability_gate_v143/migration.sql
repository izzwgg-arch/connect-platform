DO $$ BEGIN
  CREATE TYPE "MediaTestStatus" AS ENUM ('UNKNOWN', 'PASSED', 'FAILED', 'STALE');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "MediaTestRunStatus" AS ENUM ('QUEUED', 'PASSED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "mediaReliabilityGateEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "mediaTestStatus" "MediaTestStatus" NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "mediaTestedAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "mediaLastErrorCode" TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "mediaLastErrorAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "MediaTestRun" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "status" "MediaTestRunStatus" NOT NULL DEFAULT 'QUEUED',
  "platform" "VoiceClientPlatform" NOT NULL,
  "details" JSONB,
  CONSTRAINT "MediaTestRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MediaTestRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MediaTestRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "MediaTestRun_tokenId_key" ON "MediaTestRun"("tokenId");
CREATE INDEX IF NOT EXISTS "MediaTestRun_tenantId_createdAt_idx" ON "MediaTestRun"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "MediaTestRun_tenantId_status_createdAt_idx" ON "MediaTestRun"("tenantId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "MediaTestRun_tenantId_platform_idx" ON "MediaTestRun"("tenantId", "platform");