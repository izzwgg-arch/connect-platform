/*
  Warnings:

  - You are about to drop the column `audience` on the `SmsCampaign` table. All the data in the column will be lost.
  - The `status` column on the `SmsCampaign` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `TenDlcSubmission` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Added the required column `audienceType` to the `SmsCampaign` table without a default value. This is not possible if the table is not empty.
  - Added the required column `fromNumber` to the `SmsCampaign` table without a default value. This is not possible if the table is not empty.
  - Added the required column `addressCity` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `addressCountry` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `addressPostalCode` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `addressState` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `addressStreet` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `ageGatedContent` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `businessType` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `einEncrypted` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `includesAffiliateMktg` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `includesEmbeddedLinks` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `includesPhoneNumbers` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `messagesPerDay` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `messagesPerMonth` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `optInMethod` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `optInWorkflow` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `sampleMessage1` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `sampleMessage2` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `sampleMessage3` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `signatureDate` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `signatureName` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `supportEmail` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `supportPhone` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `termsAccepted` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `useCaseCategory` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `websiteUrl` to the `TenDlcSubmission` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "TenDlcStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'NEEDS_INFO', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "SmsMessageStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'DELIVERED');

-- AlterTable
ALTER TABLE "SmsCampaign" DROP COLUMN "audience",
ADD COLUMN     "audienceType" TEXT NOT NULL,
ADD COLUMN     "fromNumber" TEXT NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "CampaignStatus" NOT NULL DEFAULT 'QUEUED';

-- AlterTable
ALTER TABLE "TenDlcSubmission" ADD COLUMN     "addressCity" TEXT NOT NULL,
ADD COLUMN     "addressCountry" TEXT NOT NULL,
ADD COLUMN     "addressPostalCode" TEXT NOT NULL,
ADD COLUMN     "addressState" TEXT NOT NULL,
ADD COLUMN     "addressStreet" TEXT NOT NULL,
ADD COLUMN     "ageGatedContent" BOOLEAN NOT NULL,
ADD COLUMN     "businessType" TEXT NOT NULL,
ADD COLUMN     "dba" TEXT,
ADD COLUMN     "einEncrypted" TEXT NOT NULL,
ADD COLUMN     "includesAffiliateMktg" BOOLEAN NOT NULL,
ADD COLUMN     "includesEmbeddedLinks" BOOLEAN NOT NULL,
ADD COLUMN     "includesPhoneNumbers" BOOLEAN NOT NULL,
ADD COLUMN     "internalNotes" TEXT,
ADD COLUMN     "messagesPerDay" INTEGER NOT NULL,
ADD COLUMN     "messagesPerMonth" INTEGER NOT NULL,
ADD COLUMN     "optInMethod" TEXT NOT NULL,
ADD COLUMN     "optInProofUrl" TEXT,
ADD COLUMN     "optInWorkflow" TEXT NOT NULL,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "sampleMessage1" TEXT NOT NULL,
ADD COLUMN     "sampleMessage2" TEXT NOT NULL,
ADD COLUMN     "sampleMessage3" TEXT NOT NULL,
ADD COLUMN     "signatureDate" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "signatureName" TEXT NOT NULL,
ADD COLUMN     "submittedAt" TIMESTAMP(3),
ADD COLUMN     "supportEmail" TEXT NOT NULL,
ADD COLUMN     "supportPhone" TEXT NOT NULL,
ADD COLUMN     "termsAccepted" BOOLEAN NOT NULL,
ADD COLUMN     "useCaseCategory" TEXT NOT NULL,
ADD COLUMN     "websiteUrl" TEXT NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "TenDlcStatus" NOT NULL DEFAULT 'SUBMITTED';

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "smsDailyCap" INTEGER NOT NULL DEFAULT 100;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'OWNER';

-- CreateTable
CREATE TABLE "SmsMessage" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "toNumber" TEXT NOT NULL,
    "fromNumber" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "SmsMessageStatus" NOT NULL DEFAULT 'QUEUED',
    "providerMessageId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "SmsMessage_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "SmsMessage" ADD CONSTRAINT "SmsMessage_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SmsCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
