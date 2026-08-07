-- Remember how a generated recording was made, so it can be edited instead of
-- retyped. All nullable and additive: existing rows (uploads, PBX syncs, and
-- every greeting generated before now) simply carry nulls, and a null
-- sourceText is what tells the UI there is no text to reopen.
ALTER TABLE "TenantPbxPrompt" ADD COLUMN IF NOT EXISTS "sourceText" TEXT;
ALTER TABLE "TenantPbxPrompt" ADD COLUMN IF NOT EXISTS "voiceProvider" TEXT;
ALTER TABLE "TenantPbxPrompt" ADD COLUMN IF NOT EXISTS "voiceId" TEXT;
ALTER TABLE "TenantPbxPrompt" ADD COLUMN IF NOT EXISTS "voiceModel" TEXT;
ALTER TABLE "TenantPbxPrompt" ADD COLUMN IF NOT EXISTS "voiceSettings" JSONB;
