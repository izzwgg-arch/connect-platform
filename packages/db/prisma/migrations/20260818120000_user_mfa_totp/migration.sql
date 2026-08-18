-- Multi-factor authentication (TOTP), Phase 11 of the 2026-08 security brief.
--
-- One "UserMfa" row per user who has started enrolment. "enabledAt" null means
-- a setup was started but never confirmed with a code — inert at login.
-- "totpSecretEncrypted" is the AES-256-GCM / CREDENTIALS_MASTER_KEY envelope
-- (@connect/security encryptJson); the secret is never stored in the clear.
-- "lastUsedCounter" is the RFC 6238 time-step of the last accepted code — the
-- replay guard.
--
-- Nothing is backfilled and no existing row is touched: MFA is off for every
-- account until that person enrols themself.

CREATE TABLE "UserMfa" (
  "id"                  TEXT NOT NULL,
  "userId"              TEXT NOT NULL,
  "totpSecretEncrypted" TEXT NOT NULL,
  "enabledAt"           TIMESTAMP(3),
  "lastUsedCounter"     INTEGER,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserMfa_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserMfa_userId_key" ON "UserMfa"("userId");

ALTER TABLE "UserMfa"
  ADD CONSTRAINT "UserMfa_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Single-use recovery codes, bcrypt-hashed. "usedAt" set = spent.
CREATE TABLE "UserMfaRecoveryCode" (
  "id"        TEXT NOT NULL,
  "userMfaId" TEXT NOT NULL,
  "codeHash"  TEXT NOT NULL,
  "usedAt"    TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserMfaRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserMfaRecoveryCode_userMfaId_usedAt_idx" ON "UserMfaRecoveryCode"("userMfaId", "usedAt");

ALTER TABLE "UserMfaRecoveryCode"
  ADD CONSTRAINT "UserMfaRecoveryCode_userMfaId_fkey"
  FOREIGN KEY ("userMfaId") REFERENCES "UserMfa"("id") ON DELETE CASCADE ON UPDATE CASCADE;
