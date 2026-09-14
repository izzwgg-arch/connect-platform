# ⛔⛔ AGENT HANDOFF — a customer saved a forward and their whole phone system went dead (2026-08-16) — READ FIRST before adding ANY new panel **Apply Changes** call site, before touching `POST /voice/forwards`, before relaxing the DID route reconciler, or for a "we're down" report the platform looks healthy for by morning

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_FORWARD_APPLY_CHANGES_DEAD_AIR_2026-08-16.md`**
(`3f323182` on `feat/ivr-migration-takeover`. **api DEPLOYED and container-verified**
— job `c4576bef`, deployed commit `f95f7969`. One live PBX data fix (outbound
caller ID, backed up), one stray Connect row deleted. No migration, no flag.)

- ⛔⛔ **ANY PANEL `Apply Changes` WIPES THE CONNECT DOORWAY OFF EVERY ROUTE OF
  THAT TENANT.** VitalPBX's own generator cannot render the doorway — it writes
  `Goto(T<t>_custom-contexts,cc-<id>,1)`, and **that exten exists nowhere**, so
  callers get INSTANT DEAD AIR. `cc-<id>` really is the doorway's custom-context
  row, which is exactly why it reads as correct. Only the helper's bake
  (`Goto(connect-doorway,s,1)`) works. **The proof line, once per dead call:**
  `WARNING pbx.c: … sent to invalid extension … T105_custom-contexts,cc-4,1`.
- **What happened:** inii mini's own admin built menu keys at midnight and created
  two "ring an outside number" forwards. `createForward` fires Apply Changes (the
  ONE sanctioned auto-apply, Izzy 2026-08-06 — without it callers get a busy
  signal). **Seven consecutive inbound calls died, 0 seconds each, 00:11→00:15.**
  The customer texted Izzy **at 12:16 — the exact minute the reconciler healed
  it**, having given up. ⛔ **Connect was told NOTHING:** the alert hit the
  40/24h cap *and* the platform-wide ADMIN_ALERT mute. The customer's text was the
  only signal that a tenant's every number was dead.
- ✅ **FIXED, two halves.** (1) `POST /voice/forwards` now **awaits**
  `rebakeConnectRoutesAfterRegen` (`apps/api/src/pbx/applyRegenRebake.ts`) right
  after `createForward`, re-baking every enabled connect-mode number of that
  tenant before answering — idempotent, never throws, reconciler still behind it.
  (2) ⛔ **The reconciler's render-drift re-bake is NO LONGER RATE-LIMITED, and
  that was half the outage:** the customer saved TWO forwards, the first drift
  spent the 6h allowance, the second got `re-bake rate-limited` and stayed dead
  until the slower `doorway unhealthy` path fired. **The 6h limit belongs to the
  ROW re-assert** (where fighting a human matters); a drifted RENDER is callers
  broken *now*, and the re-bake only replays recorded intent.
- ⛔ **`git grep applyChanges` before you trust this is over.** Onboarding's
  `pbxTenantBuild.ts` fires it **~7 times** with no re-bake, and Apply Changes
  flushes **pending changes for OTHER tenants too** — so a build for customer A
  can wipe customer B's render. The un-rate-limited reconciler bounds that to ≤10
  min; adding the call closes it. **Deliberately not done** (out of scope for a
  live-outage fix).
- ⛔ **The helper journal CANNOT see Apply Changes** — `journalctl -u
  connect-pbx-helper` shows only `/upload-prompt` + `/flow-map`. Applies arrive
  over the **panel**: `POST /index.php` from loopcom in the **PBX's own**
  `/var/log/nginx/access.log`. Looking only at the helper makes the regens
  invisible and the outage inexplicable.
- ⛔⛔ **DO NOT panel-delete inii mini's leftover route 239** ("Main",
  845-260-5692, the retired temp number): **it shares `ombu_destinations` row 907
  with route 240 "Main ported", the LIVE number** — the delete cascades 907 and
  kills their real number. Give 240 its own row first, or leave it (it is inert
  bar +$3/mo E911). **Needs Izzy.**
- ✅ **Outbound caller ID was the RETIRED number and is fixed** — route 126 sent
  `<8452605692>` on live calls, so every callback reached a dead number. Both
  halves changed (the `ombu_outbound_routes` row **and** the rendered `s-126`
  line, then `dialplan reload`), verified live. Backup
  `/root/outbound-cid-126-backup-*`. ⛔ Outbound routes live under **`tenant_id:
  1`**, not the tenant's — don't filter by tenant when hunting one.
- ⛔⛔ **THE EVIDENCE IS STAMPED 2026-08-13 AND THAT IS THE CLOCK SKEW, NOT THE
  DATE.** Both servers ran **~3 days behind** and were corrected **during this
  session** (loopcom read `Aug 13 13:20 CEST` early on; all three machines agreed
  `2026-08-16 18:27 UTC` by the end). The incident was **last night**. Intervals
  and ordering are exact (one clock throughout); the absolute date is not. The
  12:16 text ↔ 00:16 repair alignment says the skew was whole days.
  ⛔ **Any handoff or memory written in that window may be misdated by three
  days**, and `git log --oneline` sinks a date-skewed commit below newer ones —
  verify with `merge-base --is-ancestor`, never by eyeballing the log.
- ⏳ **NOT PROVEN: nobody has saved a forward since the deploy.** Acceptance is
  the next real one — `[APPLY_REBAKE] post-apply route re-bake complete` in the
  api log, with `linesChanged > 0` proving it caught a live wipe. Tests: 28 pass
  / 0 fail. ⛔ The re-bake guard **reads `forwardRoutes.ts`'s SOURCE** — the
  defect was a CALLER-side omission, which a unit test of the function passes
  straight through.
