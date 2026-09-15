-- Desk phone setup: "text me a photo of the label".
--
-- ⛔ PURELY ADDITIVE AND SAFE ON A LIVE TABLE: two nullable columns, no index, no backfill.
-- Every existing row reads NULL, which every screen and route treats as "nobody has been asked
-- to text a photo for this phone". An older api that does not know the columns is unaffected.
--
-- labelPhotoFromE164 — the number the customer said they would text the picture FROM, stored
--                      normalised (+1XXXXXXXXXX). It is what the chat lookup matches on, so a
--                      photo from any other number is never read for this phone.
-- labelPhotoAskedAt  — when they were asked. The chat is searched only for messages that
--                      arrived AFTER this, so an older picture already in the thread cannot be
--                      mistaken for the answer to this question.
ALTER TABLE "DeskPhoneSetupPhone" ADD COLUMN     "labelPhotoFromE164" TEXT,
ADD COLUMN     "labelPhotoAskedAt" TIMESTAMP(3);
