# Ticket 3GTH9M — Trust Bookkeepings ext 101 "my voicemail greeting doesn't play" (2026-09-14)

Memory: [[busy-voicemail-plays-no-custom-greeting]]. Greeting feature background:
`2026-08-04-voicemail-greeting-upload-call-to-record.md` (and its full handoff
`AGENT_HANDOFF_VM_GREETING_2026-08-04.md`).

**State:** ✅ fix `5b499073` DEPLOYED (api, queue job `4c42b792`, container `7d12c14f` which
contains it; 0 restarts, healthy, `/api/health` 200 on both hostnames; module + wiring grepped in
the container). ✅ Backfill applied to Trust 101/105/107. ⏳ **NOT PROVEN by a real call**, and
the customer has not been replied to.

## What happened (read-only, proven from the PBX full log)
- Reporter vigdor@trustbookkeepingny.com owns **ext 101** (Mr. Sofer).
- His recording EXISTS and is valid: `trust_bookkeepings-voicemail/101/unavail.wav`
  (8 kHz mono PCM, ~8 s, 2026-05-05). There was **no `busy.wav`**.
- Test call `C-000001e4`, 14:49:31 ET, from **845-608-1052** (the ticket's call-back
  number) → 845-244-1708 → IVR → ext 101 answered **BUSY in 2 s** → follow-me to
  845-248-9442 (answered, "press 1 to accept", not pressed) → `VoiceMail(101@…,b)` →
  stock "the person at extension 1-0-1 is on the phone". C-000001e0 at 14:48 same path.

## Root cause
Asterisk `app_voicemail.c` leave_voicemail (read in source, branch 20; PBX runs 20.18.2):
- flag `b` → prefile `busy`; flag `u` → `unavail`; **no flag → no prefile at all** (only vm-intro).
- `temp` greeting, if present, **replaces prefile on every path, including flagless**.
- prefile set but file missing → `invent_message` (the stock "is on the phone / unavailable").
VitalPBX: `sub-leave-vm` passes `b` when `CALL_STATUS=BUSY` else `u`; destinations
`VMB-`/`VMU-`/`VM-<ext>` pass b / u / nothing (`sub-extensions-vm`). The flagless `VM-`
destination is a deliberate "voicemail, no message" choice (44 of ~69 VoiceMail runs on
09-14, mostly Gesheft).
Connect's panel (`ProfileMenu.tsx:347`) and mobile only ever save `unavailable`.

## The fix (`5b499073`)
- New `apps/api/src/voicemailGreetingMirror.ts`: saving the unavailable greeting also writes
  the same audio as `busy.wav` — upload (`handleVoicemailGreetingUpload`) and call-to-record
  (`vmRecordCallJobs.ts`, on "saved"). Both reset routes go through
  `resetGreetingWithBusyMirror`, which removes busy.wav only when it is that copy.
- ⛔ busy.wav is written only if absent or a byte-copy of the PREVIOUS unavailable greeting —
  a distinct busy greeting (Trust 106's, May, set outside Connect) is never touched.
- ⛔ temp.wav deliberately NOT used (would override "voicemail, no message" destinations).
- Mirror failures never fail the save; logged as `voicemail-greeting: busy mirror` /
  `vm-record-call: busy mirror`. Primary reset still throws as before.
- Call-to-record is safe to copy on "changed": the dialplan Records to a tmp file and
  `mv`s it into place on press 1 (helper lines ~4423/4433).
- Blast radius traced: only callers of upload/reset/get are server.ts + vmRecordCallJobs;
  GET status/stream read the requested type (default unavailable) — unchanged; helper
  backs up an overwritten busy.wav (`.bak-<stamp>`); `tempgreetwarn` unset.
- Tests: see TESTS_RUN.md — 60/60, source guard fails against pre-fix HEAD.

## Backfill (2026-09-14 17:23 ET)
- Script `/root/backfill-busy-greeting.ts` on loopcom (copy in the container `/tmp`), run with the
  api's own module via `tsx` inside `app-api-1`; dry-run first, then `--apply`; only mailboxes with
  no busy.wav. Trust 101, 105, 107 → `created`.
- PBX read-back (read-only): `101/105/107 busy.wav` owned asterisk, 8 kHz mono 16-bit PCM,
  **sha256 identical to each unavail.wav**; `106/busy.wav` unchanged (2026-05-18, no backup made).
- Not backfilled (internal, no customer): connect_communications 1101, ezra_stress_test_1 101.

## Still open (⏳)
1. Proof = a real call to 101 while it is busy/declined that plays his recording.
2. Reply to Vigdor (text thread with +18456081052) — drafted, not sent; needs Izzy's OK.
3. Separate question for Izzy: Trust ring-group failovers use the flagless `VM-` ("no
   message") destination (104 at 12:50, 105 at 10:41 heard no greeting) — panel config, not code.
