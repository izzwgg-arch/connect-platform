# ⛔ AGENT HANDOFF — the IVR coverage suite REWRITES live config (2026-08-06) — READ THIS WITH THE SECTION ABOVE, before running `ivr-full-coverage.sh` or believing any "I tested the IVR and it misbehaved" report

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_IVR_COVERAGE_SUITE_2026-08-06.md`**

- ⛔ **The suite the section above recommends is NOT a passive test — every round
  rewrites the live tenant's menu and publishes it**: overwrites keys 1–5,
  **deletes key 6**, swaps the greeting twice, and **repoints the DID to "Closed
  menu" and back**. Anyone hand-testing that number mid-run hears the wrong
  greeting / reaches the wrong menu / presses a just-deleted key. That is a FALSE
  failure and is indistinguishable from a real bug. **Never run it while a human
  is testing that number; never leave it looping unattended.**
- ⛔ **A killed run leaves the DB and the PBX out of sync** (config written,
  publish not reached, or the reverse). After any interruption: set the keys
  correctly, **Publish once**, then test.
- ⛔ **`disposition:"answered"` + `hangupCause:16` proves ONLY that the call
  connected.** A menu playing the wrong greeting or landing on the wrong
  destination writes an identical CDR row. Correctness comes from the suite's own
  PASS/FAIL (Asterisk-log grep) or a real listen — never from CDR disposition.
  This mistake was made and corrected in this session.
- Probe calls are spottable: `direction outgoing`, `fromNumber <unknown>`,
  `toNumber` = DID + keys pressed (`8457231213*1wwwwwwww9`), `channelsSeen` holds
  `…@connect-probe` / `…@connect-probe-press`. ⛔ **They land in the customer's
  real call history and inflate the Overview counters** — rule out a probe run
  before believing impossible dashboard numbers.
- 2026-08-06: a parallel session looped it ~30 min on Connect Communications
  (845) 723-1213 while Izzy hand-tested; killed at his word (PID 27372).
  **His original keys 1–6 were overwritten and never captured** — open item.
  The suite takes no snapshot and restores nothing on exit.
