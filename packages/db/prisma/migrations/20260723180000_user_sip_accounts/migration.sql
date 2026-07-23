-- Multi-tenant SIP accounts per user (dialer "second line" feature).
-- Strictly additive: one new table, no existing row or column touched.
-- Links a Connect user to extra extensions (possibly in other tenants) so the
-- WebRTC portal phone / mobile app can register and dial from several SIP
-- accounts. Primary extension assignment (Extension.ownerUserId) is unchanged.

CREATE TABLE "UserSipAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "label" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserSipAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserSipAccount_userId_extensionId_key" ON "UserSipAccount"("userId", "extensionId");
CREATE INDEX "UserSipAccount_userId_idx" ON "UserSipAccount"("userId");
CREATE INDEX "UserSipAccount_tenantId_idx" ON "UserSipAccount"("tenantId");
CREATE INDEX "UserSipAccount_extensionId_idx" ON "UserSipAccount"("extensionId");

ALTER TABLE "UserSipAccount" ADD CONSTRAINT "UserSipAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserSipAccount" ADD CONSTRAINT "UserSipAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserSipAccount" ADD CONSTRAINT "UserSipAccount_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE CASCADE ON UPDATE CASCADE;
