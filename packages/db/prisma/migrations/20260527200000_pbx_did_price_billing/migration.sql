-- Add per-DID pricing field to TenantBillingSettings.
-- Default 0 = PBX-synced DIDs appear on invoices at no charge.
-- Set > 0 per tenant to bill for each active PbxTenantInboundDid row.
ALTER TABLE "TenantBillingSettings" ADD COLUMN "pbxDidPriceCents" INTEGER NOT NULL DEFAULT 0;
