-- Second (and Nth) VoIP.ms account support.
-- GlobalVoipMsConfig becomes one-row-per-account: the primary keeps id
-- "default" (every legacy consumer still reads it unchanged); extra accounts
-- get random ids and a label. Every TenantSmsNumber is stamped with the
-- account that owns it, defaulting to "default" so nothing changes for
-- existing rows.

ALTER TABLE "GlobalVoipMsConfig" ADD COLUMN "label" TEXT;

ALTER TABLE "TenantSmsNumber" ADD COLUMN "voipmsAccountId" TEXT NOT NULL DEFAULT 'default';

CREATE INDEX "TenantSmsNumber_voipmsAccountId_idx" ON "TenantSmsNumber"("voipmsAccountId");
