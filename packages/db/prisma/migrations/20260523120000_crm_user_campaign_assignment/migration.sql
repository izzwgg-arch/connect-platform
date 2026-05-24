-- CreateTable
CREATE TABLE "CrmUserCampaignAssignment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmUserCampaignAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrmUserCampaignAssignment_tenantId_userId_idx" ON "CrmUserCampaignAssignment"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "CrmUserCampaignAssignment_tenantId_campaignId_idx" ON "CrmUserCampaignAssignment"("tenantId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmUserCampaignAssignment_tenantId_userId_campaignId_key" ON "CrmUserCampaignAssignment"("tenantId", "userId", "campaignId");

-- AddForeignKey
ALTER TABLE "CrmUserCampaignAssignment" ADD CONSTRAINT "CrmUserCampaignAssignment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmUserCampaignAssignment" ADD CONSTRAINT "CrmUserCampaignAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmUserCampaignAssignment" ADD CONSTRAINT "CrmUserCampaignAssignment_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CrmCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
