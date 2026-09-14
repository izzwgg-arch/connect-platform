# ⛔⛔ AGENT HANDOFF — a voice note cut off after seconds, and our own denoiser made the sender sound "like I'm in a dungeon" (2026-08-16) — READ FIRST before touching chat attachments, ANY portal media player, the voice-note audio chain, or before trusting a timestamp on this server

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_CHAT_VOICE_NOTES_2026-08-16.md`**
(`e2b4699b` playback + `f0911881` audio, merge `eae7a0e8` on
`feat/ivr-migration-takeover`. **portal + api DEPLOYED and container-verified.**)

- ⛔⛔ **THE SERVER CLOCK WAS ~3 DAYS BEHIND AND WAS CORRECTED MID-SESSION.**
  Izzy's "I just sent it" voice note is stamped **`2026-08-13T14:17:50Z`**, as are
  the nginx lines for its playback, deploy-queue rows created in-session, and
  `docker inspect .State.StartedAt` for containers started then. Proven: a Prisma
  error echoed the container's own `new Date()` as Aug 12 for a 24h window, and a
  job created in-session carries epoch `1786632839` (Aug 13 13:33 UTC) while the
  host later read `1786903514` (Aug 16 18:05 UTC) — same box, 3.13 days apart.
  ✅ `chronyc tracking` is healthy **now** (68 µs off NTP, `NTPSynchronized=yes`).
  ⛔ **It was NOT chrony that fixed it, and it can recur.** Ruled out afterwards:
  **no reboot** (up 16 weeks since 2026-04-26), the journal is **persistent back to
  2026-02-26 and records no time change**, chrony logged nothing and
  `/var/log/chrony/` is empty — and `makestep 1 3` means chrony may step only in
  its **first 3 updates after starting**, so it structurally *could not* have
  closed a 3-day gap. A step with no reboot, no chrony action and no journal entry
  means a **hypervisor-side correction** (VPS migration/resume, kvm-clock),
  invisible from inside the VM. **If timestamps look wrong again, check `date`
  against a known-good source — the journal will be silent, so don't dig there.**
  ⛔ **NOT INVESTIGATED, Izzy's call:** how long it lasted and what carries wrong
  timestamps — invoice dating, `DidSwitchSchedule`, port-watchdog spacing, rate
  limit / login-throttle windows, signed-URL `exp`, CDR times, audit rows.
  **Do not "correct" any stored timestamp without his word.**
  ⛔ **The lesson: `date` on the box is not a fact you can assume.** When a stored
  timestamp disagrees with what a human just told you they did, check the clock
  before doubting the human and hunting an imaginary bug.
- ⛔ **THE PORTAL RE-SIGNS EVERY ATTACHMENT URL ON EVERY POLL, AND CHAT POLLS
  EVERY 7s.** `/chat/threads/:id/messages` mints a fresh `exp`/`sig` per
  attachment per fetch; both surfaces fed that changing string into `<audio src>`,
  and a changed src makes the browser treat it as a different file — it aborts and
  reloads. **That is the whole "it stopped after a few seconds".** The stored file
  was always fine (decodes clean, full 63.9 s); nginx logged it downloaded **13
  times in 90 seconds** from one browser. Fixed by pinning the first URL per
  attachment id until within 120 s of expiry
  (`stabilizeMessageAttachmentUrls`, `chatPresentation.ts`).
  ⛔ **The mobile app already had this fix** — phones were fine, only web/desktop
  was broken. Keep the two in step. ⛔ **Apply the pin at EVERY message-fetch
  site**; the defect was a CALLER, so the test reads both surfaces' SOURCE.
  ⛔ **Verify this deploy by grepping the bundle for the regex literal
  `(?:exp|e)=`** — minification renames consts, so grepping the function name
  returns 0 and reads exactly like a failed deploy.
- ⛔⛔ **WE RUINED THE AUDIO OURSELVES, WITH ONE NUMBER.** `chatVoiceNoteDenoise.ts`
  processes every voice note at upload and **replaces the stored original**. It
  passed **`afftdn=nr=10:nf=-25`**. `nf` is the noise floor — "everything below
  this is noise" — range **-80..-20, default -50**, so **-25 is nearly the most
  destructive value the filter accepts**, and speech averages about -20 dB. It was
  told to treat the voice as noise and stripped the body and tails off every word:
  the hollow, watery, "far away on the water / in a dungeon" sound. Measured on
  the real note: **-18.4 LUFS** (it undershot its own -16 target), **LRA 11.0 LU**
  with quiet passages at -27 LUFS, and **96 kHz** on a mono voice note because
  `-ar` was never pinned. Chain is now `nf=-50` + a 300 Hz mud cut + a **2.6 kHz
  presence lift** + **compression** (this is what stops speech sounding distant) +
  `LRA=7` + `-ar 48000`, exported as `VOICE_NOTE_FILTER_CHAIN` so it is assertable.
  ⛔ **A filter typo makes `denoiseVoiceNote` return `null` and silently disables
  ALL processing** — validate any chain edit against a real ffmpeg run, not by
  reading it. ⛔ **It cannot repair existing notes** — the raw audio of anything
  already sent is gone. ⛔ Mobile capture is untouched (needs an app build).
- ⛔ **A bare `getUserMedia({ audio: true })` is not "default good".** The portal
  recorded with no constraints, leaving automatic gain / noise suppression / echo
  cancellation to whatever Chrome or the Electron shell felt like — which is how a
  laptop-mic note arrives quiet and roomy before the server ever sees it. Now
  requested explicitly; **`autoGainControl` is the one that makes a voice sound
  close.**
- ⛔ **`apps/portal/package.json`'s `test` script NAMES EACH FILE, and
  `components/chat/messagePresentation.test.ts` was missing from it — so it had
  never run once** and had drifted red against a badge string deliberately changed
  in `f4fae3f4`. Registered + corrected. **A new portal test does nothing until you
  add it to that list.**
- ⏳ **NOT PROVEN: nobody has recorded or listened to a voice note on the new
  build.** Acceptance: restart the desktop app (an open window keeps the old
  bundle), record a fresh note, then confirm the stored file reads **48000 Hz** and
  about **-16 LUFS / LRA ≈ 7** (the bad one read -18.4 / 11.0).
