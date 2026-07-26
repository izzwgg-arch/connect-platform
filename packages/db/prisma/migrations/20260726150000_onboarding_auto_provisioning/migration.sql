-- Automated onboarding provisioning state (VoIP.ms number + VitalPBX build)
ALTER TABLE "OnboardingSubmission" ADD COLUMN "numberStatus" TEXT;
ALTER TABLE "OnboardingSubmission" ADD COLUMN "provisionedDid" TEXT;
ALTER TABLE "OnboardingSubmission" ADD COLUMN "didIsTemporary" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "OnboardingSubmission" ADD COLUMN "voipmsSubaccountEncrypted" TEXT;
ALTER TABLE "OnboardingSubmission" ADD COLUMN "pbxSetupStatus" TEXT;
ALTER TABLE "OnboardingSubmission" ADD COLUMN "pbxTenantPath" TEXT;
ALTER TABLE "OnboardingSubmission" ADD COLUMN "setupError" TEXT;

-- Cell-phone forwarding per requested extension
ALTER TABLE "OnboardingRequestedExtension" ADD COLUMN "cellMode" TEXT;
ALTER TABLE "OnboardingRequestedExtension" ADD COLUMN "cellNumber" TEXT;
