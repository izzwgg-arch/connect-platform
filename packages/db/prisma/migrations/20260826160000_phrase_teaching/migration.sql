-- AlterTable
ALTER TABLE "SupermarketPhraseLesson" ADD COLUMN     "displayPhrase" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'rep',
ADD COLUMN     "timesUsed" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "SupermarketPhraseDismissal" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phrase" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupermarketPhraseDismissal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupermarketPhraseDismissal_tenantId_phrase_key" ON "SupermarketPhraseDismissal"("tenantId", "phrase");

-- AddForeignKey
ALTER TABLE "SupermarketPhraseDismissal" ADD CONSTRAINT "SupermarketPhraseDismissal_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

