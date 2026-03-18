-- CdrTenantRule: admin-configured rules mapping DID / extension patterns to VitalPBX tenant slugs.
-- Used by the CDR ingest endpoint to assign tenantId when it cannot be resolved from AMI events.

CREATE TABLE "CdrTenantRule" (
    "id"          TEXT        NOT NULL,
    "matchType"   TEXT        NOT NULL,   -- "did" | "from_did" | "extension_prefix"
    "matchValue"  TEXT        NOT NULL,   -- phone number, DID, or prefix
    "tenantSlug"  TEXT        NOT NULL,   -- VitalPBX tenant name (without vpbx: prefix)
    "description" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CdrTenantRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CdrTenantRule_matchType_matchValue_key"
    ON "CdrTenantRule"("matchType", "matchValue");

CREATE INDEX "CdrTenantRule_matchType_matchValue_idx"
    ON "CdrTenantRule"("matchType", "matchValue");
