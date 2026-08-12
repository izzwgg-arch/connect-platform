# AGENT HANDOFF — the voicemail preloader drowned the PBX helper, and the fix is traffic-proven (2026-08-12)

**Read this before touching voicemail audio resolution (`streamVoicemailAudio`),
the desktop/portal voicemail preloader, the on-PBX helper's spool endpoints, or
before believing any "PBX CPU high with no calls" or "helper flooded with
audio_not_found" report is new.**

Fix commit: `7bc11786` ("feat(voicemail): instant delivery + instant play, one
PBX fetch per message ever") on `feat/ivr-migration-takeover`, authored 15:24 ET
2026-08-12, **DEPLOYED 16:29 ET the same day** (api + portal; the commit touches
no worker files, so the 5-day-old worker container is NOT stale for this).
Verified independently by a second session at ~17:00 ET with live traffic — the
numbers are in §3, and they are the acceptance test for any regression.

---

## 1. The incident

The connect-pbx-helper journal on the PBX (`journalctl -u connect-pbx-helper`)
showed **~58 POSTs/minute to `/voicemail/spool/audio`**, most failing
`LookupError: audio_not_found` (1,727 requests in one observed 30-minute window
on the evening of 2026-08-12). Earlier the same day the same machinery pinned
the PBX at 30–40% CPU with **zero active calls** and crashed the helper at
11:35 with `[Errno 24] Too many open files` (restarted 14:31 ET).

**The caller is exactly one code path.** `grep -rn
fetchVoicemailSpoolAudioFromHelper` across the repo: only `streamVoicemailAudio`
in `apps/api/src/server.ts` (serving `GET /voice/voicemail/:id/stream` and
`/download`) ever POSTs to the helper's audio endpoint. The worker's voicemail
sync reads **lists**, never audio. So a helper audio flood is always the api
relaying client requests — and the client was the desktop app's voicemail
preloader (`?preload=1`), sweeping its whole visible list every ~30 s.

**Why it looped:** a voicemail whose spool file is deleted on the PBX is gone
forever, but nothing cached that verdict. Every sweep re-paid the full
resolution chain per dead message: VitalPBX REST
`getExtensionVoicemailRecords` (php-fpm burn) → helper `POST
/voicemail/spool/list` (a scan of the mailbox — Gesheft ext 101 holds 9,200+
messages) → helper `POST /voicemail/spool/audio` → `audio_not_found` → client
retries next sweep. One office = ~200 dead voicemails × a sweep every 30 s.
Same design family as the softphone self-lockout (2026-08-10): **a client
repair/retry loop whose cost exceeds any server budget.**

## 2. The fix (commit `7bc11786`, deployed)

- **`Voicemail.audioGoneAt`** — the negative cache. Checked at the very top of
  `streamVoicemailAudio`: a stamped row answers **404
  `voicemail_audio_gone`** without touching the PBX at all. ⛔ It is stamped in
  ONE place only: when an origtime-identity spool scan completes with
  `paginationComplete !== false` and the message's origtime is absent from the
  mailbox. **A helper timeout, error, or partial scan must never stamp it** —
  and a positional `audio_not_found` on a stale `msgNum` must never stamp it
  either (msgNum names a SLOT, not a message; see the 2026-08-11
  "every voicemail plays the first one" incident).
- **`Voicemail.localAudioPath` + local audio store**
  (`apps/api/src/voicemail/audioStore.ts`, `VOICEMAIL_AUDIO_STORAGE_DIR`,
  volume `voicemail-audio` mounted in **BOTH** api compose blocks — `api` and
  `api_candidate`): every successful PBX fetch persists the original bytes;
  every later play/preload/download serves from Connect's own disk. Fresh
  arrivals are copied at ingest time. One PBX fetch per message, ever.
- **`/internal/voicemail-notify`** bounds its helper scan to
  `sinceOrigtime = newest-known − 6h`, so the instant-delivery path scales with
  what's NEW, not with mailbox size. (The unbounded scan of Gesheft's mailbox
  blew its 20 s timeout on EVERY MessageWaiting event — THAT was the 2–3 min
  voicemail-arrival latency; the worker's ~5-min sweep was the fallback
  everyone was living on.)
- **Portal mini-dialer preloader** (`DesktopMiniDialer.tsx`): 404/410 marks the
  id gone in a module-scope Set and never re-requests it; 5xx stays retryable.
- Migration `20260812…` (Voicemail columns) — **applied in prod**; at 17:00 ET
  the DB showed 140 rows stamped gone, 158 stored locally, of 35,095 total.

## 3. Verification — the before/after numbers (17:00 ET, second session)

The preload sweep was still running hot while measured (~100 stream
requests/min on loopcom, exts 101/104/105, user yisraelweinstock / "Orders"),
so this is traffic-proven, not a quiet-log claim:

```
journalctl -u connect-pbx-helper, POST /voicemail/spool/audio | audio_not_found
  14:31–15:31 (helper restart → pre-deploy):  3,074  |  394
  15:31–16:29 (pre-deploy):                     627  |  116
  16:29–17:05 (post api deploy):                  0  |    0     ← fix live
```

Only ~65 bounded `spool/list` scans remained in the post-deploy window (the
identity scans that stamp verdicts / find current slots).

⛔ **Verification traps — both bit this session:**
- **Success is silent in api logs.** A local-store hit logs NOTHING, and the
  `audioGoneAt` 404 reply logs NOTHING. 1,890 `voicemail: stream request`
  lines in 20 min with zero `helper_audio_fallback` / `streamed by origtime
  identity` lines is the fix WORKING, not the route dying. Ground truth is the
  helper journal on the PBX, not the api log.
- **`docker logs` wipes on every deploy** (blue/green container swap). A
  0-match grep minutes after a deploy proves nothing about the hour before.
  The api container had restarted 45 s before the first measurement and made
  three successive greps look contradictory.

## 4. What is still open

1. ~~The PBX still runs helper `2026.08.06.6`~~ — **DONE 19:33 ET the same
   evening**: helper `2026.08.12.1` installed on the PBX under Izzy's explicit
   permission. Full record in §5.
2. **Desktop apps pick up the portal preloader fix only when their window
   reloads.** The deploy-reload notice (`0cf18b14`, deployed same evening —
   §6) pushes open windows to reload; an office that ignores it keeps the old
   client behavior — which the server-side `audioGoneAt` 404s now absorb
   cheaply, but the requests still arrive. Windows opened BEFORE `0cf18b14`
   never see any notice and still need one manual reload/restart.
3. ⏳ **Not yet proven:** a real voicemail measured arriving on a softphone in
   seconds (the instant-delivery half of `7bc11786`), and the first-play-instant
   claim. Prove with a live deposit, not by reading the code. Acceptance:
   `docker logs app-api-1 | grep "voicemail-notify: sync complete"` shows
   `upserted_count ≥ 1` (not the old `helper_error:…timeout`), followed by
   `voicemail: arrival audio copied to local store`.
4. **Gesheft 101/102 mailboxes need an actual cleanup** (9,200 + 2,600
   messages) — every operation on them is heavy regardless of caching.

## 5. Helper `2026.08.12.1` installed on the PBX (19:33 ET, Izzy's permission)

The `1b0771bb` hardening is LIVE: `BoundedThreadingHTTPServer` (max 32
in-flight, fast 503 when saturated, env `CONNECT_PBX_HELPER_MAX_INFLIGHT`),
30 s handler socket timeout, per-mailbox spool-scan cache keyed on folder-dir
`(mtime_ns,size,ino)` with single-flight, best-effort audit writes.

- **Install route** (the established one): extract `.py` from the commit → scp
  to PBX `/tmp` → remote `python3 -m py_compile` → `cp -p` backup →
  `cat src > dest` (preserves the target inode's root:root 755) → restart.
  Backup: **`/root/helper-backup-fdfix-20260812-193319.py`**; rollback is
  `cat` it back + `systemctl restart connect-pbx-helper`.
- **fd ceiling**: drop-in
  `/etc/systemd/system/connect-pbx-helper.service.d/20-fd-limit.conf` with
  `LimitNOFILE=65536` (the soft limit was **1,024** against a 524k hard limit —
  Python honors the soft one; that's what the two fd-exhaustion wedges hit).
  The CAP_CHOWN/CAP_FOWNER drop-in survived the restart (`getpcaps` verified).
- **Post-install health**: 5 fds / 1 thread idle; an unauthorized probe answers
  **401 in 2.7 ms** (the wedged helper took 30 s for the same probe); 63
  requests served in the first sampled minute, all 200.
- ⛔ **THE MERGE TRAP**: `1b0771bb` branched from `5419bdd2` — **13
  helper-commits behind** the branch tip — so `git merge` CONFLICTS on both
  helper files even though the fix's CONTENT was built on the live file.
  Resolution: take the fix's files wholesale, but ONLY after verifying they
  contain every our-branch marker (`restore_gui_conf_ownership`,
  `_chown_gui_conf`, `connect-doorway`, `doorway-status`, `vm_spool_read_audio`)
  plus the new `BoundedThreadingHTTPServer`, and the drift guard passes on the
  resolved copies (`npx tsx --test
  scripts/pbx/install-vitalpbx-inbound-route-helper.test.ts` — 33/33).
  ⛔ Before installing ANY externally-built helper file, hash-compare the live
  PBX file against the base the fix claims (`sha256sum` both sides) — a
  mismatch means the "fix" is a silent downgrade of live-only features.
  Merge commit: `c756c742`.
- **The api half rode the same merge** and deployed as `c7da4043`: helper
  client inspect timeout **15 s → 45 s**, spool list **12 s → 30 s** — the
  15 s aborts + retries were what fed the thread pile-up.

## 6. Deploy-reload notice (`0cf18b14`) — every open window learns about a deploy

The desktop shell loads the HOSTED portal, so a portal deploy used to reach
nobody until each machine was manually restarted. Now:

- **`GET /version`** (`apps/portal/app/version/route.ts`, unauthenticated,
  `force-dynamic`, no-store): returns the running build id from
  `.next/BUILD_ID` (checks both `cwd/.next` and `cwd/apps/portal/.next` — the
  standalone server runs from `/app`); answers `"dev"` outside production and
  the client ignores that value.
- **`PortalReloadNotice`** (in `components/DesktopUpdateNotice.tsx`, mounted in
  `app/providers.tsx` so full window + mini-dialer + browser tabs all get it):
  captures the build id at load, re-polls every 5 min and on window focus;
  on change shows "Connect was updated — Reload" (same visual pattern as the
  shell-update toast). **Never auto-reloads** — a reload tears down the SIP
  softphone mid-call; the card says to finish the call first. Dismissal is
  remembered per build id, so it re-arms on the next deploy.
- ⛔ **Do not confuse it with `DesktopUpdateToast`** (same file): that one
  covers ELECTRON SHELL updates via `window.connectDesktop.updates`, is
  mounted only in `SidebarNav`, and knows nothing about portal deploys. The
  mini-dialer window had NO update surface at all before `0cf18b14`.
- Verified live: `curl https://app.connectcomunications.com/version` returns a
  real build id, and the "Connect was updated" string is in the deployed
  shared chunk.

## 7. Diagnostics recipe (next "helper flooded" / "PBX busy, no calls" report)

```bash
# On the PBX (read-only): rate + verdicts, and who
journalctl -u connect-pbx-helper --since '-30 min' | grep -c 'POST /voicemail/spool/audio'
journalctl -u connect-pbx-helper --since '-30 min' | grep -c 'audio_not_found'

# On loopcom: is the sweep running, and for whom
docker logs app-api-1 --since 20m 2>&1 | grep -c 'voicemail: stream request'
docker logs app-api-1 --since 20m 2>&1 | grep 'voicemail: stream request' \
  | grep -o '"ext":"[0-9]*"' | sort | uniq -c | sort -rn

# Adoption of the negative cache / store
docker exec connectcomms-postgres psql -U connectcomms -d connectcomms -c \
  'select count(*) filter (where "audioGoneAt" is not null) as gone,
          count(*) filter (where "localAudioPath" is not null) as stored,
          count(*) as total from "Voicemail";'
```

High stream-request volume on loopcom with **zero** helper audio POSTs is the
healthy post-fix state. Helper audio POSTs climbing again means either a new
un-stamped population of dead voicemails (fine — they stamp themselves once) or
a regression in the `audioGoneAt` / local-store path (not fine — start at
`streamVoicemailAudio`'s top-of-function ordering: local store → audioGoneAt →
identity scan → legacy chain).
