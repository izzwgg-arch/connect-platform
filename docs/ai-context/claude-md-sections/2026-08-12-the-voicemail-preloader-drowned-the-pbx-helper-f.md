# ⛔ AGENT HANDOFF — the voicemail preloader drowned the PBX helper; fix DEPLOYED + traffic-proven (2026-08-12) — READ FIRST for helper `audio_not_found` floods, "PBX CPU high with no calls", voicemail play/preload work, or before touching `streamVoicemailAudio`

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_VOICEMAIL_PRELOAD_FLOOD_2026-08-12.md`**
(fix commit `7bc11786` on `feat/ivr-migration-takeover`, api + portal **DEPLOYED
16:29 ET 2026-08-12**; touches no worker files, so the older worker container is
not stale for this).

- ⛔ **Exactly ONE code path POSTs the helper's `/voicemail/spool/audio`:**
  `streamVoicemailAudio` in `apps/api/src/server.ts` (the `:id/stream` /
  `:id/download` routes). The worker reads lists, never audio — a helper audio
  flood is ALWAYS the api relaying clients. This one was the desktop preloader
  (`?preload=1`) re-sweeping ~200 permanently-dead voicemails every 30 s;
  nothing cached the "gone" verdict, so each sweep re-paid VitalPBX REST +
  a spool list scan (Gesheft 101 = 9,200+ msgs) + the audio POST. The helper
  crashed at 11:35 (`Errno 24`, fd exhaustion), restarted 14:31.
- **The fix that shipped:** `Voicemail.audioGoneAt` (negative cache — checked
  first, answers 404 with zero PBX cost) + `Voicemail.localAudioPath` local
  audio store (one PBX fetch per message EVER; volume in BOTH api compose
  blocks) + notify scan bounded to `sinceOrigtime = newest − 6h` + the
  mini-dialer marks 404/410 ids gone in a module Set. ⛔ `audioGoneAt` is
  stamped ONLY by a pagination-COMPLETE identity scan that proves the origtime
  is absent — never by a timeout, and **never by a positional `msgNum` 404**
  (slots renumber; that's the "every voicemail plays the first one" trap).
- **Traffic-proven, not quiet-log-proven** (independent session, 17:00 ET):
  with the sweep still running ~100 req/min, helper audio POSTs went
  **3,074/hr + 394 not_found before the deploy → 0 + 0 after**. ⛔ Success is
  SILENT in api logs (local-store hits and audioGoneAt 404s log nothing) —
  judge from the helper journal on the PBX, and remember `docker logs` wipes
  at every deploy, so a 0-match grep minutes after a restart proves nothing.
- ✅ **The helper hardening IS live on the PBX** (installed 19:33 ET same day
  under Izzy's explicit permission): helper `2026.08.12.1` — bounded server
  (32 in-flight, fast 503), 30s socket timeout, per-mailbox scan cache — plus
  fd-limit drop-in `20-fd-limit.conf` (`LimitNOFILE=65536`; the soft limit was
  **1,024**, which is what both fd-exhaustion wedges hit). Backup
  `/root/helper-backup-fdfix-20260812-193319.py`; probe went 30s → **2.7 ms**.
  ⛔ **The merge trap that came with it:** `1b0771bb` branched **13
  helper-commits behind** the tip, so merging CONFLICTS on both helper files
  even though its content was built on the live file. Resolve by taking the
  fix's files — but ONLY after grepping them for every our-branch marker
  (`restore_gui_conf_ownership`, `connect-doorway`, `doorway-status`) and
  running the 33-case drift guard; and before installing ANY externally-built
  helper, `sha256sum` the live PBX file against the fix's claimed base — a
  mismatch means silent downgrade. Merge `c756c742`; the api half (inspect
  15s→45s, spool list 12s→30s — the aborts that fed the thread pile-up)
  deployed as `c7da4043`, container-verified.
- **Every open portal window now learns about a deploy** (`0cf18b14`, deployed
  + bundle-verified): `GET /version` (unauthenticated, reads `.next/BUILD_ID`)
  + `PortalReloadNotice` mounted in `app/providers.tsx` — full window,
  mini-dialer AND browser tabs poll every 5 min + on focus, and show
  "Connect was updated — Reload" when the build id changes. **Never
  auto-reloads** (a reload tears down the SIP softphone mid-call); dismissal
  is per-build so it re-arms next deploy. ⛔ Don't confuse with
  `DesktopUpdateToast` in the same file — that covers ELECTRON SHELL updates
  only and is mounted only in SidebarNav; the mini-dialer had NO update
  surface before this. Windows opened before `0cf18b14` still need ONE manual
  reload — after that, no deploy is silent again.
- ⏳ **Not yet proven:** a real voicemail measured arriving in seconds (the
  instant-delivery half). Acceptance: `voicemail-notify: sync complete` with
  `upserted_count ≥ 1` (not `helper_error:…timeout`), then
  `voicemail: arrival audio copied to local store`, then Play is instant.
  Also open: Gesheft 101/102 mailbox cleanup (9,200 + 2,600 msgs) — ⛔ **now on a
  clock: `maxmsg=9999` and 101 holds 9,146, so at ~35/day it hits "mailbox full"
  in 3–4 weeks and callers stop being recorded at all** (voicemail-email handoff
  §9) — and the VitalPBX REST voicemail read returning 0 fleet-wide (why
  everything rides the helper spool path at all).
