# ⛔ AGENT HANDOFF — "the MCP ain't picking up tickets" (2026-09-09): pickup IS automatic, drill-proven end to end; the three real tickets it "missed" were RUNS dying on 529 / the session limit; the 62 texts a week are the platform's own alarms — READ FIRST before restarting the watcher, before believing a "cap reached" log line means a customer was dropped, or before reading an alarm as a ticket

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(**Read-only investigation + ONE live drill through the real route.** No code, no deploy, no PBX write. The drill left a real escalation `cmtuh8f018stbnn14myxthsuj` / ref **YXTHUJ** on Landau Home, one SMS+email to Izzy, and a `ready` SupportUpdate on his Landau Home widget — deliberately NOT deleted, it is the proof. Memory: [[watcher-pickup-is-automatic-runs-die-on-quota]].)
Izzy: *"the MCP ain't picking up shit … Every time a real ticket came in, it never kicked him automatically … I want proof that it kicks in automatically."*

- ✅✅ **PROVEN WITH A TIMED DRILL, no hand on it:** `POST /support/report` as his Landau
  Home USER login (the customer's own Report-a-problem route) **19:13:45Z** → watcher
  `NEW [customer] YXTHUJ` **19:14:29Z (44 s)** → escalation `SENT`, SMS + email
  **19:15:10Z** → `SupportAgentRun YXTHUJ-1788981269863` streaming steps on
  `/admin/support` Agent runs → report done **19:22:25Z** → `handed back to LoopCom ->
  ready` **19:22:26Z**. Filing to customer-visible answer: **8 m 41 s**, zero humans.
- ⛔⛔ **HE WAS RIGHT ABOUT THE LAST THREE REAL TICKETS, AND THE REASON IS NOT PICKUP.**
  Y7FK8P (Gesheft 09-02), UVW3Y7 + 47CUTJ (Trust 09-03) were each claimed within 10 s
  of creation and each run then **FAILED exit 1** in 1–4 min: Y7FK8P = *"You've hit your
  session limit"* (⛔ the watcher runs `claude -p` on **Izzy's own Claude account** — his
  interactive use and the watcher share one quota), the other two = *"API Error: 529
  Overloaded"*. The 10-min bounded retry did not exist yet (it cites these very tickets);
  the answers came from a hand restart on 09-04 (`attempts: 2`). **A `FAILED` line two
  lines under `NEW` is a dead RUN, not a missed pickup — read the 65/149-byte report.**
- ⛔⛔ **"A LOT OF TICKETS COMING IN" = ZERO CUSTOMERS SINCE 09-03.** 62 escalations in 7
  days, all guardrails: **20 × voipms trunk guardrail on the SAME orphan 877-220-5058 /
  `344022_fox`, every 6 h since 09-04** (the 09-04 handoff's "will text once" was WRONG —
  the 6 h de-dupe re-arms forever, and the watcher burned its whole 3/day platform lane
  every midnight writing 14 identical reports on it); **38 × support loop guardrail**
  ("tickets sitting unworked" = those deferred trunk alarms, circular; "a customer replied
  and nobody has read it — 1 waiting" = **Trust Bookkeepings cspilman, 09-03 14:55Z,
  *"i tried both of them it still doesnt work..."*, unread 6 days — a PERSON's job, both
  reports say the fix is the unbuilt speaker/headset auto-pair); **3 × email guardrail**
  (blind mailboxes Gesheft 104, 112; Trimpro 107). Hence `⛔ platform cap 3/day reached —
  <ref> left for a human` × 7 refs, once a minute, 10,419 lines — **the customer lane
  (10/day) was never touched.**
- ⛔ **The watcher is a LOGON task.** The PC rebooted 01:37 local on 09-09 and the watcher
  was dead until Izzy signed in at 06:51 (TDP6RN "watcher down 41 min"); the watchdog task
  cannot start it before a logon either. Nothing customer-side arrived in the gap.
- ⛔ **Triage recipe:** `node status.mjs`; then `grep -nE "NEW \[customer\]" -A2
  logs/watcher.log`; then `list_support_tickets` — if every row reads `Loopcom platform`,
  the flood is alarms. Watcher log timestamps are **UTC**; the MCP ticket list is UTC too.
- ⏳ **Izzy's decisions, none taken:** release or route 877-220-5058 (or an ignore list on
  the trunk guardrail); answer cspilman (Trust) — she must fully close + reopen the desktop
  app so the next call writes a Devices card; addresses for the three blind mailboxes;
  whether the watcher should be a boot task; a watcher rule to skip an alarm whose text it
  already reported. ⏳ **Asked, not built:** the agent asking the customer clarifying
  questions before diagnosing (Report-a-problem is a free-text box that files immediately;
  the watcher investigates blind) — two shapes proposed, mockup first per his rule.
