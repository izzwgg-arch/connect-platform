# ⛔⛔ AGENT HANDOFF — the IVR actually works now (2026-08-06) — READ FIRST for ANYTHING touching the IVR Studio, publishing, recordings, menu keys, or "I changed it and nothing changed"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_IVR_RUNTIME_2026-08-06.md`**

- ⛔ **THE RULE: the database is not what callers hear. Verify with a real
  call.** Four times in one night the DB, the publish record, and the API
  response all said "success" while callers reached the wrong menu — for four
  DIFFERENT reasons. Use `scripts/pbx/ivr-full-coverage.sh` /
  `ivr-pointing-stress.sh` / `ivr-e2e.sh` (real calls + real DTMF, asserted
  from the Asterisk log). Never report "fixed" from stored state.
- **Six defects found and fixed**, each producing a symptom the owner had been
  reporting for weeks: (1) the runtime NEVER read a number's assigned menu —
  `grep -c profile_id` on the live dialplan was **0**, so every number played
  one tenant-global menu; (2) publishing never copied recordings to the PBX;
  (3) a publish answered `{ok:true}` before Asterisk applied a single key
  (fire-and-forget `sendAction("DBPut")`); (4) the drift reconciler overwrote
  the owner's work — reverting fresh publishes AND rewriting the number→menu
  pointer every ~10 min; (5) the panel had repurposed the shared doorway
  destination row; (6) a menu with no greeting hung up on callers.
- ⛔ **TWO publish paths exist** — `POST /voice/ivr/publish` (Studio button) and
  `publishIvrForTenant()` (agent door + mode sweep). Near-duplicates. A fix
  applied to one silently skips the other; that shipped broken audio for a
  whole test round. **Anything added to one belongs in both.**
- ⛔ **Any repair path that writes owner-chosen state must respect
  `PUBLISH_SETTLE_MS`** (5 min). A watchdog that "repairs" from state read
  seconds ago will silently undo a publish — that is exactly what "I published
  and it didn't take effect" was.
- **Submenus are live** ("press N → another menu"): per-menu AstDB families +
  the additive `[connect-menu]` engine. The `m<id>` exten prefix is
  **hyphen-free on purpose** — Asterisk strips `-` in patterns.
- Harness traps that produced false "product is broken" reports: isolate traces
  by linkedid, match case-insensitively (`BackGround`), allow ~4s between key
  presses, use `Dial(...,/n,D(wwww<digits>))` for DTMF, **verify every config
  write**, and never edit/scp a script while it is running.
