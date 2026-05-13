-- Phase 4B: CRM Local Presence Caller ID Pool
-- Associates tenant-owned DIDs with US area codes for local-presence outbound caller ID selection.
-- Only advisory: actual call still placed client-side via WebRTC/SIP.

CREATE TABLE IF NOT EXISTS "CrmCallerIdPool" (
  "id"            TEXT         NOT NULL,
  "tenantId"      TEXT         NOT NULL,
  "phoneNumberId" TEXT         NOT NULL,
  "areaCode3"     VARCHAR(3)   NOT NULL,
  "label"         TEXT,
  "isActive"      BOOLEAN      NOT NULL DEFAULT true,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CrmCallerIdPool_pkey" PRIMARY KEY ("id")
);

-- Foreign keys
ALTER TABLE "CrmCallerIdPool"
  ADD CONSTRAINT "CrmCallerIdPool_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CrmCallerIdPool"
  ADD CONSTRAINT "CrmCallerIdPool_phoneNumberId_fkey"
    FOREIGN KEY ("phoneNumberId") REFERENCES "PhoneNumber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Unique: one entry per tenant+phoneNumber pair
CREATE UNIQUE INDEX IF NOT EXISTS "CrmCallerIdPool_tenantId_phoneNumberId_key"
  ON "CrmCallerIdPool"("tenantId", "phoneNumberId");

-- For area-code lookup: tenantId + areaCode3 + isActive
CREATE INDEX IF NOT EXISTS "CrmCallerIdPool_tenantId_areaCode3_isActive_idx"
  ON "CrmCallerIdPool"("tenantId", "areaCode3", "isActive");

-- For pool listing: tenantId + isActive
CREATE INDEX IF NOT EXISTS "CrmCallerIdPool_tenantId_isActive_idx"
  ON "CrmCallerIdPool"("tenantId", "isActive");
