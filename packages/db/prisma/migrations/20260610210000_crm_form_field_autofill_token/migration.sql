-- Add autoFillToken to CrmFormField so form fields can be linked to a contact
-- profile token (e.g. "contact.fullName", "contact.dba") for automatic pre-fill.
ALTER TABLE "CrmFormField" ADD COLUMN "autoFillToken" TEXT;
