-- Store the AMI Cdr dcontext field on each ConnectCdr row.
-- dcontext is the most authoritative direction signal from Asterisk
-- (e.g. "ext-local-gesheft" = outbound/internal, "from-trunk" = inbound).
-- Used by canonicalDirection() to override number-length heuristics.

ALTER TABLE "ConnectCdr" ADD COLUMN "dcontext" TEXT;
