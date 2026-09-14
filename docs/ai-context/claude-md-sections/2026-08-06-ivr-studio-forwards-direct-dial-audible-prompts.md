# ⛔ AGENT HANDOFF — IVR Studio: forwards, direct dial, audible prompts (2026-08-06) — READ FIRST for the Studio, prompt refs, or any PBX dialplan patch

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


All DEPLOYED and container-verified on `feat/ivr-migration-takeover`
(tip `ae2ba8e3`). Full detail in the memory files named below.

- **A menu key can ring an outside phone number.** Built from Izzy's recorded
  panel session: a Custom Destination holds the number, a Custom Application on
  a reserved **2000–2099** number answers and hands the call to it; the key
  stores `destinationType:"custom"` → `T<t>_app-custom-application,<ext>,1`
  (a plain Goto — NOT `cos-all`, which is typed "extension" and drags the call
  through the wake dialer). ⛔ **`cid_name`/`cid_number` stay EMPTY forever** so
  the outbound route's caller ID is used — customers must never set their own.
  ⛔ **This is the ONE place Connect calls Apply Changes itself** (Izzy's
  instruction; it was in his recording). Without it the rows exist, the
  extension is in no dialplan, and callers get a BUSY SIGNAL — which is exactly
  what happened live. Every other panel write still leaves the click to Izzy.
- **Direct dial + spoken prompts fixed ON THE PBX** (`extensions__60_custom.conf`,
  backups `.bak.dd3.*` / `.bak.langdir.*`). `[connect-menu]` had NO `_XXX`
  patterns, so pressing 1 fired option 1 instantly and 101 was impossible; and
  every prompt was probed at `sounds/<ref>` when Asterisk's built-ins live at
  `sounds/**en**/<ref>` — so "that option is invalid" and the timeout message
  were silently skipped for years. Default invalid prompt is now
  `option-is-invalid`. ⛔ **Never invent syntax inside those guards** — an
  attempt using `CUT()` made Asterisk reject the file and SILENTLY keep the old
  dialplan (no error logged for that file). Mirror the existing proven line
  shape. The `same =>` indent there is **seven** spaces; assert every
  string replacement.
- ⛔ **The prompt REF is canonical, never the stored filename.** A "fix" that
  rewrote refs to match files (`custom/Home_main` → `custom/home_main`) made the
  catalog check fail and **blocked publishing entirely**. Publish now pushes the
  audio to the PBX under the name the ref asks for. See
  [[ivr-per-number-menu-runtime]].
- **Studio UX rules** (Izzy, sharply): a key choice is **never hidden for being
  empty** — picking one you don't have must CREATE it (team → MakeTeam,
  recording → upload/AI, number → add). Only "A person" stays greyed.
- **Half-migrated numbers are flagged**: `pbxHandBack`/`findPbxHandBacks` in
  `@connect/shared` mark keys that hand control back to a PBX IVR/time
  condition, on the map and before Publish. Rule = who DECIDES, not who answers.
- **Deploy traps that cost hours tonight:** ⛔ enqueue the **branch TIP**, not
  your own commit — several sessions push minutes apart and pinning your hash
  silently ROLLS BACK newer work; a running job can't be cancelled. ⛔ The
  queue does NOT protect against the heavy-build lock — jobs fail in the build
  stage with `HEAVY JOB ALREADY RUNNING` and look like broken code (happened 5×).
  ⛔ Never wait with `pgrep -f deploy-direct` in an ssh one-liner — it matches
  its own command line and hangs forever. Poll `/ops/deploy/jobs/<id>`.

**DONE 2026-08-06 (was open item 1):** inii mini is on **101**. ⛔ VitalPBX has
NO way to renumber an extension — the panel posts the number as a hidden field
and the REST API is read-only — so it was **copy → re-point the DID → delete**,
in that order, because the DID's destination row stores the extension_id and
**cascades away with the extension**. All verified live: dialplan reads
`Goto(T105_cos-all,101,1)`, 25 voicemails moved, dead endpoints cleared with
`module reload res_pjsip.so` (Apply Changes leaves them live in memory), Connect
shows the phone. ⛔ The endpoint name changed (`T105_1_1` → `T105_101_1`), so
**baila must sign out and back in**. The wizard is gated too (`0441fe2d`,
deployed): a lone digit promotes 1 → 101 **on blur, not on change**, and under
three digits is refused in the browser AND in the submit route. Recipe:
[[vitalpbx-cannot-renumber-extension]], [[relax-tires-billing-started-4digit-extension-gap]].

**OPEN, not started:**
1. **`invalid_prompt_ref` red banner** when making a recording on inii mini —
   UNDIAGNOSED. Its five prompt refs are all valid; the server sends a `detail`
   the portal drops (the `.body` not `.payload` bug again). Three emit sites:
   `server.ts` ~21008, ~21121, ~21379.
2. **A plus center key 2** still hands back to the PBX time condition. Both PBX
   menus behind it are ALREADY migrated into Connect (greeting ids 99/11 match)
   — only the key's pointer remains, and Izzy must choose: point at "A plus
   main" (loses the hours switch) or build an hours-aware key kind. See
   [[aplus-key2-handback-last-step]].
