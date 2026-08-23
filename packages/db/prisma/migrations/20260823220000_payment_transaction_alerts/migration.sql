-- AlterTable
ALTER TABLE "PaymentTransaction" ADD COLUMN     "alertEmailedAt" TIMESTAMP(3),
ADD COLUMN     "alertEmailedStatus" TEXT;

