CREATE TABLE IF NOT EXISTS "MobileProvisioningToken" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MobileProvisioningToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MobileProvisioningToken_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MobileProvisioningToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "MobileProvisioningToken_tokenHash_key" ON "MobileProvisioningToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "MobileProvisioningToken_tenantId_userId_createdAt_idx" ON "MobileProvisioningToken"("tenantId", "userId", "createdAt");
CREATE INDEX IF NOT EXISTS "MobileProvisioningToken_expiresAt_usedAt_idx" ON "MobileProvisioningToken"("expiresAt", "usedAt");
