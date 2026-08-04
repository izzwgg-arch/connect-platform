-- Yiddish interface support.
--
-- Two separate facts, deliberately not merged:
--   Tenant.yiddishEnabled — was this customer set up to be OFFERED Yiddish
--                           (asked once in the onboarding wizard)
--   User.uiLanguage       — which language THIS person is currently reading
--
-- Both default to the existing behaviour, so every current tenant and user
-- carries on in English untouched.
ALTER TABLE "Tenant" ADD COLUMN "yiddishEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "uiLanguage" TEXT NOT NULL DEFAULT 'en';
