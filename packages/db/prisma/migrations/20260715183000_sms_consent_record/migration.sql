-- 10DLC SMS consent audit trail. Append-only, standalone table (no FK relations)
-- so consent records can be exported independently for a carrier audit.
CREATE TABLE "SmsConsentRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "optedIn" BOOLEAN NOT NULL,
    "method" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "consentText" TEXT NOT NULL,
    "consentVersion" TEXT NOT NULL,
    "phoneE164" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsConsentRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SmsConsentRecord_userId_idx" ON "SmsConsentRecord"("userId");

CREATE INDEX "SmsConsentRecord_tenantId_idx" ON "SmsConsentRecord"("tenantId");

CREATE INDEX "SmsConsentRecord_createdAt_idx" ON "SmsConsentRecord"("createdAt");
