-- Add pbxUserEmail to Extension: stores the email address from VitalPBX (captured during sync).
ALTER TABLE "Extension" ADD COLUMN "pbxUserEmail" TEXT;
