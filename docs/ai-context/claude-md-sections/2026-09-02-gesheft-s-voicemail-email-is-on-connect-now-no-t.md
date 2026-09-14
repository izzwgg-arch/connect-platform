# ⛔⛔ AGENT HANDOFF — GESHEFT'S VOICEMAIL EMAIL IS ON CONNECT NOW; NO TENANT IS ON THE PBX'S OWN VOICEMAIL-TO-EMAIL ANY MORE (2026-09-02) — READ FIRST before touching `VOICEMAIL_EMAIL_EXCLUDED_TENANT_IDS`, before un-excluding ANY tenant, before blanking a PBX voicemail email, or for "Gesheft didn't get their voicemail email"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_GESHEFT_VOICEMAIL_EMAIL_CUTOVER_2026-09-02.md`**
(`8188ff36` on `feat/ivr-migration-takeover` — comment-only api change carrying the env flip;
✅ **api DEPLOYED and container-verified** (blue/green, 0 restarts,
`VOICEMAIL_EMAIL_EXCLUDED_TENANT_IDS=[]` read from the running container). **PBX writes under
Izzy's explicit instruction**: ext 102's address changed, then all 7 Gesheft voicemail
addresses blanked in `ombu_extensions` + the generated conf, `voicemail reload`; backups
`pbx:/root/gesheft-vm-email-cutover-20260902T153346Z/`. **Data writes**: 7
`VoicemailEmailRecipient` rows created, 699 Gesheft `Voicemail` rows stamped
`predates_feature`, one env line in `.env.platform` (backup
`.bak.20260902T153841Z.gesheft-vm-cutover`).) Memory:
[[gesheft-voicemail-email-is-on-connect-now]].
Izzy: *"change ext 102's voicemail email to orders@gesheftkosher.com — only if voicemail emails
from Loopcom have been working flawlessly … then you can flip the switch … leave both of them on
for like 15 minutes."*

- ✅ **THE GATE PASSED, MEASURED**: since the 2026-08-27 race fix, 55 voicemail emails, **all
  SENT, 0 failed, 0 lost, 0 races, delivery on all 7 days, 18 recipients**; 0 FAILED all time.
  ⛔ Stated, not hidden: ONE pre-fix casualty (B Visible 111, 2026-08-19, a 10 s voicemail stamped
  `no_recording` 14.5 s in, audio present, never emailed) — 8 days BEFORE the fix, outside its
  self-heal window. Evidence the fix was needed, not that it is failing now.
- ✅ **ext 102 → `Orders@gesheftkosher.com`**, then the whole tenant cut over. **Overlap 15:53Z →
  16:11Z: 3 voicemails arrived, Connect SENT all 3, the PBX sent all 3 — nothing lost.** The old
  domain `pileupny.com` is gone from the PBX (`grep -r` → 0) and from Connect's
  recipients/mirrors (→ 0). ⛔ The Connect LOGIN `orders@pileupny.com` still exists (never
  invited, never signed in, owns ext 102) — Izzy's call; never `resend-invite` it.
- ⛔⛔ **THE TRAP THAT WOULD HAVE FLOODED THE PLATFORM: an excluded tenant's voicemails are NEVER
  STAMPED, so un-excluding one makes its whole 7-day backlog eligible in ONE sweep.** Gesheft had
  **334** in-window rows (272 on ext 101) — a week of duplicates the customer already had, and
  ~2/3 of the shared 500/day Gmail allowance gone in seven minutes (the 2026-08-06 outage shape).
  **Stamped all 699 unstamped Gesheft rows `predates_feature` BEFORE flipping** (in the
  watchdog's `DELIBERATE_SKIPS`, so it can never alarm); ids in
  `loopcom:/root/gesheft-backlog-ids-20260902.txt`. ⛔ The code comment said the OPPOSITE ("so
  they stay eligible the day they are un-excluded") — corrected in `8188ff36`. **Anyone
  un-excluding a tenant must stamp its backlog first. Anyone un-stamping those rows must
  re-exclude the tenant first.**
- ⛔⛔ **THE VITALPBX REST LAYER CACHES EXTENSION RECORDS — the tenant-list staleness this file
  records, extended to extensions.** 18 minutes after the PBX database read `gesheftkosher` (and
  a whole-`ombutel` sweep found zero pileupny), the api's 5-minute `pbx_auto_sync` wrote
  `pbxUserEmail = orders@pileupny.com` back onto ext 102 at 15:53:17 — so the first Connect email
  went to BOTH addresses. Corrected by hand; three further sync cycles kept `gesheftkosher`, so
  the cache had refreshed. **After a direct MySQL edit, expect the sync to write the OLD value
  once or twice; check `Extension.updatedAt` against the 5-min interval before concluding a write
  "didn't take".**
- ⛔⛔ **`preserveBlankedPbxEmail` PROMOTES WHATEVER THE MIRROR HOLDS when the PBX goes blank** —
  had the mirror still read pileupny at blanking time, the old domain would have been written
  into `VoicemailEmailRecipient` PERMANENTLY. That is why the mirror was corrected and watched
  stable BEFORE the PBX was blanked. Make sure the mirror is the address you want made permanent
  before any blank.
- ⛔ **Recipients went in BEFORE the switch** (7 `VoicemailEmailRecipient` rows copied from the
  PBX, de-duplicated by address at send time so the mirror + row = one email). ⚠️ ext 107's
  recipient is `tod10950@gmail.com` — Izzy's alert address on a mailbox named "Customer Phone 2"
  — copied faithfully, flagged, not changed. Gesheft's 10 blind mailboxes stay blind, as on the PBX.
- ⛔ **A cutover backup must be regenerated after any intermediate change** — the first
  `RESTORE.sql` would have restored pileupny onto ext 102. Regenerated before blanking.
- ⛔ **Deploy trap re-hit**: GitHub 401'd the server's fetch → bundle → bare mirror →
  `set-url origin <mirror>` → deploy → **origin restored to GitHub and mirror removed** (verified).
  ⚠️ The deploy shipped the branch tip, which carried another session's `53fb9c52` (manual-pay
  invoice automation) — checked first: opt-in, exactly one tenant flagged (Yossis Wood Works, the
  tenant it was written for). Stated so nobody is surprised.
- ✅✅ **PROVEN END TO END: the first voicemail after the PBX went quiet (ext 101, 16:35:07Z, 144 s)
  was emailed by Connect alone** — `EmailJob` SENT 16:37:59 to `orders@gesheftkosher.com`, and
  the PBX's `mail.log` shows **0** Gesheft sends after 12:11 local. ⛔ A query 4 s before the job
  row existed showed the `Voicemail` EMAILED with no job — the two writes land in the same sweep
  pass seconds apart; re-read before filing that as a fault. ⚠️ The `Extension.pbxUserEmail`
  mirror for the 7 mailboxes may lag the blank for a while (REST cache); harmless (dedupe), and
  the eventual promotion is a no-op.
