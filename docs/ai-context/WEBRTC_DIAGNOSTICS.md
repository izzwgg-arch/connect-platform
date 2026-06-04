# WebRTC / Mobile SIP Diagnostics

> Companion to `TELEPHONY.md`. Read `CURSOR_START_HERE.md` first.
> This doc captures **mobile softphone registration diagnostics**, incident forensics,
> and hardening recommendations.
>
> **Live repro (read-only):** When prior forensics cannot prove where traffic stops,
> use **`WEBRTC_LIVE_REPRO_RUNBOOK.md`** — controlled capture with elevated PBX access,
> phone browser `:8089` test, fail2ban/firewall checks, and Case A–F decision matrix.

---

## Incident: Full WebRTC calling outage — inbound + outbound (2026-06-02/04)

> **Status: PARTIALLY PROVEN (2026-06-04 extended forensics pass).**
> **Failure mechanisms** for outbound 488 and inbound `session_not_found_timeout` are proven
> with DB/CDR/code correlation. **Exact rejected SDP attribute** and **recovery trigger** remain
> **BLOCKED** (no PBX SIP trace; 6.5 h call-attempt gap before recovery). New instrumentation
> ships in this pass to capture missing proof on next occurrence. See **§13 Evidence table**,
> **§14 Root cause**, **§15 Prevention / instrumentation**.

### 1. What is proven vs blocked

> **Instrumentation (2026-06-04):** Black-box recorder **schema v2** ships in API + portal +
> mobile (pending EAS build). See **`WEBRTC_BLACKBOX_SCHEMA.md`** for full field list,
> redaction rules, alert specs, and `grep WEBRTC_CALL_DEBUG` forensics. **Admin dashboard
> notifications:** dismissible banner on `/admin` when incident thresholds fire — see
> `WEBRTC_BLACKBOX_SCHEMA.md` § Admin dashboard notifications.

| Question | Status |
|----------|--------|
| WebRTC outbound failed with `Incompatible SDP` | **PROVEN** (DB) |
| 488 source is Asterisk/upstream SIP (not browser self-reject) | **PROVEN** (JsSIP semantics + cause; see §13) |
| Outbound failure had **no** `PJSIP/T*_ext_1` in CDR at fail timestamps | **PROVEN** (CDR ±30 s queries) |
| Outbound recovery created `PJSIP/T2_103_1` channel | **PROVEN** (`1780569827.58271`) |
| Inbound: PBX created `PJSIP/T*_ext_1` while mobile never got JsSIP INVITE | **PROVEN** (CDR + flight; see §13) |
| Inbound `session_not_found_timeout` emitted by mobile `answerIncoming()` poll exhaust | **PROVEN** (code + 8612 ms ≈ `MOBILE_SIP_ANSWER_INITIAL_WAIT_MS`) |
| Exact rejected SDP attribute / Asterisk log line | **BLOCKED** (0 `WEBRTC_SDP_DEBUG` rows; no PBX `full` log) |
| Recovery trigger at ~10:44 UTC | **BLOCKED** (0 VoiceDiag/CallFlight rows 04:00–10:44; reload at 10:46 **after** recovery) |
| Asterisk full restart in window | **DISPROVEN** (`CoreStartupDate: 2025-05-12`, AMI) |
| App deploy caused onset or recovery | **DISPROVEN** (timestamps vs deploy jobs) |
| Static endpoint config / codec modules caused 488 | **DISPROVEN** (§9–§11) |

### 2. Combined timeline (UTC, proof-level from DB)

| UTC | Event | Evidence |
|-----|-------|----------|
| **2026-06-02 19:51:48** | Last known good **portal outbound** | `VoiceDiagEvent` WEB outbound 233 s, `endReason: normal` |
| **2026-06-02 21:01–21:43** | Last known good **mobile inbound** | `CallFlightSession` ext 101: full `SIP_ANSWER_SENT → SIP_CONNECTED → PBX_CALL_ANSWERED` |
| **2026-06-03 15:38:40** | First known **mobile inbound** failure | `cfs_mpy8e90o_w4jcs` ext 101: `SIP_ANSWER_FAILED` / `session_not_found_timeout` |
| **2026-06-03 15:58:17** | Mobile inbound fail ext 102 | `cfs_mpy93h0e_plt6v` — same pattern |
| **2026-06-03 18:23:47** | First known **mobile outbound** failure | `cfs_mpyealjz_45pq8`: `OUTBOUND_MEDIA_SDP_REJECTED`, Incompatible SDP |
| **2026-06-03 18:25–18:33** | Mobile inbound `INVITE_CLAIMED` drops | `cfs_mpyedf6m_as7rm`, `cfs_mpyem66j_sfw8n` — answer tapped, no SIP answer |
| **2026-06-04 01:08:57** | First known **portal outbound** failure | `VoiceDiagEvent` `endReason: Incompatible SDP`, 1.2 s |
| **2026-06-04 02:54:15** | Mobile inbound fail ext 102 | `cfs_mpywj2dq_73oi0` — `session_not_found_timeout` |
| **2026-06-04 04:00:18** | Last known **portal outbound** failure | `VoiceDiagEvent` Incompatible SDP, 1.5 s |
| **2026-06-04 04:23–05:17** | Diagnostics-only deploys (portal `c2aa5ae5`, api/portal `2fffba59`) | Deploy queue — **no media fix** |
| **2026-06-04 10:44:36** | **Recovery** — portal outbound 53 s | `VoiceDiagEvent` `endReason: user_hangup` |
| **2026-06-04 10:46:04** | Recovery — mobile outbound | `cfs_mpzddtvd_4s3nl` `OUTBOUND_CONNECTED` |
| **2026-06-04 10:46:53** | Recovery — portal inbound 2.8 s | `VoiceDiagEvent` WEB inbound `user_hangup` |

**Onset order:** inbound mobile (15:38) → mobile outbound (18:23) → portal outbound (01:08
Jun 4). ~22 h gap between last good portal outbound and first portal failure.

Forensic script: `_latency_logs/webrtc_full_outage_forensics.js`. Inbound detail dump:
`_latency_logs/dump_inbound_failures.js`.

### 3. Client-visible failure evidence (DB only)

| Direction | Source | Proven terminal state |
|-----------|--------|------------------------|
| Portal outbound | `VoiceDiagEvent` `type=CALL_QUALITY_REPORT` | `endReason: "Incompatible SDP"` (10 rows); last at `2026-06-04T04:00:18.596Z` |
| Portal outbound recovery | same | `endReason: "user_hangup"`, `durationMs: 53447` at `2026-06-04T10:44:36.598Z` |
| Mobile outbound | `CallFlightSession` | `OUTBOUND_FAILED` / `sdpReject: true`; flag `OUTBOUND_MEDIA_SDP_REJECTED` on `cfs_mpyt5zfz_5b4me` |
| Mobile outbound recovery | `CallFlightSession` `cfs_mpzddtvd_4s3nl` | stages include `OUTBOUND_CONNECTED` at `2026-06-04T10:46:04.921Z` |
| Mobile inbound fail A | `CallFlightSession` events | `SIP_ANSWER_FAILED` payload `{"reason":"session_not_found_timeout"}` (3 sessions) |
| Mobile inbound fail B | `CallFlightSession` events | `INVITE_CLAIMED` → `CALL_ENDED` without `SIP_ANSWER_SENT` (2 sessions) |
| Mobile inbound recovery | — | **No inbound success row in window before** portal inbound `VoiceDiagEvent` at `10:46:53` |
| Portal inbound in window | `VoiceDiagEvent` | 1 row total — post-recovery only |

**Inbound vs outbound signatures — PROVEN different in DB:**

| Field | Outbound rows | Inbound rows |
|-------|---------------|--------------|
| `endReason: Incompatible SDP` | 10 portal `VoiceDiagEvent` | 0 |
| `sdpReject: true` in flight | 3 mobile outbound sessions | 0 inbound sessions |
| `SIP_ANSWER_FAILED` / `session_not_found_timeout` | 0 | 3 |
| `INVITE_CLAIMED` without `SIP_ANSWER_SENT` | 0 | 2 |

Whether both share a single PBX root cause: **STILL_UNPROVEN** (requires PBX SIP logs).

**Outbound evidence tables:**

Portal `VoiceDiagEvent` (tenant T2 `cmnlgnumi…` unless noted):

| UTC | endReason | durationMs |
|-----|-----------|------------|
| 2026-06-04 01:08:57 | Incompatible SDP | 1172 |
| 2026-06-04 01:57–04:00 | Incompatible SDP (×9) | 1071–3275 |
| 2026-06-04 10:44:36 | user_hangup | 53447 ✅ |

Mobile `CallFlightSession` outbound (T25 `cmnlgryme…`):

| Session | UTC | result | flags |
|---------|-----|--------|-------|
| `cfs_mpyealjz_45pq8` | 2026-06-03 18:23:48 | failed | Incompatible SDP |
| `cfs_mpyrt0oc_0ozjw` | 2026-06-04 00:42:03 | failed | Incompatible SDP |
| `cfs_mpyt5zfz_5b4me` | 2026-06-04 01:20:07 | failed | `OUTBOUND_MEDIA_SDP_REJECTED` |
| `cfs_mpzddtvd_4s3nl` | 2026-06-04 10:46:04 | answered ✅ | `OUTBOUND_CONNECTED` |

**Inbound evidence (5 immediate-drop sessions):**

| Session | UTC | ext | tenant | terminal stage | reason |
|---------|-----|-----|--------|----------------|--------|
| `cfs_mpy8e90o_w4jcs` | 2026-06-03 15:38:40 | 101 | T25 | `SIP_ANSWER_FAILED` | `session_not_found_timeout` |
| `cfs_mpy93h0e_plt6v` | 2026-06-03 15:58:17 | 102 | T7 | `SIP_ANSWER_FAILED` | `session_not_found_timeout` |
| `cfs_mpyedf6m_as7rm` | 2026-06-03 18:25:59 | 101 | T25 | `CALL_ENDED` | after `INVITE_CLAIMED`, no SIP answer |
| `cfs_mpyem66j_sfw8n` | 2026-06-03 18:32:47 | 101 | T25 | `CALL_ENDED` | same |
| `cfs_mpywj2dq_73oi0` | 2026-06-04 02:54:15 | 102 | T7 | `SIP_ANSWER_FAILED` | `session_not_found_timeout` |

Linked `CallInvite` rows show `status: ACCEPTED` for several failures — backend accept path
ran even when SIP answer never completed.

### 3b. Recovery window facts (2026-06-04 04:00 → 10:44 UTC)

| UTC | Source | Evidence |
|-----|--------|----------|
| 04:00:18.596 | `VoiceDiagEvent` | Last failure: `endReason: Incompatible SDP` |
| 04:23:48 | Deploy job `61a61d1f` | portal dryRun `c2aa5ae5` |
| 04:40:56 | Deploy job `0ffaf736` | portal live `c2aa5ae5` (diagnostics only — file list has no provisioning) |
| 05:00:25 | `docker inspect app-api-1` | Container `StartedAt: 2026-06-04T05:00:25.499603601Z` |
| 05:02:34 | Deploy job `fc4030ec` | api live `2fffba59`; log: `[deploy-api] done 2fffba5` |
| 05:16:50 | `docker inspect app-portal-1` | Container `StartedAt: 2026-06-04T05:16:50.332404962Z` |
| 05:17:41 | Deploy job `358ae696` | portal live `2fffba59`; log: `[deploy-portal] done 2fffba5` |
| 05:00–10:44 | `VoiceDiagEvent` + `CallFlightSession` | **Zero WebRTC attempt rows** between last failure and recovery |
| 10:44:36.598 | `VoiceDiagEvent` | First recovery row: outbound `user_hangup` 53447 ms |
| — | `app-telephony-1` | `StartedAt: 2026-05-31T04:16:49Z` — **no restart** in recovery window |

**Recovery trigger:** **BLOCKED**. First success timestamp is proven; causal event is not.

### 4. Missing decisive artifact

We need **one client-side SDP offer from a failed outbound call**. This is the only piece
that proves whether the offer (client) or the answer/488 (Asterisk) is the problem.

- **Portal (preferred):** `chrome://webrtc-internals` — no PBX access required.
- **Mobile (fallback):** `adb logcat` SDP / JsSIP / PeerConnection logs.

> Why not the PBX wire trace? The `pbx_audit@209.145.60.79` account is a restricted shell:
> it allows no-argument `pjsip show endpoints` / `pjsip show contacts` only. `pjsip set
> logger`, per-endpoint `show`, log file reads, and AMI `Command` are all **denied**, so a
> server-side SIP/SDP trace requires elevated PBX SSH (out of scope here).

### 5. Portal capture steps (chrome://webrtc-internals)

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

### 5b. Portal in-app capture (instrumented 2026-06-04) — USE THIS, not webrtc-internals

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

### 6. Mobile capture steps (adb logcat)

1. Connect the phone via `adb`.
2. Run:
   ```bash
   adb logcat | grep -iE "jssip|sdp|peerconnection|m=audio|a=rtpmap|a=fmtp|dtls|ice"
   ```
3. Place **one** failed outbound call.
4. Save output as:
   `mobile-outbound-failed-<tenant>-<extension>-<timestamp>.log`

### 7. What to look for in the SDP

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

### 8. Stop-the-line rule

**No deploy, no APK, no PBX media changes** until the captured SDP proves the exact
mismatch. The failure is localized but the specific rejected attribute/codec/offer shape
is **not yet proven** — shipping a change now risks fixing the wrong layer.

### 9. Next action once SDP is captured

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

### 11. Codec runtime verification — hypothesis **DISPROVEN** (2026-06-04, live AMI)

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

> **Where that leaves root cause:** static config (§10) and codecs (§11) ruled out.
> Outbound = **488 pre-dialplan** (proven). Inbound = **answer/INVITE delivery** (proven
> signature, PBX hangup cause missing). Unified PBX runtime fault is **likely but blocked**.
> Classification: **C — HIGH-CONFIDENCE BUT BLOCKED** (failure mechanisms partially differ →
> not classification A). See §12.

### 12. Proof status (updated 2026-06-04)

**Classification: MECHANISMS_PROVEN — UNIFIED PBX ROOT CAUSE BLOCKED**

### 13. Evidence table (extended forensics pass)

| # | UTC / window | Source | Query / command / file | Conclusion |
|---|--------------|--------|------------------------|------------|
| E1 | 2026-06-04 01:08:57 | `VoiceDiagEvent` | `_latency_logs/query_portal_fail_payloads.js` | Portal outbound `endReason: Incompatible SDP`, 1172 ms; payload has **no** `sipStatusCode` (pre-instrumentation) |
| E2 | 2026-06-04 01:08:57 ±30 s | `ConnectCdr` | `_latency_logs/query_outbound_mobile_488.js` | **0** rows with `T2_103` — no PBX WebRTC leg persisted |
| E3 | 2026-06-03 18:23:48 | `CallFlightSession` `cfs_mpyealjz_45pq8` | `_latency_logs/query_outbound_mobile_488.js` | `OUTBOUND_INVITE_SENT` → `OUTBOUND_FAILED` 473 ms; `sipCause: Incompatible SDP`; **`sipCode: null`** (mobile read `e.response` not `e.message` — **capture bug**, fixed in this PR) |
| E4 | 2026-06-04 10:46:04 | `CallFlightSession` `cfs_mpzddtvd_4s3nl` | same | Recovery: `OUTBOUND_RINGING` sipCode **180** → `OUTBOUND_CONNECTED` — proves Asterisk accepted offer |
| E5 | — | JsSIP + `@connect/shared/webrtcCallDiagnostics` | `inferSipRejectionSource()` | Cause **`Incompatible SDP`** is JsSIP's mapping for remote **488/606** only → source **`asterisk_or_upstream`** when not `originator: local` |
| E6 | 2026-06-03 15:38:24 | `ConnectCdr` `1780501104.55724` | `_latency_logs/dump_inbound_failures.js` | PBX created **`PJSIP/T25_101_1-00007ba8`** |
| E7 | 2026-06-03 15:38:40 | `CallFlightSession` `cfs_mpy8e90o_w4jcs` | same | User answered **16 s after** E6; stages: `SIP_REGISTERED` → `SIP_ANSWER_START` → `SIP_ANSWER_FAILED` **`session_not_found_timeout`** at **8612 ms**; **no** `SIP_INVITE_RECEIVED` |
| E8 | — | `apps/mobile/src/sip/jssip.ts:1741–1748` | code | `session_not_found_timeout` when `answerIncoming()` poll exhausts deadline with **`attempt < 3`** and **`findIncoming()` never returned a session** |
| E9 | 2026-06-03 15:38:41 | `CallInvite` `cmpy8e4ta01cfo9130a5yh7a2` | DB | `status: ACCEPTED` — backend accept ran; SIP answer never completed |
| E10 | 2026-06-03 18:26:00 | `cfs_mpyedf6m_as7rm` | flight dump | `INVITE_CLAIMED` + 16 s extended wait → `CALL_ENDED` without `SIP_ANSWER_SENT` (requeue path; PBX still no usable INVITE at mobile) |
| E11 | 2026-06-03 18:32:40 | CDR `1780511560.56597` | `_latency_logs/query_portal_fail_payloads.js` | **3×** `PJSIP/T25_101_1` retries; `hangupCause: 26` |
| E12 | 2026-06-04 04:00–10:44 | `VoiceDiagEvent` + `CallFlightSession` | `_latency_logs/query_recovery_window.js` | **0** call attempts — cannot correlate recovery to registration/reload/deploy |
| E13 | 2026-06-04 10:44:36 | `VoiceDiagEvent` | recovery query | First success: portal outbound 53447 ms `user_hangup` |
| E14 | 2026-06-04 10:46:44 | AMI `CoreStatus` | `_latency_logs/ami_corestatus_only.js` | Asterisk reload **after** E13/E4 — **DISPROVEN** as recovery cause |

### 14. Root cause statements (evidence-backed only)

**Outbound (portal + mobile) — PROVEN mechanism, BLOCKED SDP attribute**

1. **What happened:** Client sent WebRTC outbound INVITE; call failed in **~0.5–3 s** with JsSIP cause **`Incompatible SDP`**; Connect CDR shows **no** `PJSIP/T{tenant}_{ext}_1` channel at failure time.
2. **Why:** Asterisk PJSIP rejected the client's SDP offer with SIP **488/606** before creating a persisted WebRTC channel. Proof chain: JsSIP cause semantics (E5) + sub-second fail + zero CDR `_1` leg (E1–E2) + recovery success with `_1` in CDR (E4). **Not** browser ICE-only failure (SIP layer failed first). **Exact rejected SDP field** still unknown (E1 — no offer captured).
3. **Prevention (this PR):** Fix mobile `sipCode` extraction; extend `POST /voice/diag/webrtc-sdp-debug` with `sipRejectionSource`, `peerConnectionSnapshot`, redacted offer; alert specs in §15.

**Inbound mobile — PROVEN mechanism**

1. **What happened:** PBX dialed WebRTC endpoint (`PJSIP/T*_ext_1` in CDR); user answered via push/UI; call ended without `SIP_CONNECTED`.
2. **Why:** Mobile JsSIP **`incomingSessions` never received a matching INVITE** during the answer window. `session_not_found_timeout` is **app-generated** when `answerIncoming()` exhausts **`MOBILE_SIP_ANSWER_INITIAL_WAIT_MS` (8000 ms)** without `findIncoming()` success (E7–E8). Example E7: PBX leg at **15:38:24**, answer at **15:38:40** — original INVITE likely **expired/CANCELled** before UA registered; no `SIP_INVITE_RECEIVED` flight stage. INVITE_CLAIMED path (E10) shows backend requeue also failed to deliver a bindable INVITE within extended wait.
3. **Prevention (this PR):** On `session_not_found_timeout`, post `WEBRTC_INBOUND_ANSWER_FAIL` with `incomingSessionSnapshot` (session counts, candidates, match, poll iterations) to API.

**Recovery — BLOCKED**

- **DISPROVEN:** deploy (05:17 finished), Asterisk reload (10:46), full restart.
- **PROVEN:** First post-gap success at **10:44:36** after **6 h 44 min** with zero call attempts (E12).
- **Missing evidence:** PBX contact/WSS registration history, NAT binding, scheduled job, or client re-register event in the gap. Next occurrence: compare `incomingSessionSnapshot` + `VoiceClientSession` heartbeats + AMI contact diff.

### 15. Prevention — instrumentation, alerts, runbook

#### Implemented (this PR — deploy required to activate)

| Layer | File | Captures |
|-------|------|----------|
| Shared | `packages/shared/src/webrtcCallDiagnostics.ts` | `extractJsSipFailureFields`, `inferSipRejectionSource`, `snapshotPeerConnection` |
| Portal | `apps/portal/hooks/useSipPhone.ts` | 488: originator, `sipRejectionSource`, PC ICE/DTLS state, redacted offer → API |
| Mobile | `apps/mobile/src/sip/jssip.ts` | Fix `message.status_code`; outbound SDP reject + inbound answer fail snapshots → API |
| API | `POST /voice/diag/webrtc-sdp-debug` | Persists `kind: WEBRTC_CALL_DEBUG` with `debugKind` |
| API | `apps/api/src/voice/webrtcCallDiagnostics.ts` | Zod schema + `webrtcAlertQuerySpec()` |
| Tests | `*.test.ts` in shared, api, mobile | Extraction + payload normalization |

#### Alert specs (wire in worker/cron — not auto-deployed)

| Alert | Window | Threshold | Detection |
|-------|--------|-----------|-----------|
| `webrtc_outbound_488_spike` | 15 min | ≥2 | `VoiceDiagEvent` `Incompatible SDP` or `WEBRTC_SDP_REJECT_*` |
| `outbound_no_pbx_channel` | 30 min | ≥1 | Outbound flight/`VoiceDiag` success without `ConnectCdr` `*_ext_1` ±60 s |
| `inbound_claimed_no_sip_connect` | 30 min | ≥1 | Flight: `INVITE_CLAIMED` without `SIP_CONNECTED` within 30 s |
| `session_not_found_timeout_spike` | 15 min | ≥2 | Flight: `SIP_ANSWER_FAILED` reason `session_not_found_timeout` |
| `webrtc_contact_registration_loss` | 60 min | ≥1 | `SIP_REGISTER_FAILED` / `WS_DISCONNECTED` spike per tenant vs 7d baseline |

Use `webrtcAlertQuerySpec(kind)` from `apps/api/src/voice/webrtcCallDiagnostics.ts`.

#### WebRTC outage investigation runbook (ordered)

1. Read **§13 evidence table** — confirm mechanism (outbound 488 vs inbound session timeout).
2. Run `_latency_logs/webrtc_full_outage_forensics.js` on `app-api-1` for timeline.
3. For outbound fails: query CDR ±30 s — expect **no** `T*_ext_1` if 488 pre-channel (E2).
4. For inbound fails: dump flights `_latency_logs/dump_inbound_failures.js` — check for **`SIP_INVITE_RECEIVED`** absence.
5. Tail API: `docker logs app-api-1 2>&1 | grep webrtc_call_debug` after deploy of this PR.
6. If still blocked on SDP attribute: portal `?webrtcDebug=1` + one repro call, or `WEBRTC_LIVE_REPRO_RUNBOOK.md`.
7. **Do not** ship media/PBX fixes until `offerSdpRedacted` + `offerCompatibilityIssues` captured from a live fail.

#### Self-healing (NOT implemented — insufficient evidence)

No automatic UA restart or PBX reload — recovery trigger unproven. Revisit only if `WEBRTC_INBOUND_ANSWER_FAIL` snapshots show **registered UA + zero sessions** while CDR proves simultaneous `_1` dial (would suggest WSS delivery bug).

---

### 12 (legacy). AMI / deploy blockers

**AMI evidence (2026-06-04 probe from `app-api-1`):**
```
CoreStartupDate: 2026-05-12
CoreStartupTime: 23:16:21
CoreReloadDate: 2026-06-04
CoreReloadTime: 06:46:44  → 10:46:44 UTC (America/New_York)
```

**DB counts:** `WEBRTC_SDP_DEBUG` / `WEBRTC_CALL_DEBUG` rows during incident: **0** (instrumentation deployed 05:17; no failures after).

**Blocked PBX commands** (require elevated SSH): `grep 488 /var/log/asterisk/full`, `pjsip set logger on`, per-endpoint history.

**Prior safeguard table (§12 old):** superseded by §15 implemented instrumentation + alert specs.

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

## Platform-wide WebRTC outage detection (2026-06-04)

> **Motivation:** The 2026-06-03/04 outage hit T2, T25, T7, portal, and mobile
> (inbound + outbound) before per-tenant alerts made the scope obvious. This layer
> correlates **cross-tenant** schema v2 diagnostics and open tenant incidents to
> surface **`GLOBAL_WEBRTC_OUTAGE`** before customer complaints.

### Triggers (rolling 15 minutes)

| Trigger | Threshold | Severity |
|---------|-----------|----------|
| Multi-tenant failures | 3+ tenants with failures **or** 3+ tenants with open `WebrtcCallingIncident` | critical |
| SDP failure cluster | 10+ `Incompatible SDP` / 488 / 606 (warning at 5+) | critical / warning |
| Inbound answer cluster | 10+ `WEBRTC_INBOUND_ANSWER_FAIL` (warning at 5+) | critical / warning |
| Success-rate collapse | &lt;25% critical, &lt;40% warning; min 10 attempts | critical / warning |
| Mixed-direction outage | 2+ outbound **and** 2+ inbound failures across 2+ tenants | critical |

Evaluation runs after each `POST /voice/diag/webrtc-sdp-debug` ingest (same hook as
per-tenant incidents). No new diagnostic types required — aggregates existing
`WEBRTC_CALL_DEBUG`, `WEBRTC_SDP_DEBUG`, and `WEBRTC_INBOUND_ANSWER_FAIL` payloads.

### Persistence

- **`WebrtcPlatformOutage`** — `createdAt`, `updatedAt`, `firstSeenAt`, `lastSeenAt`,
  `severity`, counts, affected tenants/users, sample diag ids, diagnosis summary.
- Dedupe fingerprint: `webrtc:platform:GLOBAL_WEBRTC_OUTAGE:{15minBucket}` — one open row
  per bucket; occurrence count increments on continued failures.

### Admin surfaces (super-admin only)

| Surface | Path / endpoint |
|---------|-----------------|
| Large dismissible banner | `/admin`, `/admin/incidents` — `WebrtcGlobalOutageBanner` |
| Platform health widget | `/admin` — `WebrtcPlatformHealthCard` |
| Active outage API | `GET /admin/webrtc-platform/outage/active` |
| Dismiss (per-admin) | `POST /admin/webrtc-platform/outage/:id/dismiss` |
| Health snapshot | `GET /admin/webrtc-platform/health` |
| Incident Center / Ops Center | Merged into `/admin/incidents` and `/admin/ops-center` |

**Dismiss behavior:** Hides banner for **that admin only**; does not delete the outage row.
Reopens automatically when `lastSeenAt` advances more than **30 minutes** after dismiss
(cooldown). Agents and tenant admins **never** see the global banner.

### Code

| Area | Path |
|------|------|
| Evaluator (pure) | `packages/shared/src/webrtcGlobalOutageAlerts.ts` |
| DB service | `packages/db/src/webrtcPlatformOutageService.ts` |
| Migration | `packages/db/prisma/migrations/20260604160000_webrtc_platform_outage/` |
| Portal banner | `apps/portal/components/admin/WebrtcGlobalOutageBanner.tsx` |
| Portal health card | `apps/portal/components/admin/WebrtcPlatformHealthCard.tsx` |

---

## Related files

| Area | Path |
|------|------|
| **Live repro runbook** | `docs/ai-context/WEBRTC_LIVE_REPRO_RUNBOOK.md` |
| **WebRTC call debug helpers** | `packages/shared/src/webrtcCallDiagnostics.ts`, `packages/shared/src/webrtcBlackbox.ts`, `apps/api/src/voice/webrtcCallDiagnostics.ts` |
| **Black-box schema doc** | `docs/ai-context/WEBRTC_BLACKBOX_SCHEMA.md` |
| Provisioning API | `apps/api/src/server.ts` (`issueOneTimeProvisioningForUser`, `buildVoiceProvisioningBundle`) |
| Sync SIP | `apps/api/src/userExtensionProvisioning.ts`, `apps/api/src/pbxExtensionSync.ts` |
| Mobile JsSIP | `apps/mobile/src/sip/jssip.ts` |
| Mobile SIP context | `apps/mobile/src/context/SipContext.tsx` |
| Diag posting | `apps/mobile/src/context/NotificationsContext.tsx` |
| Credential crypto | `packages/security/src/index.ts` (`decryptJson`) |
| Incident summary in telephony doc | `docs/ai-context/TELEPHONY.md` § Relax Tires incident |
