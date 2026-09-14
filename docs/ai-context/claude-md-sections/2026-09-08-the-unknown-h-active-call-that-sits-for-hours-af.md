# ⛔⛔ AGENT HANDOFF — the "<unknown> → h" Active Call that sits for hours after a reboot is Asterisk's `Message/ast_msg_queue` pseudo-channel, seeded as a call at AMI bootstrap and never removable (2026-09-08) — READ FIRST for ANY "stuck call / Unknown on Active Calls that only a refresh clears", before touching the CoreShowChannel/Newchannel handler, isHelperChannel, or the broadcaster's upsert path

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_GHOST_MESSAGE_CHANNEL_2026-09-08.md`**
(telephony only, on `feat/ivr-migration-takeover`. Deploy state at the end of this section.)
Izzy: *"There is a stuck phone call and active calls say unknown for 1 hour and 45 minutes."*
Memory: [[ghost-call-message-pseudo-channel]].

- ⛔⛔ **THE CAUSE: every AMI bootstrap (`CoreShowChannels` after connect/reconnect) replays
  Asterisk's permanent `Message/ast_msg_queue` pseudo-channel (Up, context `messages`, exten `h`,
  CallerID `<unknown>`, 163 h old, linkedid = its own uniqueid). The handler's helper guard only
  skipped helpers WITHOUT a linkedid, so the store created call `1788305013.58084` (up,
  `<unknown>` → `h`, tenant null) and the broadcaster pushed `call.upsert` to ADMIN sockets
  (null tenant ⇒ admins only — why only Izzy saw it).** It fails `hasValidChannel`, so it is in NO
  snapshot and NO sweep (`getActive`, `reconcileLiveChannels`, the ghost sweep all need a channel
  ABSENT from ARI — this one is always present), and it never hangs up: one upsert, zero removes.
  Tell: a fresh load is clean, a tab open across the reboot shows the row with a timer counting
  from the boot second. Seen at 17:19Z, 17:20Z, 17:33Z — the three bootstraps of tonight's reboots.
- ✅ **THE FIX: `isPseudoChannel()` (Message/* only) in `normalizeCallEvent.ts`; the
  Newchannel/CoreShowChannel case `break`s on it before resolving a tenant or touching the store,
  logging `PIPE: pseudo_channel_skipped (never a call)`.** Local/ helpers are untouched (they
  belong to a real call and DO hang up). Test `services/pseudoChannelBootstrap.test.ts` (5) —
  run inside a throwaway container of the prod image: **232/232 across services+state+websocket+routes.**
- ⛔ **Every `this.calls.delete` path emits `callRemove` — the ghost was never DELETED, it was
  never ELIGIBLE.** Don't "fix" by broadcasting only `getActive()`: ringing calls are broadcast
  before they qualify and must stay that way (INSTANT_HANGUP_SYNC 2026-08-31).
- ⛔ **Reading the store: `curl -H "x-cdr-secret: $CDR_INGEST_SECRET" http://127.0.0.1:3003/telephony/diag`
  (port is on host loopback; secret via `docker exec app-telephony-1 printenv`). Print the
  `isActive:false` rows too — the ghost hides there; filtering to active rows cost 20 minutes.**
- ⛔ **`docker logs app-telephony-1` LIED after the reboots**: the full read stops in the
  pre-reboot rotated file and `--since 3h` returned only OLD lines. Only `--tail N` or the raw
  `$(docker inspect --format '{{.LogPath}}' app-telephony-1)` (parse each line's `.log`) show
  post-boot lines. Same for `app-api-1`.
- ⛔ **The host hard-rebooted FOUR times (19:16, 19:18, 19:19, 19:32 CEST, `journalctl --list-boots`;
  no shutdown sequence in any of them) — cause unknown, open for Izzy. The deploy queue (pm2
  `connect-deploy-worker`) does NOT survive a reboot** — port 3910 dead, `pm2 ls` empty;
  restored with `pm2 resurrect` from `/root/.pm2/dump.pm2`. ✅ **FIXED 21:58 CEST (Izzy: "fix the
  deploy queue so it survives a reboot"): `pm2 startup systemd -u root --hp /root` installed and
  enabled `/etc/systemd/system/pm2-root.service` (`ExecStart=pm2 resurrect`, `After=network.target`,
  `PM2_HOME=/root/.pm2`), `pm2 save` refreshed the dump (7.9 KB, carries the worker's env incl.
  `DEPLOY_QUEUE_TOKEN`), trial `systemctl start pm2-root` exited 0 with the worker untouched.
  ⛔ After ANY change to the pm2 process list run `pm2 save`, or the next boot restores the old
  list. Docs: `docs/safe-deploy-queue.md` § Boot persistence.**
- ✅ **DEPLOYED: telephony queue job `939eec1b` (commit `cfc17107`, enqueued at 1 active call,
  build 51 s, restart 20 s, health OK) — container-verified: both markers in the running src,
  boot log `pseudo_channel_skipped` for `Message/ast_msg_queue`, 0 ghost upserts, 0 error lines,
  `Message/` channels in store = 0, AMI+ARI connected.** The restart itself cleared the live
  ghost from every admin socket (reconnect ⇒ fresh snapshot). First attempt `cd34710d` failed on
  the host's `run-heavy.sh` lock while a direct portal deploy was building — that lock is real,
  wait for it. Deploy queue `dd5c89e7` was the dry-run.
