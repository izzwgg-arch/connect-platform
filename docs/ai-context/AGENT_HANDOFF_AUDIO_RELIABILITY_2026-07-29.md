# AGENT HANDOFF — Audio/Reliability/Notifications engagement (2026-07-29)

Owner: Izzy (plain English only — no jargon in anything user-facing).
Branch: `feat/ai-agent`. This doc covers the July 29 all-day session that followed
the July 28 overnight push. Read this AND `NOTIFICATION_RELIABILITY.md` before
touching mobile SIP/audio, push notifications, or anything listed under
"Suspended" below.

## Fleet / publish state at handoff

- **Published latest**: `connectcomms-v1.0.0+20260729.6` = commit `a0eb96bf`
  (round-5 state: mic-safe incoming, limiter speaker 900mB+bass80, wire-truth
  keepalive, pcConfig fix, fresh-ICE overlay, stall-proofing).
- **Built, verified on Izzy's phone, NOT published**: `.7` candidate = commit
  `a4524f6c` (adds volume-button hush + serialized register()). Izzy explicitly
  DECLINED the publish — do not publish without his word.
- **Izzy's phone** (SM-S921U, USB serial RFCXC0CEZ6V) runs the `.7`-equivalent
  build. His device row: `cms450wi40hijqj13yr05wlxq` — featureFlags
  `{standingRegistration:true, forceTurnRelay:false}` (relay was tested ON and
  reverted; see Relay below).
- **standingRegistration activated fleet-wide** (86 Android rows, 79 flipped on
  2026-07-29 ~20:00Z). New ANDROID registers default it on server-side.

## Root causes found TODAY (each with production evidence)

1. **JsSIP discards UA-level `pcConfig`** (verified: `ua._configuration.pcConfig
   === undefined`). Every mobile call EVER ran with an empty RTCPeerConnection
   config — no STUN/TURN. Fixed: `callPcConfig` stored on the client, passed
   explicitly to `ua.call()` and `session.answer()` (jssip.ts). Log proof line:
   `[SIP] pcConfig: iceServers=N policy=...`.
2. **Cached TURN credentials expire in 24h** — the SecureStore provisioning
   bundle is never refreshed, so the fleet was relay-dead (`iceHasTurn:false`).
   Fixed: `GET /voice/ice-servers` (fresh HMAC creds, rate-limited) + mobile
   overlay at register (`ensureProvisioningLoaded`, throttled 5 min) + live
   injection on token-hydrate (`updateIceServers()` — pcConfig is per-call, no
   re-register needed). Log proof: `[SIP] iceServers live-updated (6 entries)`.
3. **Forcing relay with dead creds stalled ICE gathering → "calls not
   connecting at all"**. Fixed forever: `icecandidate` ready() cap — SDP goes
   out 1.5s after the newest candidate; a dead ICE server can cost 1.5s, never
   the call (bindSession, jssip.ts).
4. **Half-open 5G sockets + silent registration expiry** (one-way audio /
   dial-into-void incident, 13:43 EDT): app dialed on an 11.3-min-old
   registration ("regAgeMs=679800") while believing "Already registered"; the
   OPTIONS keepalive loop wasn't even running (flag-hydration race). Fixed:
   wire-truth keepalive (10s response deadline per OPTIONS, registration-age
   watchdog >540s forces rebuild, gates SIGNAL instead of silently returning,
   dial-time stale-reg guard). Mirrors portal commit `aaed7df1`.
5. **Ghost double registration** (multi-ring contributor): concurrent
   `register()` callers at app start both passed the pre-promise guard window
   and BOTH built UAs; the orphan kept refreshing a second PBX contact forever.
   Evidence: doubled log lines all day + two live `T21_101_1` contacts. Fixed:
   `register()` is now a strict serial chain wrapping `registerInner()`
   (task #20 CLOSED). Boot log must show SINGLE "Registered successfully".
6. **Quad-notification incident (evening)**: NOT the app. A cowork session's
   "cold-mobile wake engine, audible-ringback variant" dialplan
   (`extensions__68_connect_wake_rb.conf`) intercepted T21 ext 101; the carrier
   redelivered each call 4× (four distinct linkedids, ~1.5s apart, separate
   trunk channels). DISABLED under mandate `wake-rb-removal-2026-07-29`: file
   moved to `.disabled`, backup at `/root/extensions__68_connect_wake_rb.conf.disabled-20260729`
   on the PBX, dialplan reloaded. Izzy later confirmed the experiment was his
   own (other chat) — "my fault, everything is good". The wake-autoenroll
   worker cycle (`WAKE_AUTOENROLL_ENABLED`, 5-min interval) manages the __60
   shared engine for 10 targets and does NOT republish the -rb file.

## PBX changes live (mandates)

- `fec-2026-07-29`: `/etc/asterisk/codecs.conf` `[opus] fec=yes,
  packet_loss=5`. Backup `codecs.conf.bak-20260729-pre-fec`. codec_opus module
  cycled cleanly. NOTE: packet_loss=10 (the 2026-07-28 experiment) muffled
  audio — never raise back to 10.
- `wake-rb-removal-2026-07-29`: see #6 above.
- PBX remains READ-ONLY outside explicit mandates. It runs EDT (UTC-4);
  loopcom runs CEST — convert before grepping logs.

## Relay / TURN facts

- coturn RUNS on loopcom (45.14.194.179:3478, use-auth-secret matches api env).
  Its file logging died 2026-04; allocation verified live via
  `turnutils_uclient -W <secret>`.
- **loopcom is in FRANCE; the PBX is in St. Louis** (ipinfo verified;
  loopcom↔PBX ping 105ms). Forced relay = +150ms RTT (grade drops to "fair"
  from delay alone) but **0.02% loss vs 2–6.5% direct** on bad 5G. The proper
  fix is a small US/St-Louis Contabo VPS running coturn — Izzy must purchase;
  then wire its URLs into TURN config and re-test.
- Per-device `forceTurnRelay` featureFlag flips media to relay-only
  (`iceTransportPolicy`), applied at UA build (needs app restart ×2 after a DB
  flag flip: restart 1 fetches the flag, restart 2 builds the UA with it).
- Direct + FEC currently sounds "pretty good" per Izzy — relay OFF everywhere.

## Suspended pending supervised incoming-call re-proof (round-5 reverts)

Two mic-dead-on-incoming incidents rode builds carrying these; each must be
re-introduced ALONE with live logcat + a real incoming call:
- **opus-only ANSWERS** (inbound negotiates PCMU again; outbound offers remain
  opus-only and proven). jssip.ts sdp handler.
- **Earpiece loudness boost** (`EARPIECE_NATIVE_GAIN_MB = 0` now).
- **Presence Equalizer** (+2dB @2.5kHz) — Samsung voice-call DSP suspected to
  break TX when global-mix effects attach mid-call; BassBoost(80)+
  LoudnessEnhancer(900mB) on SPEAKER are proven mic-safe.

## New standing systems (do not remove)

- **NotificationLedger + reconciler + canary** — see NOTIFICATION_RELIABILITY.md.
  Any new alert sender MUST claim the ledger first.
- **CallQualityHourly** learning store + hourly worker aggregation +
  CALL_QUALITY_DEGRADED audit incidents. Reports now carry SEND-side (uplink)
  loss (`txPacketsLost/txFractionLost`, capped into qualityGrade).
- **Wire-truth keepalive** logs: `[SIP_KEEPALIVE_PING] started ... (wire-truth)`
  must appear right after every "Registered successfully".
- **answered_elsewhere ring-stop** (telephony → api `/internal/mobile-ring-notify`):
  fires on `extensionAnsweredAt` OR caller-bridge-established (bridgeIds
  non-empty; IVR/VM create no bridge). Cancels PENDING invites, INVITE_CANCELED
  reason `answered_elsewhere`, records NO missed call. Deployed `b93456ed`.
- **Volume-hush receiver** (in `.7` candidate): VOLUME_CHANGED broadcast while
  ringing → `silenceRingerKeepVibrating` — works background/killed.

## Working-method rules learned the hard way (Izzy insists)

- ONE change per build; supervised test (USB + live logcat) for anything
  touching incoming-call audio/mic BEFORE it reaches his phone; his sign-off
  before any publish. He rejected an unpublished-`.7` publish attempt —
  never publish without his explicit word.
- Rapid install cycles created the ghost-contact storm; space installs out.
- Deploy self-skip traps: worker needs `DEPLOY_FORCE_RESTART=1` after an api
  deploy; telephony needs the state-dir marker seed. deploy-api falls back to
  the container's `.build-commit` (no false skip). Run deploys detached
  (`nohup ... &`) — SSH drops killed one mid-flight.
- Container logs only cover the container's lifetime — check `docker ps`
  uptime before "no log lines" conclusions.

## Open board

- **US relay VPS** (Izzy purchase) → coturn install → re-test relay latency.
- **Adaptive audio (#8)**: the decision layer that reads CallQualityHourly and
  flips forceTurnRelay / tuning per device+network automatically. All
  actuators + data now exist.
- **RN-WebRTC library upgrade** for `jitterBufferTarget` (residual jitter).
- Re-prove the three Suspended items, one at a time.
- Ghost DEVICE rows cleanup (#19): register-time per-deviceId retirement exists;
  fleet-wide stale-token pruning still open.
- Loading spinner light/dark (#11). Mic "he hears me a little low": AGC already
  on; if persistent, propose PBX-side RX gain (needs mandate).
