-- Yiddish pipeline monitor: the off-box half (labelling loop, dataset build,
-- fine-tune) writes its own status into this table so the portal's one page
-- can read "exactly where the agent is up to" straight from the database.
-- Additive only — a brand-new table, nothing else touched.
-- See docs/ai-context (yiddish pipeline monitor handoff) for the read side.

CREATE TABLE "YcPipelineState" (
    "id"        TEXT NOT NULL,
    "key"       TEXT NOT NULL,
    "kind"      TEXT NOT NULL,
    "status"    TEXT NOT NULL,
    "headline"  TEXT,
    "progress"  JSONB,
    "detail"    JSONB,
    "startedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YcPipelineState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "YcPipelineState_key_key" ON "YcPipelineState"("key");
CREATE INDEX "YcPipelineState_kind_updatedAt_idx" ON "YcPipelineState"("kind", "updatedAt");
