# WebRTC / Mobile SIP Diagnostics

> Companion to `TELEPHONY.md`. Read `CURSOR_START_HERE.md` first.
> This doc captures **mobile softphone registration diagnostics**, incident forensics,
> and hardening recommendations.
>
> **Live repro (read-only):** When prior forensics cannot prove where traffic stops,
> use **`WEBRTC_LIVE_REPRO_RUNBOOK.md`** — controlled capture with elevated PBX access,
> phone browser `:8089` test, fail2ban/firewall checks, and Case A–F decision matrix.

---

## Incident: WebRTC OUTBOUND fails — 488 / "Incompatible SDP" (2026-06-03/04)

> **Status: ROOT CAUSE LOCALIZED, NOT YET PROVEN. STOP-THE-LINE.**
> No deploy, no APK, no PBX media change until a client SDP offer from a failed
> outbound call confirms the exact mismatch. See **§ Stop-the-line rule** below.

### 1. Incident summary

- **Mobile and portal WebRTC outbound calls fail.** Mobile (Android) and portal both
  fail to place outbound calls. Mobile clients report JsSIP cause **`Incompatible SDP`**.
- **Hard-phone / trunk outbound works.** A non-WebRTC endpoint dialed out to PSTN
  successfully (channel created → outbound route → trunk → connected).
- **Failed WebRTC outbound INVITEs never create an Asterisk channel.** The dialed
  number from a failed WebRTC outbound call has **zero** entries in the telephony/AMI
  event stream — no `Newchannel`, no dialplan, no trunk leg.
- **Failure occurs before dialplan / trunk.** Because no channel is created, the INVITE
  is rejected at PJSIP media negotiation **before** the dialplan, outbound route, or
  trunk are ever reached.
- **Current evidence** points to **Asterisk rejecting the client SDP offer with
  488 / Incompatible SDP** (media/offer-answer negotiation), OR the client rejecting
  Asterisk's answer SDP. The exact rejected attribute/codec is **not yet captured.**

> **Caveat on the prior "fix":** `CHANGELOG.md` 2026-06-03 ("Mobile SIP call reliability")
> attributes this to strict `channelCount`/`sampleRate` audio constraints and claims a fix
> in `voiceAudioConstraints.ts` (commit `5a63561b`). That commit is **NOT deployed**
> (authored after the last `api` deploy `9e61f7f` @ 19:05 UTC) and the failure **still
> reproduces in production**, including on **portal** (which never used those mobile
> constraints). Treat that root cause as **unverified** until the SDP below is captured.

### 2. Proven healthy layers (read-only evidence, 2026-06-03/04)

| Layer | Status | Proof |
|-------|--------|-------|
| Registration / WSS `:8089` | ✅ works | Mobile `OUTBOUND_REGISTERED`; PBX contact `T30_102_1` `Avail` |
| Auth / credentials | ✅ not the cause | Would be 401/403; registration succeeds |
| Outbound route + VoIP.ms trunk | ✅ works | Non-WebRTC `PJSIP/T2_105` → `trk-18-dial` → trunk `PJSIP/355362_apluscenter` → PSTN `3472286660` connected (14:40 UTC) |
| Dialplan / trunk path (hard phone) | ✅ works | Same outbound call above created a channel and bridged |
| PBX WebRTC endpoint media config | ✅ healthy | `T25_101_1` config byte-identical to known-good `T30_102_1`: `webrtc=yes`, `media_encryption=dtls`, `dtls_setup=actpass`, `use_avpf=yes`, `rtcp_mux=yes`, `ice_support=yes`, `allow=!all,ulaw,alaw,gsm,g729,opus,vp8,vp9,h264,...` |
| **Inbound** WebRTC (Asterisk *offers* SDP) | ✅ works | `T2_103_1` bridged + answered; T25 ext 101 inbound answered (`SIP_CONNECTED`, `PBX_CALL_ANSWERED`) |
| **Outbound** WebRTC (client *creates the offer*) | ❌ **fails (488 / Incompatible SDP)** | Mobile flight rows below + zero PBX channel for dialed number |

**Key asymmetry:** Inbound (Asterisk builds the offer, client answers) works; outbound
(client builds the offer, Asterisk answers) fails. The fault is isolated to **outbound
WebRTC SDP offer/answer negotiation** where the **browser/mobile creates the offer.**

**Mobile flight-recorder evidence** (`CallFlightSession`, tenant Relax Tires `T25`/ext 101):

| Session | UTC | dir | result | warningFlags / sipCause |
|---------|-----|-----|--------|--------------------------|
| `cfs_mpyt5zfz_5b4me` | 2026-06-04 01:20:07 | OUTBOUND | failed | `OUTBOUND_MEDIA_SDP_REJECTED`, `sipCause="Incompatible SDP"` |
| `cfs_mpyrt0oc_0ozjw` | 2026-06-04 00:42:03 | OUTBOUND | failed | `OUTBOUND_FAILED_OTHER`, `sipCause="Incompatible SDP"` |
| `cfs_mpyealjz_45pq8` | 2026-06-03 18:23:48 | OUTBOUND | failed | `sipCause="Incompatible SDP"` |

Stages every time: `OUTBOUND_CALL_START → OUTBOUND_PERMISSION_CHECK(granted) →
OUTBOUND_INVITE_SENT(registered) → OUTBOUND_REGISTERED → OUTBOUND_FAILED` (~400–600 ms).

**Portal note:** Tested as tenant `T2` / ext 103 — different tenant + client from the
mobile test, confirming the failure is **not tenant- or client-specific.** Portal showed
no explicit error string. Portal fast failures (<1 s) **do not** post
`/voice/diag/call-quality-report` (`durationMs < 1000` early-return in `useSipPhone.ts`),
so they leave **no server-side trace** — they only appear in the browser console as
`[SIP] CALL_FAILED cause: …` and in `chrome://webrtc-internals`.

### 3. Missing decisive artifact

We need **one client-side SDP offer from a failed outbound call**. This is the only piece
that proves whether the offer (client) or the answer/488 (Asterisk) is the problem.

- **Portal (preferred):** `chrome://webrtc-internals` — no PBX access required.
- **Mobile (fallback):** `adb logcat` SDP / JsSIP / PeerConnection logs.

> Why not the PBX wire trace? The `pbx_audit@209.145.60.79` account is a restricted shell:
> it allows no-argument `pjsip show endpoints` / `pjsip show contacts` only. `pjsip set
> logger`, per-endpoint `show`, log file reads, and AMI `Command` are all **denied**, so a
> server-side SIP/SDP trace requires elevated PBX SSH (out of scope here).

### 4. Portal capture steps (chrome://webrtc-internals)

1. Open Chrome.
2. Open **`chrome://webrtc-internals`** in a **separate tab** (must be open *before* the call).
3. Log into the Connect portal in another tab.
4. Place **one** failed outbound call from the WebRTC softphone (Dashboard → Voice → Phone).
5. Return to the `chrome://webrtc-internals` tab.
6. Find the **failing PeerConnection** (the one created at the call timestamp).
7. Copy:
   - `createOffer` SDP
   - `setLocalDescription` SDP
   - any `setRemoteDescription` error (or absence of a remote description)
   - ICE / DTLS details (candidate types, DTLS state)
   - timestamps
8. Save as a text file:
   `webrtc-outbound-failed-<tenant>-<extension>-<timestamp>.txt`

### 4b. Portal in-app capture (instrumented 2026-06-04) — USE THIS, not webrtc-internals

⚠️ **`chrome://webrtc-internals` is unreliable for this portal:** in a live 2026-06-04 capture
it showed **only `getUserMedia`/`getDisplayMedia`** entries and **no `RTCPeerConnection`
section / no `setLocalDescription` SDP**, even though the Console showed ICE gathering
(`gathering → complete`) and then `[SIP] CALL_FAILED cause: Incompatible SDP`. Do **not** rely
on it — use the in-app capture below.

The portal softphone (`apps/portal/hooks/useSipPhone.ts` + `apps/portal/lib/webrtcSdpDiagnostics.ts`)
captures the full outbound lifecycle directly from the JsSIP session (read-only; the offer is
**never munged**). It is **gated** (off for normal users) and **redacts ICE credentials**
(`a=ice-ufrag`/`a=ice-pwd`) and candidate/connection IPs; the DTLS fingerprint (public) and all
codec/fmtp/profile lines are kept.

1. Open the portal, DevTools → **Console**.
2. Enable debug (any one): append **`?webrtcDebug=1`** to the portal URL, **or**
   `localStorage.setItem("cc_webrtc_sdp_debug","1")` then reload. (Dev builds: always on.)
3. Place **one** failed outbound call.
4. Read the Console:
   - `[SIP] CALL_INITIATED target: …`
   - `[WEBRTC_SDP] local offer summary { profiles, audioCodecs, rtcpMux, bundle, dtls, setup, ice, compatibilityIssues }`
   - on failure, **`[WEBRTC_SDP_REJECT]`**: `sipCode`, `reason`, `cause`, offer summary, and the
     redacted offer SDP.
   - **`[WEBRTC_SDP_DEBUG]`**: the full structured record (target, `ua.call()` invoked/returned,
     sessionId, peerconnection event, redacted offer SDP, failed cause, SIP `status_code` +
     `reason_phrase` + method).
5. **Download the artifact:** run **`__ccDownloadWebrtcDebug()`** in the Console (or copy
   `window.__ccWebrtcDebug`) → saves `webrtc-debug-<ts>.json`.
6. The SDP-reject is also posted server-side (ungated, label only) to
   `POST /voice/diag/call-quality-report` (`endReason: WEBRTC_SDP_REJECT_<code>`).

> Why this exists: webrtc-internals didn't surface the PeerConnection, and the normal
> call-quality report drops sub-1s failures — so the fast 488 reject produced **no** capturable
> artifact. This path makes the offer + SIP status visible and unambiguously labeled.

### 5. Mobile capture steps (adb logcat)

1. Connect the phone via `adb`.
2. Run:
   ```bash
   adb logcat | grep -iE "jssip|sdp|peerconnection|m=audio|a=rtpmap|a=fmtp|dtls|ice"
   ```
3. Place **one** failed outbound call.
4. Save output as:
   `mobile-outbound-failed-<tenant>-<extension>-<timestamp>.log`

### 6. What to look for in the SDP

- `m=audio` line (port, transport profile `UDP/TLS/RTP/SAVPF`)
- Codecs offered (payload type list on the `m=audio` line)
- `opus` / `ulaw` (PCMU=0) / `alaw` (PCMA=8) payload types and `a=rtpmap` / `a=fmtp`
- DTLS `a=fingerprint:` and `a=setup:` (actpass/active/passive)
- ICE `a=ice-ufrag` / `a=ice-pwd` / `a=candidate` lines
- `a=rtcp-mux`
- `a=group:BUNDLE` / bundle lines
- `a=extmap` lines
- Unsupported constraints / codecs (e.g. an offer with **no** codec Asterisk's `allow` accepts)
- Missing required WebRTC/Asterisk attributes (no fingerprint, no ufrag, wrong profile)

### 7. Stop-the-line rule

**No deploy, no APK, no PBX media changes** until the captured SDP proves the exact
mismatch. The failure is localized but the specific rejected attribute/codec/offer shape
is **not yet proven** — shipping a change now risks fixing the wrong layer.

### 8. Next action once SDP is captured

1. Compare the **portal** failed SDP and the **mobile** failed SDP.
2. Compare against a **known-good** portal/mobile SDP if one is available (e.g. a prior
   working capture, or an inbound-answer SDP from the same endpoint).
3. Identify the **exact** rejected attribute / codec / offer shape.
4. Fix the **narrowest** layer only:
   - client SDP generation, **or**
   - JsSIP / WebRTC media constraints, **or**
   - Asterisk WebRTC endpoint media config, **or**
   - codec negotiation, **or**
   - ICE / DTLS config.

### 9. Endpoint config comparison — `T2_103_1` vs `T30_102_1` (2026-06-04, live AMI)

Captured live from Asterisk via read-only AMI `PJSIPShowEndpoint` (runtime values, not
file text). `T2_103_1` = failing portal tenant; `T30_102_1` = known WebRTC reference.

| Field | `T2_103_1` (failing) | `T30_102_1` (reference) | WebRTC-correct? |
|---|---|---|---|
| `webrtc` | yes | yes | ✅ |
| `use_avpf` | true | true | ✅ |
| `force_avp` | false | false | ✅ |
| `media_encryption` | dtls | dtls | ✅ |
| `media_encryption_optimistic` | false | false | ✅ |
| `dtls_verify` | Yes | Yes | ✅ |
| `dtls_setup` | actpass | actpass | ✅ |
| `dtls_auto_generate_cert` | No (cert file) | No (cert file) | ✅ |
| `dtls_fingerprint` | SHA-256 | SHA-256 | ✅ |
| `ice_support` | true | true | ✅ |
| `rtcp_mux` | true | true | ✅ |
| `allow` | `(ulaw\|alaw\|gsm\|g729\|opus\|vp8\|vp9\|h264\|h263p\|h263)` | identical | ✅ |
| `transport` | `transport-wss-…` (wss) | identical | ✅ |
| `rewrite_contact` | false | false | ⚠️ atypical, identical on both |
| `rtp_symmetric` | true | true | ✅ |
| `force_rport` | true | true | ✅ |
| `direct_media` | false | false | ✅ |

**Conclusion: endpoint config is identical and WebRTC-correct.** No focus field is
misconfigured and the failing endpoint matches the working reference byte-for-byte. Static
endpoint config is **not** the cause. (`rewrite_contact=false` is atypical for NAT'd WebRTC
but is identical on the working reference and is not an SDP-negotiation field.)
Artifact: `_latency_logs/webrtc_endpoint_live.txt`.

### 10. Codec runtime verification — hypothesis **DISPROVEN** (2026-06-04, live AMI)

Hypothesis: opus is listed in `allow` but `codec_opus.so` isn't loaded at runtime, so an
opus-leaning WebRTC offer would 488 before channel creation. Tested via read-only AMI
`ModuleCheck` (a non-`Command` action — **permitted** for the `pbx_audit` user):

| Module | State |
|---|---|
| `codec_opus.so` | **LOADED** |
| `res_format_attr_opus.so` (opus fmtp negotiation) | **LOADED** |
| `codec_g729.so` / `res_format_attr_g729.so` | **LOADED** |
| `codec_ulaw.so` / `codec_alaw.so` | **LOADED** |
| `res_srtp.so` / `res_pjsip.so` | **LOADED** |
| Asterisk version | **20.18.2** (AMI 9.0.0) |

**Verdict: DISPROVEN.** opus and every relevant codec/format/SRTP module are loaded and
negotiable. A missing/unloaded codec module is **not** the cause of the 488.
Artifact + reusable probe: `_latency_logs/ami_codec_runtime.js`.

> **Where that leaves root cause:** both static endpoint config (§9) and runtime codec
> availability (§10) are now ruled out. The remaining candidates are (a) the **client offer
> SDP** itself (still the missing decisive artifact — capture per §4/§4b), or (b) an
> **Asterisk-20.18.2 / global media** behavior change on the PBX (e.g. a minor-version
> upgrade tightening SDP acceptance) — unprovable without full PBX shell (`/var/log/asterisk`
> is **not** mounted in the app containers). AMI read actions confirmed available to
> `pbx_audit`: `GetConfig`, `PJSIPShowEndpoint`, `ModuleCheck`, `CoreSettings`, `CoreStatus`.
> AMI `Command` (arbitrary CLI) remains **blocked**.

### Entity / access reference

| Item | Value |
|------|-------|
| Failing tenant (mobile) | Relax Tires `T25` / ext 101 / endpoint `T25_101_1` |
| Failing tenant (portal) | A plus center `T2` / ext 103 / endpoint `T2_103_1` |
| Known-good WebRTC endpoint | `T30_102_1` (contact `Avail`) |
| Last `api` deploy at incident | `9e61f7f` @ 2026-06-03 19:05 UTC |
| Last `portal` deploy at incident | `0f86e75` @ 2026-06-03 18:40 UTC |
| Undeployed "constraint fix" commit | `5a63561b` (authored after last deploy) |
| PBX read-only audit shell | `pbx_audit@209.145.60.79` (restricted: `pjsip show endpoints`/`contacts` only) |

---

## Architecture (mobile registration path)

```
Mobile app boot
  → SecureStore `cc_mobile_provision` (cached bundle)
  → SipContext.ensureProvisioningLoaded()
  → JsSipClient.configure(bundle)
  → JsSipClient.register()
       → WebSocket to bundle.sipWsUrl
       → SIP REGISTER (uri=sip:{sipUsername}@{sipDomain}, auth={authUsername})
  → VoiceDiagEvent ingest (SESSION_START, SIP_REGISTER*, ERROR, …)
```

**Provisioning sources (API):**

| Path | Code | Notes |
|------|------|-------|
| One-time / reset | `issueOneTimeProvisioningForUser()` in `apps/api/src/server.ts` | Decrypts `sipPasswordEncrypted`; updates `sipPasswordIssuedAt` only |
| QR exchange | `POST /auth/mobile-qr-exchange` | Consumes `MobileProvisioningToken`, then calls `issueOneTimeProvisioningForUser()` |
| Bundle builder | `buildVoiceProvisioningBundle()` + `resolveWebrtcConfig()` | Tenant `sipWsUrl` / `sipDomain` override env defaults |

**JsSIP config** (`apps/mobile/src/sip/jssip.ts`):

- `uri`: `sip:{sipUsername}@{sipDomain}`
- `authorization_user`: `authUsername` (PJSIP auth object, e.g. `T25_101_1`)
- `password`: decrypted SIP secret
- 20 s registration timeout → `registrationState: "failed"`

**No tenant-specific branches** in `apps/mobile/src` for Relax Tires / T25.

---

## VoiceDiag event caveats

### `WS_RECONNECT` with `state: "failed"` is mislabeled

In `apps/mobile/src/context/NotificationsContext.tsx` (~3813–3815), when
`sip.registrationState` contains `"fail"`, the app posts:

1. `ERROR` with `code: "SIP_REGISTER_FAILED"`
2. `WS_RECONNECT` with `payload.state = sip.registrationState`

This is **not** a WebSocket reconnect event. It mirrors SIP registration failure.
Do not treat `WS_RECONNECT: failed` as proof of WSS transport failure.

### `SESSION_START` payload is minimal

Stored fields on `VoiceClientSession`: `platform`, `appVersion`, `iceHasTurn`.
**No client IP, no sipUsername, no WS close code.** Forensics cannot correlate
source IP or carrier from server-side diag alone.

---

## Incident forensics: Relax Tires T25 / ext 101 / `T25_101_1` (2026-05-29)

### Entity IDs

| Entity | ID |
|--------|-----|
| Tenant Relax Tires | `cmnlgryme000up9paz1w40fg0` |
| User (`relaxtires@gmail.com`) | `cmnmjhlu3004xp96hv4g49htg` |
| Extension 101 | `cmnmd7orq003tp9b023qj90vs` |
| PbxExtensionLink | `cmnmd7orv003vp9b0q1xx79bc` |
| Failing session | `cmpr0lj8200c6mn13jzcqi1r5` |
| CAB success session | `cmpr36uxo02grmn130l9jsa8e` |
| Device (primary) | `cmow9iw3802s4n94c1ioyjenq` (Samsung SM-S938U) |
| Device (QR reprovision) | `cmpen5jyc011smt139s7c8hqp` (Samsung SM-S921U) |

### 1. Provisioning diff audit

**Current bundle (Relax Tires 101):**

```json
{
  "sipUsername": "101_1",
  "authUsername": "T25_101_1",
  "sipWsUrl": "wss://m.connectcomunications.com:8089/ws",
  "sipDomain": "m.connectcomunications.com",
  "outboundProxy": null,
  "webrtcEnabled": true,
  "webrtcRouteViaSbc": false,
  "dtmfMode": "RFC2833"
}
```

**Control (Create A Box 102 — registered 2026-05-29 15:38 UTC):**

```json
{
  "sipUsername": "102_1",
  "authUsername": "T7_102_1",
  "sipWsUrl": "wss://m.connectcomunications.com:8089/ws",
  "sipDomain": "m.connectcomunications.com",
  "outboundProxy": null,
  "webrtcEnabled": true,
  "webrtcRouteViaSbc": false,
  "dtmfMode": "RFC2833"
}
```

**Field-by-field:** Only extension-specific identity fields differ (`sipUsername`,
`authUsername`, JsSIP URI). All transport/route/SBC/WebRTC flags match.

**Working comparison (T30_102_1):** Same structural pattern as T25 (`102_1` /
`T30_102_1`). T30 had live PJSIP contact during incident; T25 had none.

### 2. Tenant sync audit (2026-05-27 19:13 → 2026-05-29 14:26 UTC)

| Check | Result |
|-------|--------|
| `auditLog` for T25 tenant / user / extension / link | **Zero rows** before `MOBILE_DEVICE_REGISTERED` at 14:25:59 |
| `auditLog` for `PbxExtensionLink` id | **Only** `USER_PHONE_SYNC_OK` at 17:04:46 (after failures) |
| `MobileProvisioningToken` T25 | **None** until QR at 17:04:09 |
| `PbxJob` | No jobs in window |
| `syncExtensionsFromPbx` / warm sync | No audit evidence for T25 in window |
| API deploy | 14:15 UTC — **after** first failure at 14:26 |
| Telephony deploy | 16:40 UTC — after failure |

**Proof:** No Connect-side sync, import, repair, onboarding, or provisioning process
touched T25 / ext 101 / `T25_101_1` between last good registration and first failure.

### 3. Credential audit

| Field | T25_101_1 | T30_102_1 | T7_102_1 (CAB) |
|-------|-----------|-----------|----------------|
| Endpoint name | `T25_101_1` | `T30_102_1` | `T7_102_1` |
| `pbxSipUsername` | `101_1` | `102_1` | `102_1` |
| `pbxExtensionId` | `132` | `153` | `24` |
| `pbxDeviceId` | `195` | `208` | (from link) |
| Password length | 25 | 25 | 25 |
| `sipPasswordEncrypted` changed | **No** until 17:04:46 | — | `updatedAt` 2026-05-28 |
| Asterisk auth object | `authT25_101_1` (expected) | `authT30_102_1` | `authT7_102_1` |

Decrypted T25 password matches stored `sipPasswordEncrypted` (AES-GCM envelope via
`CREDENTIALS_MASTER_KEY`). **No password rotation** in the incident window —
`PbxExtensionLink.updatedAt` was 2026-04-05 until post-QR sync.

`issueOneTimeProvisioningForUser()` updates `sipPasswordIssuedAt` **without**
changing the encrypted secret — explains 17:04 timestamp after QR despite same password.

### 4. Provisioning payload audit (structured diff)

| Field | T25 ext 101 | CAB ext 102 | Notes |
|-------|-------------|-------------|-------|
| `sipUsername` | `101_1` | `102_1` | URI user |
| `authUsername` | `T25_101_1` | `T7_102_1` | Digest user |
| `sipDomain` | `m.connectcomunications.com` | same | |
| `sipWsUrl` | `wss://m.connectcomunications.com:8089/ws` | same | |
| `outboundProxy` | null | null | |
| `transport` | WSS (JsSIP WebSocket) | same | |
| `webrtcRouteViaSbc` | false | false | |
| `iceServers` | env HMAC TURN + STUN | same path | |
| `dtmfMode` | RFC2833 | RFC2833 | |

### 5. Mobile registration path audit

Traced code — **no T25-specific transformation:**

1. `issueOneTimeProvisioningForUser()` — generic owner-extension lookup
2. `buildVoiceProvisioningBundle()` — tenant WebRTC fields only
3. QR → `saveProvisioning()` → `clientRef.current.configure(bundle)` → `register({ forceRestart: true })`
4. JsSIP `authorization_user` = `pbxDeviceName`

May 29 14:25 session used **cached SecureStore** bundle (no server round-trip).
May 29 17:04 QR session used **fresh** server bundle — **both failed**.

### 6. Sync SIP audit

| Timestamp | Action | Fields changed |
|-----------|--------|----------------|
| 2026-05-01 16:29:19 | `USER_PHONE_SYNC_OK` | (historical) |
| 2026-05-08 01:52:48 | `USER_PHONE_SYNC_OK` | (historical) |
| **2026-05-29 17:04:46** | `USER_PHONE_SYNC_OK` | `PbxExtensionLink.updatedAt`, `sipPasswordIssuedAt`, `lastProvisionedAt`, `Extension.updatedAt` |

**No Sync SIP action** between May 27 19:13 and May 29 14:26.

`syncExtensionsFromPbx` (`apps/api/src/pbxExtensionSync.ts`) can refresh
`sipPasswordEncrypted` from VitalPBX — but only ran at 17:04, **after** 53 failures.

### 7. Failure isolation analysis

| Category | Verdict | Confidence |
|----------|---------|------------|
| A) Tenant configuration | **Ruled out** | 95% |
| B) Extension configuration | **Ruled out** | 95% |
| C) Provisioning generation | **Ruled out** | 95% |
| D) Credential generation | **Ruled out** (incident window) | 95% |
| E) PBX endpoint state | **Unlikely** — endpoint + WSS transport exist; no change evidence | 15% disproved / 85% unproven |
| F) Mobile app | **Unlikely** — generic code; CAB same app version works | 90% ruled out |
| G) Network / client path | **Most likely** — failure before SIP reaches Asterisk | 85% |

**AMI evidence:** 90 s listen windows — zero `ContactStatus` / auth challenge for
`T25_101_1`. `pjsip show contacts` — no `T25_*` entries. `T30_102_1` contact Avail
(~227 ms RTT). WSS probe from connect server: TLS OK, `101 Switching Protocols`.

**Multi-tenant impact (2026-05-29):** 53 `SIP_REGISTER_FAILED` events — **100% Relax
Tires**. No other tenant failed registration that day.

---

## Evidence table (chronological)

| UTC | Event | Significance |
|-----|-------|--------------|
| 2026-05-27 19:12:57 | Last answered call to ext 101 | Device working |
| 2026-05-27 19:13:25 | `CALL_ENDED`, `lastRegState: REGISTERED` | Last known good |
| 2026-05-29 14:25:59 | `SESSION_START` + `MOBILE_DEVICE_REGISTERED` | App opened after 43 h idle |
| 2026-05-29 14:26:14 | First `SIP_REGISTER_FAILED` | 14.5 s after session start |
| 2026-05-29 15:38:34 | CAB `SESSION_START` | Control tenant |
| 2026-05-29 15:38:36 | CAB `SIP_REGISTERED` | Same WSS infra works |
| 2026-05-29 17:04:09 | `extension_pairing_qr_generated` | Post-failure reprovision attempt |
| 2026-05-29 17:04:46 | `USER_PHONE_SYNC_OK` | Only DB mutation of link in incident day |
| 2026-05-29 (all day) | 53× `SIP_REGISTER_FAILED` | Relax Tires only |

---

## Root cause summary

**Exact transition:** First failed re-registration at **2026-05-29 14:26:14 UTC** after
~43 hours without an app session (registration expiry / cold start).

**Exact objects changed before failure:** **None** in Connect DB or audit trail.

**Exact objects unchanged:** Tenant WebRTC config, `PbxExtensionLink` credentials and
identity fields, extension assignment, provisioning code path, mobile app version.

**Most probable cause:** Client-side WSS/SIP registration attempt for Relax Tires does
not complete to the point Asterisk receives REGISTER. This is **not** explained by
Connect provisioning drift. Remaining hypotheses require client IP, WebSocket close
codes, or PBX-side REGISTER logging — **blocked** by current diag payload and
`pbx_audit@` shell restrictions.

---

## Hardening recommendations (not yet implemented)

### Diagnostics

1. **Expand `SIP_REGISTER_FAILED` payload** — include JsSIP `response.status_code`,
   `cause`, WebSocket `close code` / `reason`, and `sipWsUrl` host reached.
2. **Fix `WS_RECONNECT` mislabel** — rename to `SIP_REGISTRATION_STATE` or only emit
   on actual `transport` disconnect events.
3. **Capture client IP** on diag ingest (`SESSION_START`, registration events) via
   `req.ip` / `X-Forwarded-For`.
4. **Store provisioning fingerprint** on `VoiceClientSession` (`authUsername`,
   `sipWsUrl` hash) — not the password.

### Operations

5. **PBX REGISTER logging** — temporary `pjsip set logger on` filtered to
   `T25_101_1` during repro (requires elevated SSH, not `pbx_audit@`).
6. **Fail2ban / firewall audit** — check if Relax Tires user source IP is banned
   (cannot verify without client IP).
7. **Registration timeline API** — admin view: last REGISTER time from AMI contact vs
   last mobile `SIP_REGISTERED` diag event.

### Data model

8. Add `Tenant.updatedAt` or `webrtcConfigVersion` for future drift audits.
9. **`PbxExtensionLink` history table** — snapshot on sync / password change with
   before/after fields for Sync SIP forensics.

### Testing

10. **Synthetic mobile registration probe** — worker or cron from known IP registers
    as a test endpoint and alerts on failure (independent of user device).

---

## Diagnostic scripts (server-side, `_tmp_diag/`)

Reusable Prisma scripts (run inside `app-api-1` container):

| Script | Purpose |
|--------|---------|
| `provisioning_audit.js` | Bundle diff T25 vs CAB; audit window |
| `credential_decrypt.js` | Decrypt `sipPasswordEncrypted` for T25/T30/CAB |
| `cabox_ext.js` | Create A Box control session + link timestamps |
| `ami_compare_endpoints.js` | AMI GetConfig transport for T25 vs working endpoint |
| `deep_dive_may29.js` | VoiceDiag timeline for May 29 |

AMI from API container uses `PBX_HOST` / `AMI_USERNAME` / `AMI_PASSWORD` env vars.

---

## Related files

| Area | Path |
|------|------|
| **Live repro runbook** | `docs/ai-context/WEBRTC_LIVE_REPRO_RUNBOOK.md` |
| Provisioning API | `apps/api/src/server.ts` (`issueOneTimeProvisioningForUser`, `buildVoiceProvisioningBundle`) |
| Sync SIP | `apps/api/src/userExtensionProvisioning.ts`, `apps/api/src/pbxExtensionSync.ts` |
| Mobile JsSIP | `apps/mobile/src/sip/jssip.ts` |
| Mobile SIP context | `apps/mobile/src/context/SipContext.tsx` |
| Diag posting | `apps/mobile/src/context/NotificationsContext.tsx` |
| Credential crypto | `packages/security/src/index.ts` (`decryptJson`) |
| Incident summary in telephony doc | `docs/ai-context/TELEPHONY.md` § Relax Tires incident |
