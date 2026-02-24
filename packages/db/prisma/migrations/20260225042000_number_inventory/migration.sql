DO $$ BEGIN
  CREATE TYPE "PhoneNumberProvider" AS ENUM ('TWILIO','VOIPMS');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PhoneNumberStatus" AS ENUM ('ACTIVE','RELEASING','RELEASED','SUSPENDED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "defaultSmsFromNumberId" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultVoiceFromNumberId" TEXT,
  ADD COLUMN IF NOT EXISTS "numberPurchaseEnabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "SmsMessage"
  ADD COLUMN IF NOT EXISTS "fromNumberId" TEXT;

ALTER TABLE "PhoneNumber"
  ADD COLUMN IF NOT EXISTS "provider" "PhoneNumberProvider" NOT NULL DEFAULT 'TWILIO',
  ADD COLUMN IF NOT EXISTS "phoneNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "providerId" TEXT,
  ADD COLUMN IF NOT EXISTS "friendlyName" TEXT,
  ADD COLUMN IF NOT EXISTS "capabilities" JSONB,
  ADD COLUMN IF NOT EXISTS "region" TEXT,
  ADD COLUMN IF NOT EXISTS "areaCode" TEXT,
  ADD COLUMN IF NOT EXISTS "monthlyCostCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "releasedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "PhoneNumber" SET "phoneNumber" = COALESCE("phoneNumber", "e164") WHERE "phoneNumber" IS NULL;

ALTER TABLE "PhoneNumber"
  ALTER COLUMN "phoneNumber" SET NOT NULL;

ALTER TABLE "PhoneNumber"
  ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "PhoneNumber"
  ALTER COLUMN "status" TYPE "PhoneNumberStatus"
  USING (
    CASE UPPER(COALESCE("status"::text, 'ACTIVE'))
      WHEN 'ACTIVE' THEN 'ACTIVE'::"PhoneNumberStatus"
      WHEN 'RELEASING' THEN 'RELEASING'::"PhoneNumberStatus"
      WHEN 'RELEASED' THEN 'RELEASED'::"PhoneNumberStatus"
      WHEN 'SUSPENDED' THEN 'SUSPENDED'::"PhoneNumberStatus"
      ELSE 'ACTIVE'::"PhoneNumberStatus"
    END
  );

ALTER TABLE "PhoneNumber"
  ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

DO $$ BEGIN
  ALTER TABLE "PhoneNumber" DROP COLUMN IF EXISTS "e164";
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Tenant"
    ADD CONSTRAINT "Tenant_defaultSmsFromNumberId_fkey"
    FOREIGN KEY ("defaultSmsFromNumberId") REFERENCES "PhoneNumber"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SmsMessage"
    ADD CONSTRAINT "SmsMessage_fromNumberId_fkey"
    FOREIGN KEY ("fromNumberId") REFERENCES "PhoneNumber"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "PhoneNumber_phoneNumber_key" ON "PhoneNumber"("phoneNumber");
CREATE INDEX IF NOT EXISTS "PhoneNumber_tenantId_status_idx" ON "PhoneNumber"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "PhoneNumber_provider_status_idx" ON "PhoneNumber"("provider", "status");
