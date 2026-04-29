-- Automatic SIP/WebRTC provisioning: tenant classification + per-extension provisioning snapshot.

-- 1. TenantKind enum for filtering real customers out of smoke/test/internal rows.
CREATE TYPE "TenantKind" AS ENUM ('CUSTOMER', 'INTERNAL', 'TEST');

ALTER TABLE "Tenant"
  ADD COLUMN "kind" "TenantKind" NOT NULL DEFAULT 'CUSTOMER';

-- One-shot classification of obviously-not-customer tenants by name pattern.
-- Real customer tenants stay at CUSTOMER (the default).
UPDATE "Tenant"
SET "kind" = 'TEST'
WHERE "kind" = 'CUSTOMER'
  AND (
    lower("name") LIKE '%smoke%'
    OR lower("name") LIKE '%sanity%'
    OR lower("name") LIKE 'test %'
    OR lower("name") LIKE '% test'
    OR lower("name") LIKE '%qa %'
    OR lower("name") LIKE '%e2e%'
    OR lower("name") LIKE '%fixture%'
    OR lower("name") LIKE '%dummy%'
    OR lower("name") LIKE '%scratch%'
  );

UPDATE "Tenant"
SET "kind" = 'INTERNAL'
WHERE "kind" = 'CUSTOMER'
  AND (
    lower("name") = 'connect'
    OR lower("name") = 'platform'
    OR lower("name") LIKE 'connect %'
    OR lower("name") LIKE '%internal%'
    OR lower("name") LIKE '%system%'
  );

-- 2. PbxExtensionLink provisioning snapshot so admins can see status + source at a glance.
CREATE TYPE "ExtensionProvisionStatus" AS ENUM ('PENDING', 'PROVISIONED', 'FAILED', 'DISABLED');
CREATE TYPE "ExtensionProvisionSource" AS ENUM ('PBX_EXISTING', 'PBX_GENERATED', 'CONNECT_GENERATED');

ALTER TABLE "PbxExtensionLink"
  ADD COLUMN "provisionStatus"    "ExtensionProvisionStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "provisionSource"    "ExtensionProvisionSource",
  ADD COLUMN "lastProvisionedAt"  TIMESTAMP(3);

-- Backfill: any link that already has an encrypted SIP password is effectively provisioned
-- (either set manually by an admin or populated by a previous sync). Mark those PROVISIONED
-- so the Users UI does not show "pending" for every existing row.
UPDATE "PbxExtensionLink"
SET "provisionStatus"   = 'PROVISIONED',
    "provisionSource"   = 'PBX_EXISTING',
    "lastProvisionedAt" = COALESCE("sipPasswordIssuedAt", "updatedAt")
WHERE "sipPasswordEncrypted" IS NOT NULL
  AND "provisionStatus" = 'PENDING';
