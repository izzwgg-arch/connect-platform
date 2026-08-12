-- Voicemail.localAudioPath + Voicemail.audioGoneAt
--
-- Background (2026-08-12): every voicemail play/preload fetched audio from the
-- PBX — a spool scan plus a file read per request. The desktop mini-dialer's
-- preloader retried voicemails whose audio is permanently gone on every 30s
-- sweep (one office: ~22,500 requests in two hours, all 404), which pinned the
-- PBX helper at 1.5 cores with zero calls and starved the MessageWaiting
-- fast-ingest path into timeouts.
--
-- localAudioPath: filename inside VOICEMAIL_AUDIO_STORAGE_DIR. Voicemail audio
-- is immutable once recorded, so after one successful PBX fetch the bytes are
-- served from Connect's own disk forever.
--
-- audioGoneAt: a successful, pagination-complete spool scan proved the
-- message's origtime is no longer in the mailbox; later requests 404 without
-- touching the PBX. Nullable and additive: existing rows read as "not yet
-- checked", which is the pre-migration behaviour exactly.
ALTER TABLE "Voicemail" ADD COLUMN "localAudioPath" TEXT;
ALTER TABLE "Voicemail" ADD COLUMN "audioGoneAt" TIMESTAMP(3);
