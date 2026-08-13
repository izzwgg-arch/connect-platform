# WebRTC / SIP Release Gate & Rollback

> **Scope:** any deploy that touches WebRTC, SIP, softphone media, the voice
> provisioning bundle, TURN/ICE config, SDP handling, or PJSIP WebRTC endpoint
> config. If your change touches any of the files in **§ Trigger paths**, this
> gate is **mandatory before publish**. Created after the 2026-06-03/04
> outbound **488 / Incompatible SDP** outage (see `WEBRTC_DIAGNOSTICS.md`).

## Why this exists

The outbound WebRTC failure shipped silently: hard-phone calls worked, inbound
worked, registration worked — only **outbound WebRTC** SDP negotiation broke,
and the fast 488 reject produced **no server telemetry** (sub-1s failures were
dropped by the call-quality report). A green deploy + a working dial-tone is
**not** proof that calling works.

## Trigger paths (changing any of these requires the gate)

- `apps/portal/hooks/useSipPhone.ts`, `apps/portal/hooks/useTelephonyAudio.ts`
- `apps/portal/lib/webrtcSdpDiagnostics.ts`
- `apps/mobile/src/sip/**` (jssip config, media constraints, `mobileOutboundDial.ts`)
- shared voice provisioning bundle (`apps/api/src/voiceProvisioningBundle.ts`,
  `resolveWebrtcConfig` in `apps/api/src/server.ts`)
- TURN/ICE server config / env (`buildEnvIceServers`, `NEXT_PUBLIC_FORCE_ICE_RELAY`)
- PJSIP WebRTC endpoint config on the PBX (`allow`, `media_encryption`,
  `rtcp_mux`, transport)

## Pre-publish smoke check (manual, ~3 min)

Run against a **staging/test extension**, not a customer mid-call.

1. **Register:** portal softphone reaches `registered` (WSS `:8089`).
2. **Outbound reaches Asterisk:** place one outbound call. Confirm in the
   telephony AMI stream / `pjsip set logger on` that an **INVITE arrives**, a
   **`Newchannel`** is created, the **dialplan/route** is reached, and a
   **trunk leg** is created. Console must show **no** `[WEBRTC_SDP_REJECT]` and
   **no** `488 / Incompatible SDP`.
3. **Inbound answers:** place one inbound call to the extension and answer it —
   confirm two-way audio (`SIP_CONNECTED` / receiving bytes growing).
4. **Diagnostics sane:** Console shows `[WEBRTC_SDP] local offer summary` with
   `compatibilityIssues: []`, profile `UDP/TLS/RTP/SAVPF`, codecs including
   `opus` + `PCMU`/`PCMA`, `dtls:true`, `rtcpMux:true`.

If **any** step fails → **do not publish**. Capture the offer SDP per
`WEBRTC_DIAGNOSTICS.md` § 4 / § 4b and treat it as STOP-THE-LINE.

## Automated guard (CI / pre-flight)

- `apps/portal/lib/webrtcSdpDiagnostics.test.ts` (in the portal `test` script)
  pins: SDP-reject = SIP **488/606**, the expected offer shape, and that
  `checkOfferCompatibility()` rejects offers missing DTLS / opus / SAVPF /
  rtcp-mux. Keep these green; a failure here means the offer contract changed.

## Known-good reference (as of 2026-06-04)

- **PBX WebRTC endpoint** (`T25_101_1`, byte-identical to known-good
  `T30_102_1`): `allow=!all,ulaw,alaw,gsm,g729,opus,vp8,vp9,h264,h263p,h263`,
  DTLS media encryption, `rtcp_mux=yes`, WSS transport.
- **Portal offer** (browser default): `m=audio … UDP/TLS/RTP/SAVPF` with opus +
  PCMU/PCMA + telephone-event, DTLS-SRTP, rtcp-mux, BUNDLE.
- **Mobile "fix" `5a63561b`** (relaxed audio constraints) is **undeployed and
  unverified** — do **not** treat it as the known-good cause.

## Rollback procedure

1. **Portal:** blue/green rollback per
   `docs/ai-context/DEPLOYMENT_PORTAL_ROLLBACK.md` — flip the nginx portal
   upstream back to the previous healthy container (`:3000`/`:3005`). No DB
   change is involved for softphone-only changes.
2. **API (provisioning bundle / ICE):** re-enqueue the prior known-good commit
   via the deploy queue (`service: "api"`, pin `commitHash`). Blue/green only
   (`DEPLOY_API_BLUEGREEN=1`).
3. **PBX endpoint config:** revert only the specific endpoint/transport line
   that changed; never bulk-rewrite. Re-run the smoke check.
4. After rollback, confirm the smoke check (above) passes on the restored build
   before closing the incident.

## Deploy rule

A WebRTC/SIP deploy job ending `status:"success"` is **not** sufficient. You
must additionally confirm a real outbound + inbound call per the smoke check,
and (per `AGENTS.md`) verify the shipped SHA in the running container.
