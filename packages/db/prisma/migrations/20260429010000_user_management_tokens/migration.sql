-- Modern tenant-aware user management.
-- Keeps existing users and password hashes intact while adding profile fields,
-- account lifecycle status, one-time invite/reset tokens, and richer audit data.

ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'TENANT_ADMIN';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'MANAGER';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'BILLING_ADMIN';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'EXTENSION_USER';

CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'DISABLED');
CREATE TYPE "UserPasswordTokenType" AS ENUM ('INVITE', 'PASSWORD_RESET');

ALTER TABLE "User"
  ADD COLUMN "firstName" TEXT,
  ADD COLUMN "lastName" TEXT,
  ADD COLUMN "displayName" TEXT,
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "title" TEXT,
  ADD COLUMN "department" TEXT,
  ADD COLUMN "notes" TEXT,
  ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "emailVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "lastLoginAt" TIMESTAMP(3),
  ADD COLUMN "forcePasswordReset" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "User"
SET "displayName" = COALESCE(NULLIF("displayName", ''), split_part("email", '@', 1)),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "displayName" IS NULL;

ALTER TABLE "AuditLog"
  ADD COLUMN "targetUserId" TEXT,
  ADD COLUMN "metadata" JSONB;

CREATE TABLE "UserPasswordToken" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "type" "UserPasswordTokenType" NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdBy" TEXT,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  CONSTRAINT "UserPasswordToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserPasswordToken_tokenHash_key" ON "UserPasswordToken"("tokenHash");
CREATE INDEX "UserPasswordToken_userId_type_createdAt_idx" ON "UserPasswordToken"("userId", "type", "createdAt");
CREATE INDEX "UserPasswordToken_type_expiresAt_idx" ON "UserPasswordToken"("type", "expiresAt");

ALTER TABLE "UserPasswordToken"
  ADD CONSTRAINT "UserPasswordToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserPasswordToken"
  ADD CONSTRAINT "UserPasswordToken_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
