-- The public desk-phone SCAN link (2026-09-16).
--
-- ADDITIVE ONLY: one new table. No existing table, column or index is touched,
-- so this cannot disturb a running setup run or any desk-phone record.
--
-- The customer opens /phone-setup/<token> on their own phone and scans the
-- barcode sticker under each handset. Only the SHA-256 hash of the token is
-- stored here; the token itself exists once, in the link we hand out.
CREATE TABLE "DeskPhoneScanToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "firstOpenedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "scanCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeskPhoneScanToken_pkey" PRIMARY KEY ("id")
);

-- The token is looked up BY ITS HASH on every public request, so this index is
-- the hot path as well as the uniqueness guarantee.
CREATE UNIQUE INDEX "DeskPhoneScanToken_tokenHash_key" ON "DeskPhoneScanToken"("tokenHash");

CREATE INDEX "DeskPhoneScanToken_tenantId_runId_idx" ON "DeskPhoneScanToken"("tenantId", "runId");
