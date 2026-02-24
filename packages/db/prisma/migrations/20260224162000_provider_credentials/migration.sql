DO $$ BEGIN
  CREATE TYPE "IntegrationProvider" AS ENUM ('TWILIO', 'VOIPMS');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "AuditLog"
  ADD COLUMN IF NOT EXISTS "actorUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "provider" "IntegrationProvider";

ALTER TABLE "AuditLog"
  DROP CONSTRAINT IF EXISTS "AuditLog_actorUserId_fkey",
  ADD CONSTRAINT "AuditLog_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "ProviderCredential" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "provider" "IntegrationProvider" NOT NULL,
  "label" TEXT,
  "isEnabled" BOOLEAN NOT NULL DEFAULT false,
  "credentialsEncrypted" TEXT NOT NULL,
  "credentialsKeyId" TEXT NOT NULL DEFAULT 'v1',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdByUserId" TEXT NOT NULL,
  "updatedByUserId" TEXT NOT NULL,
  CONSTRAINT "ProviderCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProviderCredential_tenantId_provider_key"
  ON "ProviderCredential"("tenantId", "provider");

ALTER TABLE "ProviderCredential"
  DROP CONSTRAINT IF EXISTS "ProviderCredential_tenantId_fkey",
  ADD CONSTRAINT "ProviderCredential_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProviderCredential"
  DROP CONSTRAINT IF EXISTS "ProviderCredential_createdByUserId_fkey",
  ADD CONSTRAINT "ProviderCredential_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProviderCredential"
  DROP CONSTRAINT IF EXISTS "ProviderCredential_updatedByUserId_fkey",
  ADD CONSTRAINT "ProviderCredential_updatedByUserId_fkey"
    FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
