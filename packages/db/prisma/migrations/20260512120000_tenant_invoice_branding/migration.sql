-- Tenant-facing invoice PDF + billing email presentation (no binary logo in DB).
ALTER TABLE "TenantBillingSettings" ADD COLUMN "invoiceCompanyName" TEXT;
ALTER TABLE "TenantBillingSettings" ADD COLUMN "invoiceLogoUrl" TEXT;
ALTER TABLE "TenantBillingSettings" ADD COLUMN "invoiceSupportEmail" TEXT;
ALTER TABLE "TenantBillingSettings" ADD COLUMN "invoiceSupportPhone" TEXT;
ALTER TABLE "TenantBillingSettings" ADD COLUMN "invoiceFooterNote" TEXT;
ALTER TABLE "TenantBillingSettings" ADD COLUMN "invoicePaymentInstructions" TEXT;
