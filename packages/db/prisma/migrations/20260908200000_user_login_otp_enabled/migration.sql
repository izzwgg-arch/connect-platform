-- Sign-in code (2FA by text or email) v3, 2026-09-08: PER USER, turned on by the
-- person themself on Account → Security. NULL for everyone on the day this
-- ships — nobody is affected until they turn it on.
--
-- Tenant.loginOtpRequired / loginOtpChannel (v1, 2026-08-19) are no longer read
-- by anything and stay in place on purpose: dropping them would break the OLD
-- api container (which still selects them) during the blue/green swap.

ALTER TABLE "User" ADD COLUMN "loginOtpEnabledAt" TIMESTAMP(3);
