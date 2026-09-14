# ⛔⛔ AGENT HANDOFF — the IVR Studio, walked end to end for the first time (2026-08-07) — READ FIRST before claiming ANY IVR fix, before touching prompt generation, publish, or the menu dialplan

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_IVR_STUDIO_LIVE_2026-08-07.md`**
(`05952a02` → `34123157` on `feat/ivr-migration-takeover`; api + portal DEPLOYED
and container-verified, plus two live PBX dialplan edits.)

- ⛔ **THE RULE THIS SESSION EARNED: a config file containing your fix is not a
  fix. Measure the thing the customer feels.** The keypress-lag fix was written,
  deployed, verified by reading `dialplan show` — the line was right there — and
  it did **nothing**, because it sat seven steps too late to execute. It was
  reported as fixed; Izzy called and found it in a minute. CLAUDE.md already
  said "the database is not what callers hear, verify with a real call"; that
  rule was quoted to him earlier the same night and then broken. **Proof looks
  like `21:16:19 DTMF '1'` → `21:16:24 menu moves` (before) and `21:21:11` →
  `21:21:11` (after)**, read out of `/var/log/asterisk/full`. Recipe in §6.
- ⛔ **The Studio sends the tenant in the QUERY STRING, never the body.** Both
  generate routes read only the body, so a super-admin's recordings for a
  CUSTOMER were filed under the admin — invisible to that customer, 200 on every
  request, and it reads as "I made 12 recordings, reloaded, they're deleted".
  Fixed by `resolveGeneratedPromptTenantId()`. **`git grep "body.data.tenantId"`
  in `apps/api/src/voice`** — any Studio-facing route reading only the body has
  it. A tenant admin never sees it (pinned to their own tenant, so the broken
  fallback is accidentally right). See [[studio-sends-tenant-in-query-not-body]].
- ⛔ **A brand-new customer could never publish their first menu.** Studio menus
  are all typed `business_hours`, a new tenant has no hours so the mode is always
  `afterhours`, nothing is scheduled yet → both lookups miss → publish refuses,
  and **nothing you can do to the MENU clears it**. `ivrFindActiveProfile` now
  falls back to the tenant's main menu, only after both lookups come back empty
  (asserted directly, not left to call ordering). Override deliberately does NOT
  fall back. Shared resolver, so both publish paths get it.
- ⛔ **One menu for both open and closed hours was rejected.** The schedule route
  compared list LENGTH against row count, so the same id twice = 2 vs 1 =
  `profile_not_found`. That closed a loop with no exit (schedule won't save → no
  menu selected → publish refuses). Deduped; a genuinely missing menu still
  refuses.
- ⛔ **`apiClient` defaults to a 10s timeout; a number switch takes 16–40s.** The
  "Publish and switch" button was **structurally impossible**, not flaky — and
  aborting doesn't stop the server, so the work often landed while the screen
  said it failed (two publishes 16s apart). Publish + switch now get 120s, and a
  client timeout says the change may already have gone through.
- ⛔ **`TIMEOUT(digit)` must be set BEFORE `Background()`**, not at `waitdigit`.
  Background collects digits *while the greeting plays*, so a caller pressing
  during the greeting never reaches a later `Set`. It is now set the moment the
  direct-dial flag is read, and set FROM it: **off → 0.2s** (nothing to wait for)
  / **on → 1s**. Plus `Wait(0.5)` after a recording before the menu replays.
  ⛔ `extensions__60_custom.conf` **silently keeps the old dialplan** on a parse
  error. Backups `.bak.timing.*`, `.bak.digittimeout.*`.
- ⛔ **VitalPBX cannot renumber an extension** — panel posts it hidden, REST is
  read-only. **copy → re-point the DID → delete**, in that order (the DID's
  destination row holds the extension_id and cascades away with it). Finish with
  `module reload res_pjsip.so` — Apply Changes leaves dead endpoints live in
  memory, and a client with cached credentials can register to one and never
  ring. inii mini is on **101**; ⛔ **baila must sign out and back in once**, and
  do NOT delete her login — she is the only admin on that tenant.
- ⛔ **A required field must never silently disable the submit button.** Gating
  Save on a recording's name shipped a dead button with no reason on screen, at
  the end of an hour of getting one take right. Refuse loudly, at the control
  that was pressed, and scroll to what's missing.
- ⛔ **Before ANY deploy: `ps aux | grep -E "[e]nqueue|[c]ommitHash"`.** A waiter
  left by a dead session sat armed with a commit **48 behind the tip**, ready to
  fire the moment a deploy finished. `nohup`/`setsid` outlive their agent.
- ⏳ **NOT PROVEN:** no human has heard the menu since the timing changes, and
  nobody has pressed "Publish and switch" since the timeout fix. The
  edit-a-recording feature is **half-built** — `34123157` adds the columns
  (`sourceText` + voice fields, nullable, unread); the routes and the Edit button
  are not written.
