-- IVR takeover: record which VitalPBX menu a Connect route profile was copied
-- from. Nullable, so every existing hand-built profile is untouched.
ALTER TABLE "IvrRouteProfile" ADD COLUMN "pbxSourceIvrId" INTEGER;
ALTER TABLE "IvrRouteProfile" ADD COLUMN "pbxSourceImportedAt" TIMESTAMP(3);

-- Re-running "Copy from PBX" must update the same profile rather than stack up
-- duplicate menus. NULLs are not compared in a Postgres unique index, so every
-- hand-built profile (pbxSourceIvrId IS NULL) is unaffected.
CREATE UNIQUE INDEX "IvrRouteProfile_tenantId_pbxSourceIvrId_key"
  ON "IvrRouteProfile"("tenantId", "pbxSourceIvrId");
