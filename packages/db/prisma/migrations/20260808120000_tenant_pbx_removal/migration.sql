-- Tenants removed on the PBX.
--
-- pbxRemovedAt  : the PBX tenant is gone. The tenant drops out of every list and
--                 is not billed from this moment. Permanent erase is a separate,
--                 confirmed step so a bad PBX response can never destroy data.
-- archivedAt    : set instead of deleting when the tenant has completed
--                 payments — the books are kept, everything else is closed.
ALTER TABLE "Tenant" ADD COLUMN "pbxRemovedAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE INDEX "Tenant_pbxRemovedAt_idx" ON "Tenant"("pbxRemovedAt");

-- ConnectChatThread was the only tenant relation in the schema without an
-- onDelete rule, so it defaulted to RESTRICT: a single chat thread made
-- deleting a tenant fail with a foreign-key error. Every other tenant relation
-- cascades. Bring this one in line.
ALTER TABLE "ConnectChatThread" DROP CONSTRAINT IF EXISTS "ConnectChatThread_tenantId_fkey";
ALTER TABLE "ConnectChatThread"
  ADD CONSTRAINT "ConnectChatThread_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
