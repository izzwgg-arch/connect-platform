# AGENT HANDOFF — the IVR coverage suite REWRITES live config (2026-08-06)

**Read this before running `scripts/pbx/ivr-full-coverage.sh`, before diagnosing
any "I tested the IVR and it did the wrong thing" report, and before reading
"answered" in `ConnectCdr` as proof that an IVR works.**

Short version: Izzy saw an unexplained live call on the dashboard, asked what it
was. It was our own IVR test suite — which had been running for over half an hour,
placing 2–11 calls a minute into his real number **and rewriting the live menu
config between every assertion**. His own manual test, minutes earlier, had "not
worked properly" because the script kept repointing the keys under him.

---

## 1. ⛔ The coverage suite is not a passive test — it mutates production config

`scripts/pbx/ivr-full-coverage.sh` is written to prove the Studio's real publish
path with real calls. To do that, **each round writes tenant config directly via
Prisma and publishes it to the live PBX**, then places probe calls and greps the
Asterisk log. Per round, against tenant **Connect Communications**, it:

- overwrites keys **1–5** on "main menu" with fixed test targets
  (1 → submenu, 2 → ext 1101, 3 → VM-1101, 4 → play a recording, 5 → hangup)
- **deletes key 6** (`del_option`) to test the unset-key re-prompt path
- swaps the greeting `G_MAIN` → `G_B` → back, publishing each time
- **reassigns which menu the DID rings** — points it at "Closed menu"
  (`assign_menu "$ALT"`), asserts, then points it back
- writes keys **1 and 9** into the "m" submenu
- fires three concurrent probe calls at the end

Then it loops. `ROUNDS` defaults to 5.

**Consequence: any human calling that number during a run gets whatever the
script set seconds ago** — the wrong greeting, "Closed menu" instead of the main
menu, or a key that has just been deleted. That is a false failure, and it is
indistinguishable from a real bug unless you know the suite is running.

### Rules
- ⛔ **Never run this suite against a number a human is about to test.** Announce
  it, or run it and then stop before hand-testing.
- ⛔ **Never leave it looping unattended.** It is a burst test, not a monitor.
- **A killed run leaves the DB and the PBX out of sync** (config written, publish
  not yet done, or vice versa). After any interruption: set the keys the way they
  should be, **Publish once from the Studio**, and only then test.
- The suite hard-codes one tenant's real ids (see §4). It is not
  environment-agnostic and there is no dry-run mode.

## 2. ⛔ "answered / hangupCause 16" proves NOTHING about IVR correctness

This session's first read of the CDR table said the probes "answer fine and tear
down cleanly" and called that working. **That was wrong and Izzy correctly pushed
back.** `disposition:"answered"` + `hangupCause:16` means only *the call connected
and hung up normally*. A call that plays the wrong greeting, plays generic filler,
or lands on the wrong destination produces an identical row.

The only evidence that an IVR behaved is the **suite's own PASS/FAIL output**,
which comes from grepping the Asterisk log for the expected context/playback
(`ivr-e2e.sh`'s regex arg) — or a real listen. Never substitute CDR disposition
for that. (Consistent with the existing memory note: verify IVR behavior with real
calls, never the DB.)

## 3. Spotting a probe run from the data

Probe calls are unmistakable once you know the shape:

- `direction: outgoing`, `fromNumber: <unknown>` (no real leg → no caller ID)
- `toNumber` is the DID **plus the keys pressed**: `8457231213*1`,
  `8457231213*1wwwwwwww9` (`w` = wait), `8457231213*#`
- `channelsSeen` holds `Local/…@connect-probe` and `…@connect-probe-press`
- `tenantResolutionSource: telephony_connect_tenant_id`

Timeline query that made it obvious (run on loopcom):

```sql
select date_trunc('minute',"startedAt") m, count(*),
       string_agg(distinct "toNumber", ',')
from "ConnectCdr"
where "startedAt" > now() - interval '6 hours'
  and "toNumber" like '8457231213%'
group by 1 order by 1 desc;
```

⛔ **These land in the customer's real call history and inflate the dashboard
counters** (Overview outgoing/incoming). They are not marked as test traffic.
If a tenant's numbers look impossible, check for a probe run before believing them.

## 4. What the suite hard-codes (Connect Communications)

| Thing | Id |
|---|---|
| Tenant | `cmqzfigij4bt0mw13u2ulpd0t` |
| DID | `8457231213` |
| DID→menu mapping | `cmsg79jlv048bll1490jrjyyd` |
| `MAIN` "main menu" | `cmseuklc80001o7133ke49etw` |
| `SUB` "m" (serves keys, no greeting) | `cmsgpcu3e01jqmg13ax642hk1` |
| `ALT` "Closed menu" | `cmsewyudm02bon013f8svvk56` |
| Greetings | `custom/with_a_menu_99d430`, `custom/main_greeting_75e2f4`, `custom/main_greeting_0c9882` |

Publish is driven through the production path:
`POST /internal/agent/ivr/action` with `x-agent-internal-secret` (secret read from
`/opt/connectcomms/env/.env.platform`), action `set_prompt` — a "no-op" prompt set
used purely to force a real publish. Assertions shell to the PBX and run
`/root/ivr-e2e.sh <did> <regex> <keys> <waitSecs>`.

## 5. This incident — timeline and final state

- **12:46:45 AM ET 2026-08-06** — another Claude session (`6597bc22…`) started
  `scratchpad/full.sh 5` (a copy of the coverage suite), PID **27372**, on Izzy's
  Windows machine. Hundreds of probe calls followed, 2–11 per minute.
- Izzy hand-tested the IVR in that window; it misbehaved. Root cause = the suite,
  not the product.
- **~1:18 AM ET** — killed on Izzy's instruction: `taskkill /PID 27372 /T /F`
  (killed 27372 + child 20100; the outstanding `ivr-e2e.sh` ssh died with it).
  Verified no probe processes remain.

**State left behind (DB, at kill time):**

- DID `8457231213` → rings **"main menu"**, greeting `custom/with_a_menu_99d430`
  — the script had restored this part.
- "main menu" keys **1–5 are the script's test values** (written 05:11 UTC),
  **key 6 deleted**.
- "m" submenu carries the script's keys **1** (ext 1101) and **9** (back to main),
  written 05:14 UTC.
- "Closed menu" key 1 untouched since 2026-08-04.

⛔ **Izzy's original key assignments on 1–6 are overwritten and were not captured
before the run.** Open item at handoff: either he re-enters them, or someone digs
for a pre-05:11 record of what they were. Then **one Publish** to resync DB↔PBX.

## 6. Suggested follow-up (not done)

- Put a loud banner comment at the top of `ivr-full-coverage.sh` saying it mutates
  live config and must not run while anyone is hand-testing. (Only MD files were
  updated this session; the script is unchanged.)
- Consider having the suite snapshot the tenant's `IvrOptionRoute` /
  `DidRouteMapping` rows on start and restore them on exit, including on Ctrl-C.
  Today an interrupted run silently leaves test config in production.
