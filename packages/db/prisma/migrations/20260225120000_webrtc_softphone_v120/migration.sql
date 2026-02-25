-- v1.2.0 WebRTC softphone settings + extension ownership metadata
CREATE TYPE "DtmfMode" AS ENUM ('RFC2833', 'SIP_INFO');

ALTER TABLE "Tenant"
  ADD COLUMN "webrtcEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sipWsUrl" TEXT,
  ADD COLUMN "sipDomain" TEXT,
  ADD COLUMN "iceServers" JSONB,
  ADD COLUMN "outboundProxy" TEXT,
  ADD COLUMN "dtmfMode" "DtmfMode" NOT NULL DEFAULT 'RFC2833';

ALTER TABLE "Extension"
  ADD COLUMN "ownerUserId" TEXT;

ALTER TABLE "Extension"
  ADD CONSTRAINT "Extension_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Extension_tenantId_ownerUserId_idx" ON "Extension"("tenantId", "ownerUserId");

ALTER TABLE "PbxExtensionLink"
  ADD COLUMN "sipPasswordHash" TEXT,
  ADD COLUMN "sipPasswordIssuedAt" TIMESTAMP(3);
