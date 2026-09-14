# ⛔ AGENT HANDOFF — Eli iOS freezes → 443 route, paste-on-iOS-26, build 52 (2026-08-05) — READ FIRST for Displaydex, SIP-over-443, paste reports, voice diag telemetry, or TestFlight builds

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_ELI_IOS_443_PASTE_2026-08-05.md`**

- **Displaydex is LIVE on SIP-over-443**: nginx `location /sip` on loopcom now
  proxies DIRECTLY to `https://m.connectcomunications.com:8089/ws` (backup:
  `/root/nginx-connectcomms-backup-20260805-0410.conf`); tenant flipped to
  `webrtcRouteViaSbc=true, sipWsUrl=null`. Proven by raw-REGISTER probe → 401.
  Eli must sign out/in (the app never refreshes a cached `sipWsUrl`). Success
  signal: his `PbxEndpointRegistrationEvent.contactUri` = `45.14.194.179` —
  which also means PBX-side contact-IP whois is now MEANINGLESS for this
  tenant; use loopcom nginx logs.
- ⛔ **The `sbc-kamailio` container (loopcom :7443) is an UNFINISHED
  experiment** — dispatches to a nonexistent docker host `pbx`, answers
  `503 PBX Unavailable`, has never carried a call. Never route at it without
  finishing + testing.
- ⛔ **Telemetry traps:** `iceHasTurn:false` in voice diag is meaningless (the
  app never sends the field — server defaults false; RCA "TURN_missing"
  verdicts inherit the lie). A session stuck REGISTERING never heartbeats
  (effect ordering), so `alive:0s` ≠ app died. iOS CallFlightRecorder uploads
  ONE native seed event per call (`deviceId: null` — query by tenant), never
  the JS timeline.
- **Paste broken on Eli's iOS 26.5 but fine on Izzy's older iOS, same build**
  → OS-version incompatibility is the front-runner (permission theory
  retired: menu-paste never needs permission; the Settings row only appears
  after a programmatic clipboard read). Waiting on Eli's long-press
  observation; candidate fix = RN 0.81.5→0.81.6 in build 53 (re-lock pnpm).
- **Build 52 is the current TestFlight build** (launch-screen picker, paste
  explainer + Deny-wedge detector, keyboard-inset commit) — id
  `6d37750c-78e1-4fe2-87c3-f77a62336f16`, uploaded 2026-08-04, `VALID`, beta
  review **APPROVED**, attached to "Loopcom Testers"
  (`fe508ee6-4a3f-49dd-bf53-858839fa2f06`). Pipeline recipe +
  `asc-release-52.mjs` pattern in the handoff §6. Bump `buildNumber` in
  **app.config.ts**; `npx --yes eas-cli` (plain `eas` not installed on loopcom).
- **"Send him the latest build" = add him to the group, nothing more.** The
  newest build is already attached, so a `POST /v1/betaTesters` with a
  `betaGroups` relationship is the ENTIRE job — Apple fires the invite email
  itself. There is no separate build-push step. Testers as of **2026-08-10**:
  eli.lovi@outlook.com, izzwgg@gmail.com, fixupusa1@gmail.com,
  leibfrankel0999@gmail.com INSTALLED; yossi@yossiswoodworx.com,
  shulemfreund1@gmail.com INVITED.
- ⛔ **`GET /v1/betaGroups/{id}/builds` returns an EMPTY list even when builds
  ARE attached** — it made build 52 read as unattached and nearly bought a
  pointless re-attach. Ask the other direction:
  `GET /v1/builds?filter[betaGroups]={id}&sort=-version`. And
  `GET /v1/builds/{id}/betaGroups` is a hard **403 `GET_RELATED` not allowed**
  (CREATE/DELETE only), which reads like an auth failure and is not one.
- **SSH to loopcom works straight from the Bash tool here** (Git Bash):
  `ssh -i .connect-ssh/connect2_ed25519 -o IdentitiesOnly=yes root@45.14.194.179`
  from the repo root — the Linux-sandbox hop in §"Server access" is not required
  in this environment. Ship a script with
  `ssh … 'cat > /root/.appstoreconnect/x.mjs' < local.mjs`, then `node` it.
- **QSR prefix route**: dialer only shows routes with a per-user permission
  row. It was assigned to Yehuda by mistake — now Eli-only (not default). A
  duplicate QSR route sits in the QSR tenant itself as clutter.
