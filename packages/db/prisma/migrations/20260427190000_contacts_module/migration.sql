-- Tenant-scoped contacts module.

CREATE TYPE "ContactType" AS ENUM ('INTERNAL_EXTENSION', 'EXTERNAL', 'COMPANY');
CREATE TYPE "ContactSource" AS ENUM ('MANUAL', 'EXTENSION', 'IMPORTED');
CREATE TYPE "ContactPhoneType" AS ENUM ('MOBILE', 'OFFICE', 'HOME', 'OTHER');
CREATE TYPE "ContactEmailType" AS ENUM ('WORK', 'PERSONAL', 'OTHER');

CREATE TABLE "Contact" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "type" "ContactType" NOT NULL DEFAULT 'EXTERNAL',
  "extensionId" TEXT,
  "firstName" TEXT,
  "lastName" TEXT,
  "displayName" TEXT NOT NULL,
  "company" TEXT,
  "title" TEXT,
  "avatarUrl" TEXT,
  "storageKey" TEXT,
  "notes" TEXT,
  "source" "ContactSource" NOT NULL DEFAULT 'MANUAL',
  "favorite" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "archivedAt" TIMESTAMP(3),
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContactPhone" (
  "id" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "type" "ContactPhoneType" NOT NULL DEFAULT 'MOBILE',
  "numberRaw" TEXT NOT NULL,
  "numberNormalized" TEXT NOT NULL,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ContactPhone_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContactEmail" (
  "id" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "type" "ContactEmailType" NOT NULL DEFAULT 'WORK',
  "email" TEXT NOT NULL,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ContactEmail_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContactAddress" (
  "id" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "street" TEXT,
  "city" TEXT,
  "state" TEXT,
  "zip" TEXT,
  "country" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ContactAddress_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContactTag" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "color" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ContactTag_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContactTagAssignment" (
  "contactId" TEXT NOT NULL,
  "tagId" TEXT NOT NULL,

  CONSTRAINT "ContactTagAssignment_pkey" PRIMARY KEY ("contactId","tagId")
);

CREATE UNIQUE INDEX "Contact_tenantId_extensionId_key" ON "Contact"("tenantId", "extensionId");
CREATE INDEX "Contact_tenantId_type_active_idx" ON "Contact"("tenantId", "type", "active");
CREATE INDEX "Contact_tenantId_displayName_idx" ON "Contact"("tenantId", "displayName");
CREATE INDEX "Contact_tenantId_favorite_idx" ON "Contact"("tenantId", "favorite");
CREATE INDEX "Contact_tenantId_archivedAt_idx" ON "Contact"("tenantId", "archivedAt");

CREATE UNIQUE INDEX "ContactPhone_contactId_numberNormalized_key" ON "ContactPhone"("contactId", "numberNormalized");
CREATE INDEX "ContactPhone_numberNormalized_idx" ON "ContactPhone"("numberNormalized");

CREATE UNIQUE INDEX "ContactEmail_contactId_email_key" ON "ContactEmail"("contactId", "email");
CREATE INDEX "ContactEmail_email_idx" ON "ContactEmail"("email");

CREATE UNIQUE INDEX "ContactTag_tenantId_name_key" ON "ContactTag"("tenantId", "name");
CREATE INDEX "ContactTag_tenantId_name_idx" ON "ContactTag"("tenantId", "name");

CREATE INDEX "ContactTagAssignment_tagId_idx" ON "ContactTagAssignment"("tagId");

ALTER TABLE "Contact" ADD CONSTRAINT "Contact_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContactPhone" ADD CONSTRAINT "ContactPhone_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactEmail" ADD CONSTRAINT "ContactEmail_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactAddress" ADD CONSTRAINT "ContactAddress_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactTag" ADD CONSTRAINT "ContactTag_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactTagAssignment" ADD CONSTRAINT "ContactTagAssignment_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactTagAssignment" ADD CONSTRAINT "ContactTagAssignment_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "ContactTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
