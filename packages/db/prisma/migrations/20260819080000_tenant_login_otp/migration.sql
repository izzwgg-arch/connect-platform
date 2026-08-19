-- Per-tenant sign-in code (2FA-by-code), 2026-08-19.
--
-- Tenant.loginOtpRequired: OFF for every tenant. Nobody is affected the day
-- this ships; an administrator turns it on per tenant. Under the switch, users
-- who are not TOTP-enrolled get a one-time code by text or email after their
-- password, may "remember" a device for 90 days, and get 90-day sessions.
--
-- LoginOtpChallenge stores the code as a SHA-256 hash only, bound to the login
-- that requested it (preAuthJti). TrustedLoginDevice stores the remembered-
-- device token as a SHA-256 hash only, bound to one user.

ALTER TABLE "Tenant"
  ADD COLUMN "loginOtpRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "loginOtpChannel"  TEXT    NOT NULL DEFAULT 'EITHER';

CREATE TABLE "LoginOtpChallenge" (
  "id"                TEXT NOT NULL,
  "userId"            TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "preAuthJti"        TEXT NOT NULL,
  "channel"           TEXT NOT NULL,
  "destinationMasked" TEXT NOT NULL,
  "codeHash"          TEXT NOT NULL,
  "attempts"          INTEGER NOT NULL DEFAULT 0,
  "sendCount"         INTEGER NOT NULL DEFAULT 1,
  "expiresAt"         TIMESTAMP(3) NOT NULL,
  "consumedAt"        TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoginOtpChallenge_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LoginOtpChallenge_userId_createdAt_idx" ON "LoginOtpChallenge"("userId", "createdAt");
CREATE INDEX "LoginOtpChallenge_preAuthJti_idx" ON "LoginOtpChallenge"("preAuthJti");
ALTER TABLE "LoginOtpChallenge"
  ADD CONSTRAINT "LoginOtpChallenge_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TrustedLoginDevice" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "tenantId"   TEXT NOT NULL,
  "tokenHash"  TEXT NOT NULL,
  "label"      TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"  TIMESTAMP(3) NOT NULL,
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt"  TIMESTAMP(3),
  CONSTRAINT "TrustedLoginDevice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TrustedLoginDevice_tokenHash_key" ON "TrustedLoginDevice"("tokenHash");
CREATE INDEX "TrustedLoginDevice_userId_expiresAt_idx" ON "TrustedLoginDevice"("userId", "expiresAt");
ALTER TABLE "TrustedLoginDevice"
  ADD CONSTRAINT "TrustedLoginDevice_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
