-- AlterTable
ALTER TABLE "SupermarketPhraseLesson" ADD COLUMN     "retiredAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SupermarketAgentRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "history" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupermarketAgentRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupermarketAgentRule_tenantId_active_idx" ON "SupermarketAgentRule"("tenantId", "active");

-- AddForeignKey
ALTER TABLE "SupermarketAgentRule" ADD CONSTRAINT "SupermarketAgentRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

