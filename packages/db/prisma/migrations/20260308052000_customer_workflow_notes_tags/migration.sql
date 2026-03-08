DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CustomerStatus') THEN
    CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'INACTIVE');
  END IF;
END $$;

ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "tags" JSONB;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE'::"CustomerStatus";
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "lastContactAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Customer_tenantId_status_idx" ON "Customer"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "Customer_tenantId_lastContactAt_idx" ON "Customer"("tenantId", "lastContactAt");

CREATE TABLE IF NOT EXISTS "CustomerNote" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdByUserId" TEXT NOT NULL,
  CONSTRAINT "CustomerNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CustomerNote_tenantId_createdAt_idx" ON "CustomerNote"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "CustomerNote_customerId_createdAt_idx" ON "CustomerNote"("customerId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerNote_tenantId_fkey') THEN
    ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerNote_customerId_fkey') THEN
    ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerNote_createdByUserId_fkey') THEN
    ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
