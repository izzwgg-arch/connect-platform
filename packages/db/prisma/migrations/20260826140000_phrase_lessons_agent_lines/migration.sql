-- AlterTable
ALTER TABLE "SupermarketOrderDraft" ADD COLUMN     "agentLines" JSONB;

-- CreateTable
CREATE TABLE "SupermarketPhraseLesson" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phrase" TEXT NOT NULL,
    "posProductId" TEXT NOT NULL,
    "timesConfirmed" INTEGER NOT NULL DEFAULT 1,
    "lastConfirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupermarketPhraseLesson_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupermarketPhraseLesson_tenantId_lastConfirmedAt_idx" ON "SupermarketPhraseLesson"("tenantId", "lastConfirmedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupermarketPhraseLesson_tenantId_phrase_posProductId_key" ON "SupermarketPhraseLesson"("tenantId", "phrase", "posProductId");

-- AddForeignKey
ALTER TABLE "SupermarketPhraseLesson" ADD CONSTRAINT "SupermarketPhraseLesson_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

