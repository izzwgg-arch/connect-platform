-- Add optional audio-byte tracking to TenantPbxPrompt so Connect can play the
-- recording in the browser. When these are NULL the catalog row remains valid
-- for dialplan use; only the "Play" button is gated on audio being synced.
ALTER TABLE "TenantPbxPrompt"
  ADD COLUMN "storageKey"  TEXT,
  ADD COLUMN "sha256"      TEXT,
  ADD COLUMN "sizeBytes"   INTEGER,
  ADD COLUMN "contentType" TEXT,
  ADD COLUMN "syncedAt"    TIMESTAMP(3);
