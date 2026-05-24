-- CRM Email Connection scoping (USER + TENANT) — Phase 1.5
-- All changes are additive and backward-compatible with existing per-user rows.

-- 1. Enum -----------------------------------------------------------------------
CREATE TYPE "CrmEmailConnectionScope" AS ENUM ('USER', 'TENANT');

-- 2. CrmEmailConnection: new columns + nullable userId --------------------------
ALTER TABLE "CrmEmailConnection"
  ADD COLUMN "scope"              "CrmEmailConnectionScope" NOT NULL DEFAULT 'USER',
  ADD COLUMN "managedByUserId"    TEXT,
  ADD COLUMN "isDefaultForTenant" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "label"              TEXT,
  ADD COLUMN "senderName"         TEXT;

-- userId becomes nullable so TENANT-scoped rows can omit it.
ALTER TABLE "CrmEmailConnection" ALTER COLUMN "userId" DROP NOT NULL;

-- Backfill is a no-op for existing rows: default 'USER' is already correct, and
-- no rows have isDefaultForTenant. Statement kept for clarity / safety.
UPDATE "CrmEmailConnection" SET "scope" = 'USER' WHERE "scope" IS DISTINCT FROM 'USER';

-- 3. Drop the old composite unique on (tenantId, userId) ------------------------
-- Constraint and index share the same name in Postgres for @@unique.
ALTER TABLE "CrmEmailConnection" DROP CONSTRAINT IF EXISTS "CrmEmailConnection_tenantId_userId_key";
DROP INDEX IF EXISTS "CrmEmailConnection_tenantId_userId_key";

-- 4. Partial unique indexes -----------------------------------------------------
-- One USER row per (tenantId, userId, provider)
CREATE UNIQUE INDEX "CrmEmailConnection_user_unique"
  ON "CrmEmailConnection" ("tenantId", "userId", "provider")
  WHERE "scope" = 'USER';

-- At most one default TENANT row per (tenantId, provider)
CREATE UNIQUE INDEX "CrmEmailConnection_tenant_default_unique"
  ON "CrmEmailConnection" ("tenantId", "provider")
  WHERE "scope" = 'TENANT' AND "isDefaultForTenant" = true;

-- At most one TENANT row per (tenantId, emailAddress, provider)
CREATE UNIQUE INDEX "CrmEmailConnection_tenant_email_unique"
  ON "CrmEmailConnection" ("tenantId", "emailAddress", "provider")
  WHERE "scope" = 'TENANT';

-- 5. Check constraint: USER requires userId; TENANT requires managedByUserId ----
ALTER TABLE "CrmEmailConnection"
  ADD CONSTRAINT "CrmEmailConnection_scope_userId_chk"
  CHECK (
    ("scope" = 'USER'   AND "userId" IS NOT NULL)
    OR
    ("scope" = 'TENANT' AND "managedByUserId" IS NOT NULL)
  );

-- 6. FK for managedByUserId -----------------------------------------------------
ALTER TABLE "CrmEmailConnection"
  ADD CONSTRAINT "CrmEmailConnection_managedByUserId_fkey"
  FOREIGN KEY ("managedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 7. Helpful index for scoped queries -------------------------------------------
CREATE INDEX "CrmEmailConnection_tenantId_scope_status_idx"
  ON "CrmEmailConnection" ("tenantId", "scope", "status");

-- 8. senderConnectionId on send-related tables ----------------------------------
ALTER TABLE "CrmEmailMessage"  ADD COLUMN "senderConnectionId" TEXT;
ALTER TABLE "CrmEmailThread"   ADD COLUMN "senderConnectionId" TEXT;
ALTER TABLE "CrmEmailSendLog"  ADD COLUMN "senderConnectionId" TEXT;

CREATE INDEX "CrmEmailMessage_senderConnectionId_idx"  ON "CrmEmailMessage" ("senderConnectionId");
CREATE INDEX "CrmEmailThread_senderConnectionId_idx"   ON "CrmEmailThread" ("senderConnectionId");
CREATE INDEX "CrmEmailSendLog_senderConnectionId_idx"  ON "CrmEmailSendLog" ("senderConnectionId");
