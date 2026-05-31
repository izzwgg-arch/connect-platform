-- CreateEnum
CREATE TYPE "CrmDispositionChannel" AS ENUM ('CALL', 'SMS', 'EMAIL', 'VOICEMAIL_DROP');

-- CreateTable
CREATE TABLE "CrmContactPhoneDisposition" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "phoneId" TEXT,
    "channel" "CrmDispositionChannel" NOT NULL,
    "disposition" TEXT NOT NULL,
    "note" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmContactPhoneDisposition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrmContactPhoneDisposition_tenantId_contactId_phoneId_createdAt_idx" ON "CrmContactPhoneDisposition"("tenantId", "contactId", "phoneId", "createdAt");

-- CreateIndex
CREATE INDEX "CrmContactPhoneDisposition_tenantId_contactId_createdAt_idx" ON "CrmContactPhoneDisposition"("tenantId", "contactId", "createdAt");

-- AddForeignKey
ALTER TABLE "CrmContactPhoneDisposition" ADD CONSTRAINT "CrmContactPhoneDisposition_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmContactPhoneDisposition" ADD CONSTRAINT "CrmContactPhoneDisposition_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmContactPhoneDisposition" ADD CONSTRAINT "CrmContactPhoneDisposition_phoneId_fkey" FOREIGN KEY ("phoneId") REFERENCES "ContactPhone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmContactPhoneDisposition" ADD CONSTRAINT "CrmContactPhoneDisposition_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
