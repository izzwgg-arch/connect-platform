DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TurnValidationStatus') THEN
    CREATE TYPE "TurnValidationStatus" AS ENUM ('UNKNOWN', 'VERIFIED', 'FAILED', 'STALE');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TurnConfigScope') THEN
    CREATE TYPE "TurnConfigScope" AS ENUM ('GLOBAL', 'TENANT');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TurnValidationJobStatus') THEN
    CREATE TYPE "TurnValidationJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');
  END IF;
END $$;

ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "turnRequiredForMobile" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "turnValidationStatus" "TurnValidationStatus" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS "turnValidatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "turnLastErrorCode" TEXT,
  ADD COLUMN IF NOT EXISTS "turnLastErrorAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "TurnConfig" (
  "id" TEXT NOT NULL,
  "scope" "TurnConfigScope" NOT NULL,
  "tenantId" TEXT,
  "urls" JSONB NOT NULL,
  "username" TEXT,
  "credentialEncrypted" TEXT,
  "credentialKeyId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TurnConfig_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TurnConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "TurnValidationJob" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "status" "TurnValidationJobStatus" NOT NULL DEFAULT 'QUEUED',
  "tokenId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "platform" TEXT,
  "hasRelay" BOOLEAN,
  "durationMs" INTEGER,
  "errorCode" TEXT,
  CONSTRAINT "TurnValidationJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TurnValidationJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TurnValidationJob_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "TurnConfig_tenantId_key" ON "TurnConfig"("tenantId");
CREATE UNIQUE INDEX IF NOT EXISTS "TurnValidationJob_tokenId_key" ON "TurnValidationJob"("tokenId");
CREATE INDEX IF NOT EXISTS "TurnConfig_scope_updatedAt_idx" ON "TurnConfig"("scope", "updatedAt");
CREATE INDEX IF NOT EXISTS "TurnValidationJob_tenantId_requestedAt_idx" ON "TurnValidationJob"("tenantId", "requestedAt");
CREATE INDEX IF NOT EXISTS "TurnValidationJob_status_expiresAt_idx" ON "TurnValidationJob"("status", "expiresAt");

CREATE UNIQUE INDEX IF NOT EXISTS "TurnConfig_global_unique" ON "TurnConfig"("scope") WHERE "scope" = 'GLOBAL';
CREATE UNIQUE INDEX IF NOT EXISTS "TurnConfig_tenant_unique" ON "TurnConfig"("tenantId") WHERE "scope" = 'TENANT' AND "tenantId" IS NOT NULL;
