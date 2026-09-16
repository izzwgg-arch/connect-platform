-- 10DLC texting registration admin page (2026-09-16). Additive only: four new
-- tables, no change to any existing table or row.

CREATE TABLE "TextingRegistration" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "publicSlug" TEXT NOT NULL,
    "referenceKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "businessPhone" TEXT NOT NULL,
    "businessEmail" TEXT NOT NULL,
    "contactFirstName" TEXT,
    "contactLastName" TEXT,
    "vertical" TEXT NOT NULL DEFAULT 'PROFESSIONAL',
    "numbers" JSONB NOT NULL DEFAULT '[]',
    "legalName" TEXT,
    "entityType" TEXT,
    "street" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "website" TEXT,
    "mobilePhone" TEXT,
    "signatureName" TEXT,
    "consentAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "submittedIp" TEXT,
    "content" JSONB NOT NULL DEFAULT '{}',
    "fixFields" JSONB,
    "fixNote" TEXT,
    "telnyxBrandId" TEXT,
    "tcrBrandId" TEXT,
    "brandIdentityStatus" TEXT,
    "brandStatus" TEXT,
    "brandFeedback" JSONB,
    "brandCreateStartedAt" TIMESTAMP(3),
    "brandVerifiedAt" TIMESTAMP(3),
    "pinSentAt" TIMESTAMP(3),
    "telnyxCampaignId" TEXT,
    "tcrCampaignId" TEXT,
    "campaignStatus" TEXT,
    "campaignCreateStartedAt" TIMESTAMP(3),
    "carrierReviews" JSONB,
    "failureReasons" JSONB,
    "numberAssignments" JSONB,
    "renewsAt" TIMESTAMP(3),
    "filedAt" TIMESTAMP(3),
    "filedByUserId" TEXT,
    "liveAt" TIMESTAMP(3),
    "readyEmailSentAt" TIMESTAMP(3),
    "chargeAddedAt" TIMESTAMP(3),
    "chargeReference" TEXT,
    "lastError" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TextingRegistration_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TextingRegistrationLink" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "usedAt" TIMESTAMP(3),
    "emailedTo" TEXT,
    "emailedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TextingRegistrationLink_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TextingRegistrationEin" (
    "registrationId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TextingRegistrationEin_pkey" PRIMARY KEY ("registrationId")
);

CREATE TABLE "TextingRegistrationEvent" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "actorUserId" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TextingRegistrationEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TextingRegistration_publicSlug_key" ON "TextingRegistration"("publicSlug");
CREATE UNIQUE INDEX "TextingRegistration_referenceKey_key" ON "TextingRegistration"("referenceKey");
CREATE UNIQUE INDEX "TextingRegistration_telnyxBrandId_key" ON "TextingRegistration"("telnyxBrandId");
CREATE UNIQUE INDEX "TextingRegistration_telnyxCampaignId_key" ON "TextingRegistration"("telnyxCampaignId");
CREATE INDEX "TextingRegistration_tenantId_idx" ON "TextingRegistration"("tenantId");
CREATE INDEX "TextingRegistration_status_idx" ON "TextingRegistration"("status");
CREATE UNIQUE INDEX "TextingRegistrationLink_tokenHash_key" ON "TextingRegistrationLink"("tokenHash");
CREATE INDEX "TextingRegistrationLink_registrationId_idx" ON "TextingRegistrationLink"("registrationId");
CREATE INDEX "TextingRegistrationEvent_registrationId_createdAt_idx" ON "TextingRegistrationEvent"("registrationId", "createdAt");

ALTER TABLE "TextingRegistration" ADD CONSTRAINT "TextingRegistration_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TextingRegistrationLink" ADD CONSTRAINT "TextingRegistrationLink_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "TextingRegistration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TextingRegistrationEin" ADD CONSTRAINT "TextingRegistrationEin_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "TextingRegistration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TextingRegistrationEvent" ADD CONSTRAINT "TextingRegistrationEvent_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "TextingRegistration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
