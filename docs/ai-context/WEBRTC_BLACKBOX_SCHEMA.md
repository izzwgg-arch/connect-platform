# WebRTC black-box recorder — schema v2

> Companion to `WEBRTC_DIAGNOSTICS.md`. Clients POST to `POST /voice/diag/webrtc-sdp-debug`.
> Server persists `VoiceDiagEvent.payload.kind = WEBRTC_CALL_DEBUG` and logs
> `WEBRTC_CALL_DEBUG {compact json}` for `docker logs app-api-1 | grep WEBRTC_CALL_DEBUG`.

## Versions

| Field | Value |
|-------|-------|
| `schemaVersion` | **2** |
| `payloadVersion` | **2** |
| Max JSON bytes | 48_000 (`truncated: true` when trimmed) |
| Max SDP chars | 16_000 (redacted) |

## `debugKind` values

| Kind | When |
|------|------|
| `WEBRTC_SDP_REJECT` | Outbound 488/606 / `Incompatible SDP` |
| `WEBRTC_OUTBOUND_FAIL` | Other outbound failures |
| `WEBRTC_INBOUND_ANSWER_FAIL` | Answer tapped but SIP never confirmed |
| `WEBRTC_OUTBOUND_SUMMARY` | Sampled healthy outbound (debug mode) |
| `WEBRTC_INBOUND_SUMMARY` | Sampled healthy inbound (debug mode) |

## Outbound failure payload (WEB / MOBILE)

| Block | Fields |
|-------|--------|
| Identity | `correlationId`, `callAttemptId`, `identity.tenantId`, `identity.userId`, `identity.extensionId`, `identity.sipUsername`, `identity.authUsername` |
| Client | `platform` (`WEB`/`MOBILE`), `client.userAgent` (WEB), `client.appVersion`, `client.deviceModel`, `client.commitHash` |
| Target | `target.raw`, `target.normalized`, `sipTarget` |
| Registration | `registration.registrationState`, `registration.registrationAgeMs`, `registration.wssConnected`, `registration.uaStarted` |
| Media | `media.permissionGranted`, `media.constraints`, `media.inputDeviceLabelHash`, `media.inputDeviceIdHash` |
| Dial | `dial.uaCallInvoked`, `dial.sessionReturned`, `dial.sessionId`, `dial.jssipCallId`, `dial.dialedNumber` |
| Peer connection | `peerConnection.snapshot.*` (signaling/ICE/connection states), `peerConnection.offerSdpRedacted`, `peerConnection.offerSummary.*`, `peerConnection.offerCompatibilityIssues[]` |
| SDP summary | `audioMLine`, `profiles`, `payloadTypes`, `audioCodecs`, `fmtpLines`, `extmapLines`, `extmapCount`, `hasRtcpMux`, `hasBundle`, `dtlsSetup`, `hasDtlsFingerprint`, `hasIceLite`, `candidateCount`, `candidateTypes[]` (types only, IPs redacted) |
| SIP failure | `sipFailure.sipStatusCode`, `sipFailure.sipReasonPhrase`, `sipFailure.failedCause`, `sipFailure.failedOriginator`, `sipFailure.sipRejectionSource`, `sipFailure.rawEventSummary` |
| Timeline | `timeline[]` — `{ stage, tsMs, detail? }` per stage (`dial_start`, `ua_call_invoked`, `peerconnection_created`, `failed`, …) |
| PBX hint | `pbxHint.endpointName`, `pbxHint.tenantId`, `pbxHint.extension`, `pbxHint.pbxCallId`, `pbxHint.channelNotCreated`, `pbxHint.cdrLookupHint` |
| Outcome | `durationUntilFailureMs`, `diagnosisCategory` |

### Outbound `diagnosisCategory`

`OUTBOUND_MEDIA_SDP_REJECTED` | `OUTBOUND_AUTH_FAILED` | `OUTBOUND_NOT_REGISTERED` | `OUTBOUND_PERMISSION_DENIED` | `OUTBOUND_WEBRTC_FAILED` | `OUTBOUND_UNAVAILABLE` | `OUTBOUND_TRUNK_FAILED` | `OUTBOUND_FAILED_OTHER`

## Inbound failure payload (WEB / MOBILE)

| Block | Fields |
|-------|--------|
| Correlation | `correlationId`, `callAttemptId`, `inviteId`, `pbxCallId` |
| Parties | `callerNumber`, `calleeExtension` |
| Push / UI | `pushMeta.pushReceivedAt`, `pushMeta.answerTappedAt`, `pushMeta.pushToAnswerMs`, `uiState.*`, `incoming_screen_shown` timeline stage |
| Registration | `registration.*` before answer |
| Force restart | `forceRestart.decided`, `forceRestart.reason` |
| Sessions | `incomingSessionSnapshot.sessionCount`, `sessionIds[]`, `jssipCallIds[]`, `candidates[]` |
| Backend | `backendAccept.requestedAt`, `backendAccept.responseCode`, `backendAccept.responseBodySummary` |
| SIP answer | `sipAnswer.attempted`, `sipAnswer.sent`, `sipAnswer.confirmed`, `sipAnswer.endedBeforeConfirmed` |
| Flags | `sessionNotFoundTimeout`, `endedBeforeConfirmed` |
| Timeline | `answer_tapped`, `SIP_INVITE_FOUND`, `SIP_ANSWER_INVOKED`, `backend_accept_requested`, … |
| Outcome | `durationUntilFailureMs`, `diagnosisCategory` |

### Inbound `diagnosisCategory`

`INBOUND_SESSION_NOT_FOUND_TIMEOUT` | `INBOUND_INVITE_NOT_RECEIVED` | `INBOUND_SIP_ANSWER_FAILED` | `INBOUND_BACKEND_CLAIM_FAILED` | `INBOUND_MAX_ATTEMPTS` | `INBOUND_FAILED_OTHER`

## Redaction (always applied server-side)

- SIP passwords, JWT/session tokens, `Authorization` headers
- ICE `ufrag` / `pwd` in SDP and object keys (`icePwd`, `ice-ufrag`, …)
- Private/local host ICE candidates (masked IPs)
- Full device IDs → `hashStableId()` only on client

## Alert specs (`packages/shared/src/webrtcBlackbox.ts`)

| Alert kind | Window | Threshold |
|------------|--------|-----------|
| `webrtc_outbound_488_spike` | 15 min | 2 |
| `webrtc_outbound_fail_cluster` | **5 min** | **3 per tenant** |
| `outbound_no_pbx_channel` | 30 min | 1 |
| `inbound_claimed_no_sip_connect` | 30 min | 1 |
| `session_not_found_timeout_spike` | 15 min | 2 |
| `webrtc_outbound_drought` | 30 min | N attempts, 0 success |
| `webrtc_diag_ingest_failure` | 60 min | 1 |
| `webrtc_contact_registration_loss` | 60 min | 1 |

## Admin dashboard notifications

When triggers fire, the API upserts `WebrtcCallingIncident` rows and shows a **dismissible banner** on `/admin` (and Incident Center) for users with `can_view_admin`. **SUPER_ADMIN** sees all tenants; **TENANT_ADMIN** sees own tenant only.

| Trigger | Window | Threshold | Severity |
|---------|--------|-----------|----------|
| Outbound fail cluster | 5 min | 3 failures | critical |
| SDP 488 / Incompatible SDP | 15 min | ≥2 critical; 1 warning | critical / warning |
| Inbound answer fail cluster | 5 min | 2 failures | critical |
| Outbound drought | 30 min | ≥5 failures, 0 successes | critical |
| Success rate low | 15 min | ≥5 attempts, &lt;20% or &lt;50% success | critical / warning |
| Diag ingest failure | 60 min bucket | parse/persist errors | warning |

- **Dedupe:** `webrtc:{tenantId}:{failureType}:{5minBucket}`
- **Dismiss:** `POST /admin/webrtc-incidents/:id/dismiss` (per-user, 30 min cooldown)
- **List:** `GET /admin/webrtc-incidents/active`

## Code map

| Layer | Path |
|-------|------|
| Schema / redaction / SDP | `packages/shared/src/webrtcBlackbox.ts` |
| JsSIP extraction | `packages/shared/src/webrtcCallDiagnostics.ts` |
| API ingest | `apps/api/src/voice/webrtcCallDiagnostics.ts`, `server.ts` `/voice/diag/webrtc-sdp-debug` |
| Portal recorder | `apps/portal/lib/webrtcBlackboxRecorder.ts`, `hooks/useSipPhone.ts` |
| Mobile recorder | `apps/mobile/src/sip/webrtcBlackboxRecorder.ts`, `jssip.ts`, `NotificationsContext.tsx` |

## Forensics queries

```sql
-- Recent black-box events
SELECT id, "createdAt", payload->>'debugKind' AS kind,
       payload->>'diagnosisCategory' AS diagnosis,
       payload->>'callAttemptId' AS attempt
FROM "VoiceDiagEvent"
WHERE payload->>'kind' = 'WEBRTC_CALL_DEBUG'
ORDER BY "createdAt" DESC LIMIT 20;
```

```bash
docker logs app-api-1 2>&1 | grep WEBRTC_CALL_DEBUG | tail -20
```
