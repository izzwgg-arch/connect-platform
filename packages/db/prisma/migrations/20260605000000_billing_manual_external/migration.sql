-- Migration: billing_manual_external
-- Adds external/manual payment support + full invoice editor capability.
-- All changes are additive (new enum values, new nullable columns, new indexes).
-- Safe for zero-downtime deploy.

-- 1. New enum: ExternalPaymentMethod
CREATE TYPE "ExternalPaymentMethod" AS ENUM (
  'QUICKPAY',
  'ZELLE',
  'CHECK',
  'CASH',
  'CARD_EXTERNAL',
  'ACH_EXTERNAL',
  'OTHER'
);

-- 2. Add MANUAL to BillingPaymentMethodProcessor
ALTER TYPE "BillingPaymentMethodProcessor" ADD VALUE IF NOT EXISTS 'MANUAL';

-- 3. Add TRUNK, DID, ONE_TIME, CUSTOM to BillingLineItemType
ALTER TYPE "BillingLineItemType" ADD VALUE IF NOT EXISTS 'TRUNK';
ALTER TYPE "BillingLineItemType" ADD VALUE IF NOT EXISTS 'DID';
ALTER TYPE "BillingLineItemType" ADD VALUE IF NOT EXISTS 'ONE_TIME';
ALTER TYPE "BillingLineItemType" ADD VALUE IF NOT EXISTS 'CUSTOM';

-- 4. Extend BillingInvoice with manual invoice fields
ALTER TABLE "BillingInvoice"
  ADD COLUMN IF NOT EXISTS "source"          TEXT,
  ADD COLUMN IF NOT EXISTS "createdByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "billingEmail"    TEXT;

-- Index on source for admin filtering
CREATE INDEX IF NOT EXISTS "BillingInvoice_tenantId_source_idx"
  ON "BillingInvoice" ("tenantId", "source");

-- 5. Extend PaymentTransaction with external payment fields
ALTER TABLE "PaymentTransaction"
  ADD COLUMN IF NOT EXISTS "source"             TEXT,
  ADD COLUMN IF NOT EXISTS "externalMethod"     "ExternalPaymentMethod",
  ADD COLUMN IF NOT EXISTS "externalReference"  TEXT,
  ADD COLUMN IF NOT EXISTS "payerName"          TEXT,
  ADD COLUMN IF NOT EXISTS "paymentDate"        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "externalNotes"      TEXT,
  ADD COLUMN IF NOT EXISTS "createdByUserId"    TEXT;

-- Index for auditing manual transactions per tenant
CREATE INDEX IF NOT EXISTS "PaymentTransaction_tenantId_source_idx"
  ON "PaymentTransaction" ("tenantId", "source");
