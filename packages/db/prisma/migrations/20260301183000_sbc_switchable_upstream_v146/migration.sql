DO $$
BEGIN
  CREATE TYPE "SbcMode" AS ENUM ('LOCAL', 'REMOTE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "SbcConfig" (
  "id" TEXT NOT NULL,
  "mode" "SbcMode" NOT NULL DEFAULT 'LOCAL',
  "remoteUpstreamHost" TEXT,
  "remoteUpstreamPort" INTEGER NOT NULL DEFAULT 7443,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedByUserId" TEXT,
  CONSTRAINT "SbcConfig_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SbcConfig_updatedByUserId_fkey'
  ) THEN
    ALTER TABLE "SbcConfig"
      ADD CONSTRAINT "SbcConfig_updatedByUserId_fkey"
      FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

INSERT INTO "SbcConfig" ("id", "mode", "remoteUpstreamPort")
VALUES ('default', 'LOCAL', 7443)
ON CONFLICT ("id") DO NOTHING;
