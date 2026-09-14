# ⛔⛔ AGENT HANDOFF — "the delivery driver called and the phone never rang" on B Visible was MENU OPTION 3, which rings nobody (2026-09-01) — READ FIRST for ANY B Visible "the phone didn't ring", before reading a voicemail as a fault, or before counting `dst='VM-101'`

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_BVISIBLE_IVR_OPTION3_2026-09-01.md`**
(**Read-only investigation — no code, no deploy, no migration, no PBX write, no
data change.**) Memory: [[bvisible-option-3-is-a-dead-end]].
Izzy, 2026-09-01: *"This was a delivery person that called and got the voicemail.
What happened on this call? Why didn't the phone ring?"*

- ⛔⛔ **THE ANSWER: the caller pressed `3`, and option 3 is the "Company
  Directory" ANNOUNCEMENT — a 22-second recording that dials nothing.** Nothing
  was broken. Traced to the second in `/var/log/asterisk/full` (call
  `1788272846.53082`): 10:27:26 menu starts → **10:27:44 he presses 3** →
  announcement to 10:28:06 → **dumped back at the main greeting** → three
  10-second timeouts, each answered with *"that option is invalid"* → 10:29:46
  out of retries → `sub-extensions-vm,VM-101` → beep at 10:29:53 → hung up
  10:30:17. **147 seconds from answer to beep.**
- ⛔ **No `Dial()` ran on that call at all, proven twice** — none in the log, and
  both call records carry only the trunk channel `PJSIP/344022_Smooth2-00006a58`
  with no extension channel. Asterisk's CDR reads `src 7705573001 → dst VM-101`.
  ✅ **The phone was fine, checked not assumed**: `T9_101` was registered and
  `Avail` throughout, and **another caller reached ext 101 at 10:57 and talked
  3 m 31 s**.
- ⛔ **The menu, from `dialplan show IVR-25` (the authority — decoding
  `ombu_destinations` by module/index is the documented trap):** **0 → ext 101
  Front Desk, 1 → ext 101**, 2 → time condition TC-15, **3 → announcement-19
  "Company Directory" (RINGS NOBODY)**, 101/102/104 → ring groups 800/801/802,
  103/105/106 → those extensions, 0478 → DISA, and **no answer ×3 → ext 101
  voicemail**. `freedial: no`, so arbitrary extensions cannot be dialed.
  **Pressing 0 or 1 would have rung the Front Desk immediately.**
- ⛔⛔ **AND IT IS NOT A ONE-OFF — OPTION 3 LOSES CALLERS SILENTLY. 157 calls have
  pressed 3; 88 of them (56%) then pressed NOTHING at all.** Of those 88: **43
  hung up during the directory recording** (avg 38 s), 17 at the menu, and
  **exactly ONE left a voicemail — this delivery driver.** So ~60 callers have
  pressed 3 and vanished with **no voicemail, no missed call, nothing to follow
  up**. ⛔ **The voicemail is the exception, not the pattern** — which is why this
  has never been reported before.
- ⚠️ **30-day inbound on that line: 208 calls reached the Front Desk and 200 ended
  at the menu with nobody reached and no message.** ⛔ Do NOT read all 200 as lost
  customers — 68 lasted under 15 s (robocall shape) — but **63 lasted 35 s+**,
  i.e. they heard the 21.5-second greeting at least twice and gave up.
- ⛔ **`dst='VM-101'` IS NOT TENANT-SCOPED — every tenant has an ext 101.** An
  unscoped 30-day count returned **1,374** where B Visible's real figure is **40**.
  Always add `tenant='b_visible'` **AND** `uniqueid=linkedid` (one row per call).
- ⛔⛔ **The `ombu_ivr_stats`↔`asterisk.cdr` join is EXPENSIVE and the PBX runs
  live SQL on the CALL PATH** (`EXTENSION-SETTING` reads at call time). One such
  query ran **160 seconds** before it was stopped with `KILL QUERY`. Bound these
  by date, or pre-fetch the id list and use an `IN` list against
  `cdr_linkedid_index`. `ombu_ivr_stats` has **no timestamp column** — it can only
  be dated through that join.
- ⛔ **The time condition was CORRECT and is easy to misread**: `Goto (TG-6,s,7)`
  **is** the `[match]` label, so business hours matched and the open menu played.
  Do not file it as a bug.
- ⛔ **`disposition: "answered"` means the IVR answered, never a human** — every
  one of these lost calls reads ANSWERED. And `/var/log/asterisk/full` holds
  **TODAY ONLY**; this trace existed only because the call was the same day.
- ⏳ **THE ONE GAP, and it decides the fix: NOBODY HAS LISTENED TO THE RECORDINGS.**
  I cannot say whether the greeting steers a delivery driver to option 3, or
  whether the directory tells people to dial an extension afterwards. Both ~22 s:
  `/var/lib/vitalpbx/static/2b9df1ace9927067/recordings/6c8349cc7260ae62e3b1396831a8398f.wav`
  (greeting) and `.../44f683a84163b3523afe57c2e008bc8c.wav` (Company Directory).
- ⏳ **NOTHING WAS CHANGED — three fixes are Izzy's call** (and are B Visible's own
  IVR config): point the Company Directory at the Front Desk instead of back at
  the menu; stop playing *"that option is invalid"* at a caller who pressed
  nothing; and shorten the 21.5-second greeting / 2 m 22 s path to voicemail
  (the Gesheft long-greeting class).
