# ⛔ AGENT HANDOFF — the "<unknown> → h" Active Call that sits for hours after a reboot is Asterisk's `Message/ast_msg_queue` pseudo-channel, seeded as a call at AMI bootstrap and never removable (2026-09-08)

Branch `feat/ivr-migration-takeover`, telephony only. Izzy, 2026-09-08 ~21:20 CEST:
*"There is a stuck phone call and active calls say unknown for 1 hour and 45 minutes."*

## 1. What was on screen

A super-admin tab (Active Calls on the dashboard / `/pbx` / Team Directory) held ONE row:
caller **`<unknown>`**, destination **`h`**, state **up**, no tenant, duration counting from
**19:33:04 CEST** — the second the telephony service finished booting after the host reboot.
1h45m later Izzy reported it. A freshly loaded page showed **0 / clean** (checked live in his
Chrome: `/pbx`, `/dashboard`, `/admin/ops-center` all agreed with the PBX).

## 2. Evidence trail (what was true at 21:20–21:35 CEST)

| Layer | State | How it was read |
|---|---|---|
| Asterisk | 9 channels / 5 calls, all seconds old, plus `Message/ast_msg_queue` at **163:53** in context `messages`, exten `h`, app `Hangup`, no CallerID | `ssh pbx`, `asterisk -rx "core show channels verbose"` |
| telephony call store | `totalCallsInStore 4–8`, `activeCallCount 2–4`; **call `1788305013.58084`: state `up`, from `<unknown>`, to `h`, tenant `null`, startedAt `2026-09-08T17:33:04.723Z`, `isActive:false`, `activeFilterReasons ["local_only","no_valid_channel"]`** | `curl -H "x-cdr-secret: $CDR_INGEST_SECRET" http://127.0.0.1:3003/telephony/diag` (secret from `docker exec app-telephony-1 printenv CDR_INGEST_SECRET`) |
| Redis ARI snapshot `connect:telephony:ariBridged:v1:209.145.60.79` | 1 qualifying bridge, correct | `redis-cli GET` |
| telephony log (raw json-file) | `CoreShowChannel Message/ast_msg_queue … channel_received tenant_UNRESOLVED` → `MobilePushNotifier notify-entry state=up from=<unknown>` → **`TelephonyBroadcaster … broadcasting callUpsert state=up from=<unknown> to=h extensions=[]`** at **17:19:21Z, 17:20:56Z and 17:33:04Z** — one per AMI bootstrap of tonight's reboot chain | see §7 on why `docker logs` lied |
| portal client | `useTelephonySocket` applies every `telephony.call.upsert`; only a snapshot (`setCalls(new Map(snap.calls))`) or a `call.remove` clears a row | `apps/portal/hooks/useTelephonySocket.ts` |

Uniqueid `1788305013` = 2026-09-01 23:23Z — the channel is as old as the Asterisk process
(163 h), which matches the PBX footer exactly.

## 3. The cause — five facts that only bite together

1. Asterisk keeps ONE permanent pseudo-channel, `Message/ast_msg_queue` (the out-of-call
   MESSAGE queue). It is listed by `CoreShowChannels`, state Up, and it **never emits Hangup**.
2. `TelephonyService.handleAmiFrame` treats `CoreShowChannel` exactly like `Newchannel` to seed
   pre-existing calls at every AMI connect/reconnect. Its helper guard was
   `if (linkedIdEmpty && isHelper) break;` — a helper is skipped only when it carries NO
   linkedid. The pseudo-channel carries its own uniqueid as linkedid, so it fell through.
3. `CallStateStore.upsertFromNewchannel` created a call from it: `createEmpty` → `from`
   `<unknown>`, `to` `h`, `state` up (ChannelState 6), tenant null.
4. `TelephonyBroadcaster` broadcasts **every** non-hungup `callUpsert`, and a null-tenant record
   goes to **admin sockets only** (`buildTenantFilter(null)` ⇒ `client.tenantId === null`). That is
   why only Izzy (super-admin) saw it and tenant users did not.
5. The call fails `hasValidChannel` (helper-only), so it is in **no snapshot** (`getActive`), and
   `reconcileLiveChannels` / `removeStaleGhostCalls` only sweep calls whose channels are ABSENT
   from ARI — this channel is always present. Every `this.calls.delete` path in the store DOES emit
   `callRemove`; the ghost was never deleted because it was never eligible. So: one upsert, zero
   removes, forever — until the client reloads and takes a clean snapshot.

⛔ Do NOT "fix" this by broadcasting only `getActive()` calls. Ringing/dialing calls are broadcast
before they hold a qualifying bridge and must stay that way (INSTANT_HANGUP_SYNC 2026-08-31).

## 4. The fix (this commit)

- `apps/telephony/src/telephony/normalizers/normalizeCallEvent.ts` — new `isPseudoChannel()`
  (`Message/*` only). `isHelperChannel` unchanged (Local/, mixing/, Multicast/, ConfBridge/,
  Message/ still classify as helpers everywhere else).
- `apps/telephony/src/telephony/services/TelephonyService.ts` — the `CoreShowChannel`/`Newchannel`
  case `break`s on `isPseudoChannel(typed.channel)` BEFORE resolving a tenant or touching the store,
  logging `PIPE: pseudo_channel_skipped (never a call)` at info (once per bootstrap — the tell that
  the fix is running).
- `apps/telephony/src/telephony/services/pseudoChannelBootstrap.test.ts` — 5 tests: the verbatim
  production frame creates no call and emits no `callUpsert`; a replayed bootstrap and a
  `Newchannel` variant still create nothing; a real pre-existing PJSIP channel is still seeded; a
  `Local/` leg with a linkedid still attaches to its call (the guard is Message/-only).

Why the guard sits in the handler and not in the store: `upsertFromNewchannel` returns the call
(non-null) and the handler immediately feeds it to `applyCachedOutboundMohToChannel`; skipping
before the store keeps `channelIndex`/`channelByUniqueId` free of the pseudo-channel too.

## 5. Verification

- Dev box cannot run tsx (pnpm store ACL). The suites were run **inside a throwaway container of the
  production image** with the three files copied in:
  `docker run --rm -v /tmp/patch:/patch:ro -w /app/apps/telephony -e CDR_INGEST_URL=http://test.invalid/internal/cdr-ingest app-telephony sh -c "cp … && ./node_modules/.bin/tsx --test src/telephony/services/*.test.ts src/telephony/state/*.test.ts src/telephony/websocket/*.test.ts src/routes/*.test.ts"`
  → **232 tests, 232 pass, 0 fail** (the 5 new ones included).
- Acceptance after deploy: the telephony boot log shows `pseudo_channel_skipped` for
  `Message/ast_msg_queue`; `/telephony/diag` has no call whose only channel is `Message/…`;
  admin Active Calls stays clean across `docker compose restart telephony` / a PBX AMI reconnect
  without a page refresh.

## 6. Deploy

Recorded in the CLAUDE.md section for this handoff (queue job id, verification lines).
The deploy itself clears the live ghost: the telephony restart drops every WS client, each
reconnects and takes a fresh snapshot, and the new code never re-seeds it.

## 7. Side findings from the same investigation (not fixed here)

- ⛔ **The host `vmi3101417` hard-rebooted FOUR times tonight** — `journalctl --list-boots`:
  19:16:38, 19:18:20, 19:19:53 and 19:32:13 CEST; each previous boot's journal ends mid-noise
  (sshd brute-force lines) with no shutdown sequence. Cause unknown (provider/hypervisor or kernel);
  `connectcomms-cpu-watch.service` only logs `docker stats`, it does not reboot. Every reboot ran the
  bootstrap above, hence three ghost upserts. **Open item for Izzy.**
- ⛔ **The deploy queue does not survive a reboot.** pm2 `connect-deploy-worker` was not running
  (port 3910 dead, `pm2 ls` empty); `/root/.pm2/dump.pm2` (May 15) still lists it. Restored with
  `pm2 resurrect` — the saved process list, no rebuild. Nothing installs pm2 at boot (`pm2 startup`
  was never run / no unit). Worth a systemd unit or `pm2 startup`.
- ⛔ **`docker logs app-telephony-1` is unreliable after those reboots**: the full read stops in
  the pre-reboot rotated file (max-file 5 × 50 MB) and `--since 3h` returned only OLD lines while
  `--tail 3` showed the present. Read the raw json-file
  (`docker inspect --format '{{.LogPath}}'`, parse each line's `.log`) — that is where the
  17:33Z bootstrap lines were found. The same applies to `app-api-1`.
- The green "Incoming Call 8457170669 · Unknown caller" pop seen on a fresh super-admin load was a
  REAL Relax Tires call (answered on ext 101 at 21:24 CEST); `CrmScreenPop` shows every admin-visible
  inbound call regardless of the tenant selected in the sidebar. Cosmetic, not this bug.
- Trust Bookkeepings ext 105 (Mrs. Halpert) invite `cmtsyb5hg016hs313qf8ttzsp` at 19:36 CEST was a
  normal 12-second answered call — a red herring that only matched the "1h45m" timing.
