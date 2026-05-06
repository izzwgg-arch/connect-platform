-- MOH: separate original upload vs PBX-ready WAV; conversion tracking; drop global contentHash unique.

ALTER TABLE "MohAsset"
  ADD COLUMN "originalStorageKey" TEXT,
  ADD COLUMN "pbxStorageKey" TEXT,
  ADD COLUMN "originalMimeType" TEXT,
  ADD COLUMN "pbxFormat" TEXT,
  ADD COLUMN "conversionStatus" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "conversionError" TEXT;

UPDATE "MohAsset"
SET
  "originalStorageKey" = "storageKey",
  "originalMimeType" = "mimeType",
  "pbxStorageKey" = CASE WHEN lower("storageKey") LIKE '%.wav' THEN "storageKey" ELSE NULL END,
  "conversionStatus" = CASE
    WHEN lower("storageKey") LIKE '%.wav' AND "status" = 'ready' THEN 'ready'
    WHEN "status" = 'ready' AND NOT (lower("storageKey") LIKE '%.wav') THEN 'failed'
    ELSE 'pending'
  END,
  "conversionError" = CASE
    WHEN "status" = 'ready' AND NOT (lower("storageKey") LIKE '%.wav')
      THEN 'Legacy non-WAV upload; Connect now requires an Asterisk-safe WAV artifact. Re-upload this asset.'
    ELSE NULL
  END,
  "pbxFormat" = CASE
    WHEN lower("storageKey") LIKE '%.wav' AND "status" = 'ready' THEN 'wav_pcm_s16le_8k_mono'
    ELSE NULL
  END;

DROP INDEX IF EXISTS "MohAsset_contentHash_key";
CREATE INDEX IF NOT EXISTS "MohAsset_contentHash_idx" ON "MohAsset"("contentHash");
