-- The support agent's ground rules (Phase 5a, 2026-08-20). Append-only: every
-- save is a new version, so the row history is the audit trail. New table only;
-- no existing table or row is touched.
CREATE TABLE "SupportGroundRule" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "allowed" TEXT NOT NULL,
    "never" TEXT NOT NULL,
    "askFirst" TEXT NOT NULL,
    "note" TEXT,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportGroundRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupportGroundRule_version_key" ON "SupportGroundRule"("version");
CREATE INDEX "SupportGroundRule_createdAt_idx" ON "SupportGroundRule"("createdAt");
