-- Ring-group CID prefix tag. Additive only.
-- The VitalPBX ring-group dialplan prepends a prefix to CALLERID(name)
-- (e.g. Set(CALLERID(name)=Estimates:${CALLERID(name)})). Telephony now captures
-- that prefix, deduplicated, into a SEPARATE field so the apps can render it as a
-- tag without polluting the caller name/number.

ALTER TABLE "ConnectCdr" ADD COLUMN "fromPrefix" TEXT;
ALTER TABLE "CallInvite" ADD COLUMN "fromPrefix" TEXT;
