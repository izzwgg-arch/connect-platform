ALTER TABLE "CallInvite"
  ADD COLUMN IF NOT EXISTS "pbxSipUsername" TEXT,
  ADD COLUMN IF NOT EXISTS "sipCallTarget" TEXT,
  ADD COLUMN IF NOT EXISTS "fromDisplay" TEXT,
  ADD COLUMN IF NOT EXISTS "createdByEventId" TEXT,
  ADD COLUMN IF NOT EXISTS "acceptedByDeviceId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'CallInvite_acceptedByDeviceId_fkey'
  ) THEN
    ALTER TABLE "CallInvite"
      ADD CONSTRAINT "CallInvite_acceptedByDeviceId_fkey"
      FOREIGN KEY ("acceptedByDeviceId") REFERENCES "MobileDevice"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "CallInvite_acceptedByDeviceId_idx"
  ON "CallInvite"("acceptedByDeviceId");
