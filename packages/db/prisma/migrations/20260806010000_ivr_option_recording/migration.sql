-- A menu key can now play a recording and then continue somewhere: the
-- recording to play, and where the caller goes after it finishes (empty =
-- replay the same menu). Only used when destinationType = "announcement"
-- pointing at the Connect-owned [connect-play-prompt] dialplan context.
ALTER TABLE "IvrOptionRoute" ADD COLUMN "announcePromptRef" TEXT;
ALTER TABLE "IvrOptionRoute" ADD COLUMN "afterDestinationType" TEXT;
ALTER TABLE "IvrOptionRoute" ADD COLUMN "afterDestinationRef" TEXT;
