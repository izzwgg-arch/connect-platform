-- AlterTable
ALTER TABLE "AgentTranscript" ADD COLUMN     "audioRef" TEXT,
ADD COLUMN     "confidence" DOUBLE PRECISION,
ADD COLUMN     "correctedAt" TIMESTAMP(3),
ADD COLUMN     "correctedBy" TEXT,
ADD COLUMN     "correctedText" TEXT,
ADD COLUMN     "glossaryHits" JSONB,
ADD COLUMN     "reviewStatus" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'live_call',
ADD COLUMN     "trainingEligible" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AgentDialectTerm" (
    "id" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "variants" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "category" TEXT NOT NULL DEFAULT 'slang',
    "gloss" TEXT,
    "englishForm" TEXT,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "addedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentDialectTerm_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentDialectTerm_category_idx" ON "AgentDialectTerm"("category");

-- CreateIndex
CREATE UNIQUE INDEX "AgentDialectTerm_term_key" ON "AgentDialectTerm"("term");

-- CreateIndex
CREATE INDEX "AgentTranscript_source_reviewStatus_idx" ON "AgentTranscript"("source", "reviewStatus");

-- CreateIndex
CREATE INDEX "AgentTranscript_trainingEligible_language_idx" ON "AgentTranscript"("trainingEligible", "language");

