-- Persistent translation cache for the Yiddish Labs bridge. Additive; no impact
-- on existing tables or the live platform.
CREATE TABLE "AgentTranslation" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "srcHash" TEXT NOT NULL,
    "srcText" TEXT NOT NULL,
    "outText" TEXT NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentTranslation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentTranslation_action_srcHash_key" ON "AgentTranslation"("action", "srcHash");
CREATE INDEX "AgentTranslation_action_srcHash_idx" ON "AgentTranslation"("action", "srcHash");
