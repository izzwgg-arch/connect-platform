# AGENT HANDOFF — a customer saved a forward at midnight and their phone system went dead (2026-08-16)

**Read this before:** touching `POST /voice/forwards` / `forwardBuilder.ts`, adding
ANY new call site that fires panel **Apply Changes**, changing the DID route
reconciler's repair policy, or investigating a "our phone system is down" report
that the platform looks healthy for by morning.

**Status:** `3f323182` on `feat/ivr-migration-takeover`. **api DEPLOYED and
container-verified** (job `c4576bef`, deployed commit `f95f7969` which contains
this fix; `applyRegenRebake.ts` present in `app-api-1`, both guard strings
grep = 1). **One live PBX data fix** (outbound caller ID, backed up). One stray
Connect DB row deleted. No migration, no flag flipped, no PBX config regenerated.

---

## 0. ⛔⛔ THE DATES IN THE EVIDENCE ARE THREE DAYS EARLY — READ THIS FIRST

Every log line, CDR row and nginx entry quoted below is stamped **2026-08-13**.
**The incident happened on the night of 2026-08-15 → 16** — "last night" as Izzy
described it. The Connect server and the PBX were both running **~3 days behind**
and were corrected **during this session**:

- Early in this session `date` on loopcom returned `Thu Aug 13 13:20:16 CEST 2026`.
- At the end of the same session, workstation / loopcom / PBX all agreed:
  `2026-08-16 18:27 UTC`, `System clock synchronized: yes`.

This is the same clock fault recorded in CLAUDE.md's chat-voice-notes section and
[[connect-server-clock-skew-2026-08-16]]. ⛔ **Do not "correct" any stored
timestamp** — Izzy's call, not ours.

**Why the analysis still holds:** every timestamp in the causal chain (publish →
regen → dialplan reload → dead calls → repair) comes from **the same skewed
clock**, so the *ordering and the intervals* are exact even though the absolute
date is wrong. The skew appears to be **whole days** (~72 h), not 3.13 days:
the server stamped the reconciler's repair at **00:16**, and Izzy independently
says the customer's text arrived at **12:16 AM** on a phone with a correct clock.
That alignment is the corroboration — and it is also what makes the story make
sense: **they texted him at the exact minute the platform healed itself**, having
given up after five minutes of dead calls.

⛔ Consequence for future sessions: `docs/ai-context/AGENT_HANDOFF_*_2026-08-13*`
and any memory written during the skew window may be misdated by three days.

---

## 1. What the customer experienced

**inii mini** (Connect tenant `cmsgkl4y95grttd13yqhyf1gd`, PBX tenant **105**,
number **646-984-6023** — the number that only landed from its port a few days
earlier).

| Server-stamped time | What happened |
|---|---|
| 00:00:56 | Their own admin (`sales@iniimini.com`, TENANT_ADMIN) is working in the IVR Studio. Creates a `DidRouteMapping` row for their **retired temp number** 845-260-5692 (it is still offered in the number picker — see §5). |
| 00:06 / 00:10 / 00:13 | Two menu-key edits (`PATCH …/options/…`) and **three publishes**, each returning `ivr: publish success`. |
| 00:07, 00:08 | Two real inbound calls — **answered fine, 32 s and 26 s**. The system is healthy at this point. |
| 00:09:55 | A **dialplan reload** puts a regenerated tenant config live. |
| **00:11:12 → 00:14:56** | **SEVEN consecutive inbound calls, every one `failed`, 0 seconds, instant dead air.** From 845-587-7122 and 845-662-4763 — almost certainly the customer testing their own line in a panic. |
| 00:16:06 | Reconciler: `[RECONCILER] doorway unhealthy` → `/doorway-repair` → fixed. |
| **00:16** | **The customer texts Izzy "the phone system is down."** |
| 00:28:50 | A call rings through normally again (goes to voicemail — it is 12:30 AM). |

The alert the reconciler queued was **suppressed** (`suppressed: "daily_cap",
sentLast24h: 40`) and ADMIN_ALERT mail is muted platform-wide anyway, so **nobody
at Connect was told**. The customer's text was the only signal.

## 2. The mechanism

The dead calls were **not** caused by publishing. Publishing writes AstDB keys and
never regenerates the PBX config. The cause is the **"ring an outside number"
forward** feature the admin was using while building their menu:

`POST /voice/forwards` → `createForward()` (`apps/api/src/pbx/forwardBuilder.ts`)
creates a Custom Destination + a Custom Application and then — uniquely in this
codebase, by Izzy's explicit 2026-08-06 instruction — **fires panel Apply
Changes**, because without it the rows exist in no dialplan and callers get a busy
signal.

Apply Changes regenerates the tenant's dialplan **from the ombu DB**, and
⛔ **VitalPBX's own generator cannot render the Connect doorway.** It writes its
generic form instead:

```
 same => n,Goto(T105_custom-contexts,cc-4,1)      ← what the regen wrote
 same => n,Goto(connect-doorway,s,1)              ← what the helper bakes, and what works
```

`cc-4` genuinely IS the doorway's `ombu_custom_contexts` row — but that render is
a **dead pointer**: no `cc-4` extension exists in the tenant's custom-contexts
context. Asterisk logged it precisely, once per dead call:

```
WARNING pbx.c: Channel 'PJSIP/344022_Comfortcont-00016065' sent to invalid
extension but no invalid handler: context,exten,priority=T105_custom-contexts,cc-4,1
```

So: **every Connect-routed number of that tenant was dead** from the reload until
something re-baked the route.

### Why it lasted six minutes instead of seconds

Two independent gaps, both now closed:

1. **Nothing re-baked after the apply.** The forward path fired Apply Changes and
   answered the customer. Repair was left entirely to the reconciler's 10-minute
   sweep.
2. ⛔ **The reconciler's render-drift re-bake was rate-limited to one per 6 hours
   per mapping.** The customer saved **two** forwards. The first regen's drift was
   repaired and **spent the allowance**; the second regen's drift hit
   `re-bake rate-limited (already attempted recently)` and the number stayed dead
   until the *separate*, slower `doorway unhealthy` → `/doorway-repair` path
   happened to fire at 00:16. **The rate limit designed to avoid fighting a human
   was, in practice, the thing that kept callers broken.**

## 3. The fix (`3f323182`)

**New module `apps/api/src/pbx/applyRegenRebake.ts`** —
`rebakeConnectRoutesAfterRegen(tenantId, deps)` re-asserts the doorway bake on
**every enabled, `routingMode: "connect"` mapping of the tenant**, via the
helper's existing `/route-rebake`. Idempotent (`changed: 0` when already correct),
and it **never throws** — a failure is logged and returned in `failed[]`, with the
reconciler still behind it. A failed re-bake must never fail the forward the
customer just successfully created.

**`POST /voice/forwards` now `await`s it immediately after `createForward`**,
before answering. The window shrinks from "up to a reconciler sweep" to "the
duration of the apply itself".

**The reconciler's render-drift re-bake is no longer rate-limited**
(`apps/api/src/didRouteReconciler.ts`). Reasoning, written into the code so it is
not "simplified" back:

> A drifted **render** means callers are hitting dead air *right now*, and the
> re-bake only rewrites the generated dialplan from **recorded intent** — it
> cannot overrule a human's decision, because a human moving a number changes the
> **row**, and the row-drift branch (`reassertRoute`) **keeps its 6 h limit**.

### Tests

`apps/api/src/pbx/applyRegenRebake.test.ts` — 6 unit cases (fan-out across
mappings; the `where` clause; one number failing never stops the rest; no helper
config; DB failure; nothing throws) **plus a source guard** that reads
`forwardRoutes.ts` and fails if the `await rebakeConnectRoutesAfterRegen(` call is
ever removed or moved before `createForward`.
⛔ **The source guard is the important one: the defect was a CALLER-side
omission, and a unit test of the re-bake function sails straight past it** — same
lesson as `internalDoorBypass.test.ts` and the invite-email APK link.

`didRouteReconciler.test.ts` updated: repeat drift on a second cycle must now be
re-baked **again** (was: asserted rate-limited).

**28 pass / 0 fail** across both files. Typecheck: no new errors (74 pre-existing
in apps/api, none in the touched files).

## 4. Verified live

```
docker exec app-api-1 ls   /app/apps/api/src/pbx/applyRegenRebake.ts        → present
docker exec app-api-1 grep -c "await rebakeConnectRoutesAfterRegen" …/forwardRoutes.ts        → 1
docker exec app-api-1 grep -c "NOT rate-limited, deliberately"    …/didRouteReconciler.ts     → 1
asterisk -rx 'dialplan show 6469846023@T105_incoming-calls'  → 6. Goto(connect-doorway,s,1)
```

⏳ **NOT PROVEN: no customer has saved a forward since the deploy.** The
acceptance test is the next real one — watch for
`[APPLY_REBAKE] post-apply route re-bake complete` in the api log, with
`linesChanged` > 0 being the proof it caught a real wipe.

## 5. The other two things this incident exposed

### 5a. Outbound caller ID was the RETIRED number — FIXED live

Three of the tenant's outbound calls that night presented
`OUTBOUND_CID="inii mini" <8452605692>` — the temp number that the port watchdog
**retired days earlier**. Anyone calling them back reached a dead number.

Swept every CID-bearing column in `ombutel` (`ombu_outbound_routes`,
`ombu_custom_destinations`, `ombu_trunks`, `ombu_devices.emergency_cid_*`,
`ombu_emergency_locations`) — exactly **one** hit: outbound route **126**.

Fixed both halves, because the DB row alone does not change what callers see:
```sql
UPDATE ombu_outbound_routes SET cid_number='6469846023' WHERE outbound_route_id=126;
```
plus the rendered line in `/etc/asterisk/vitalpbx/extensions__50-1-dialplan.conf`
(`s-126`), then `dialplan reload`. Verified live:
`4. Set(OUTBOUND_CID="inii mini" <6469846023>)`.
Backup: **`/root/outbound-cid-126-backup-<ts>.conf`** on the PBX.

⛔ The route row lives under `tenant_id: 1`, not 105 — outbound routes are global
with a per-tenant ARS. Don't filter by tenant when hunting one.

### 5b. ⛔⛔ The leftover temp-number route CANNOT be panel-deleted as-is

Tenant 105's inbound routes:

| route | did | description | destination_id |
|---|---|---|---|
| 238 | NULL | Default | 901 |
| **239** | **8452605692** (retired temp) | Main | **907** |
| **240** | **6469846023** (live) | Main ported | **907** |

⛔ **239 and 240 SHARE destination row 907.** A panel delete of the leftover route
239 cascades `ombu_destinations` row 907 away and **kills the live number** — the
exact shared-destination-row cascade recorded in [[connect-doorway-live]] and the
port-automation handoff. Give 240 its own destination row first, or leave 239
alone. It is inert apart from **+$3/mo E911**. **Not done — needs Izzy's word.**

### 5c. Stray mapping row — deleted

The admin's 00:00:56 `DidRouteMapping` for `+8452605692` (`routingMode: "pbx"`,
never switched, no `pbxInboundRouteId`, no schedules) was **deleted**. `e164` is
unique, so the row would have blocked that number from ever being reassigned to
another customer. Deleted under a guard that re-read every one of those fields and
refused on any mismatch.

## 6. Traps paid for during this session

- ⛔ **The helper journal does not see Apply Changes.** `journalctl -u
  connect-pbx-helper` showed only `/upload-prompt` and `/flow-map` — the applies
  arrive over the **panel** (`POST /index.php` from loopcom in the PBX's own
  `/var/log/nginx/access.log`). Looking only at the helper makes the regens
  invisible and the outage inexplicable.
- ⛔ **Two api deploys were mid-cutover during this work** and every
  `docker exec … node -` DB probe died with
  `FATAL: sorry, too many clients already` — the documented blue/green
  two-Prisma-pool exhaustion. **Wait it out; do not "fix" it.** Three attempts;
  the third succeeded once the deploys finished.
- ⛔ **Prisma field-name drift cost three round trips**: `ConnectCdr` has
  `durationSec`/`talkSec` (not `durationSeconds`), `PbxEndpointRegistrationEvent`
  has `status` (not `eventType`), `User` has `displayName`/`firstName` (not
  `name`), and there is **no `auditEvent` model**. Ask the schema, don't guess.
- ⛔ **`git log --oneline` did not show `3f323182`** near HEAD while the clock was
  skewed — the date-skew sinking trap. `git merge-base --is-ancestor` is the
  answer, never eyeballing the log.
- The queue enqueue field is **`service`**, and the terminal status string is
  **`success`**.

## 7. Still open

1. **Onboarding fires `applyChanges` in ~7 places** (`pbxTenantBuild.ts` —
   trunk, outbound-route, route-selection, tenant, inbound-route, extensions) and
   does **not** call the new re-bake. Apply Changes flushes **pending changes for
   other tenants too**, so a build for customer A can in principle wipe customer
   B's render. The un-rate-limited reconciler now bounds that to ≤10 minutes, but
   adding the re-bake call there closes it properly. **Not done — deliberately out
   of scope for a live-outage fix.**
2. **Route 239's shared destination row** (§5b) — needs Izzy.
3. **The alert never reached a human.** Both suppression layers fired (40/24 h cap
   *and* the platform-wide ADMIN_ALERT mute). A tenant's numbers all being dead is
   arguably escalation-grade, not alert-grade — see the escalation channel, which
   is the only one that reaches Izzy.
4. **Nobody has re-tested the Studio forward flow end to end** since the deploy.
