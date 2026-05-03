# Push-Wake Dialplan — Tenant T25 (Option 2)

> **Scope:** This dialplan change is scoped **only** to tenant `T25` (the
> Connect demo / pilot tenant). Other tenants are unaffected.

## What this does

Before VitalPBX `Dial()`s a target extension (e.g. `101`), it makes an HTTP
call to Connect at `POST /internal/pbx/wake-extension`. The Connect API:

1. Looks up the user that owns the extension.
2. Sends a high-priority FCM data push (`INCOMING_CALL_WAKE`) to every
   registered mobile device for that user.
3. Returns `{ ok: true, devicesNotified: N, elapsedMs: … }` in <500 ms.

The dialplan then `Wait(6)`s, giving the mobile app time to:

- Wake from killed / Doze / locked state (high-priority FCM bypasses Doze).
- Start the SIP keep-alive foreground service.
- Trigger `JsSIP.register({ forceRestart: true })`.
- Re-establish the WSS socket and complete `REGISTER` with the SBC.

After the wait, `Dial(PJSIP/<ext>)` runs as normal. The phone is now reachable
and the call rings. If anything breaks (no internet, no devices, etc.), the
dial falls through to voicemail like before.

Every step from PBX → backend → device → SIP REGISTER is logged to the
`CallWakeEvent` table in Connect, keyed by the call's `linkedid`. The
in-app **Diagnostics → Call Wake — Timeline** screen renders the full event
sequence.

## Why we need this

Mobile apps on Samsung One UI 6+ (S24, S25) are aggressively suspended
after ~30 seconds in the background. The native `SipKeepAliveService`
foreground service keeps the JS process alive *most* of the time, but
under memory pressure or with strict battery saver, the OS will still
kill our WebSocket. When the SIP REGISTER expires, the PBX sees no
peer for the extension and hangs up to voicemail in <2 seconds.

Push-Wake removes the dependency on a continuously-registered SIP peer.
The PBX always wakes the device on demand, then dials.

## Pre-requisites

- VitalPBX with Asterisk dialplan access (Custom Contexts).
- Outbound HTTPS from the PBX to `https://app.connectcomunications.com`.
  - If the PBX has no public egress, expose Connect at a private endpoint
    (e.g. via the VPC-internal load balancer) and point the dialplan there.
- The Connect API has `CDR_INGEST_SECRET` already set (existing telephony
  integration uses the same secret).
- `curl` installed on the PBX host (it always is on VitalPBX).

## Where to paste this

Paste in **PBX Admin → PBX Settings → Custom Contexts → New Context**.

Name the context `T25_push_wake_extension`. The macro `Macro(connect-push-wake)`
is reusable for any extension — call it from the inbound route's
*Custom Destination* before the Dial step, OR wrap the existing
`from-internal-custom` chain.

For the simplest install (T25 only): change the inbound route's
**Destination** to call the new context with the extension number as the
`exten` and let the macro do the rest.

## Dialplan snippet

```asterisk
; ──────────────────────────────────────────────────────────────────────────
; Connect Push-Wake (Option 2) — tenant T25 only
;
; Usage from another context:
;   exten => _X.,1,Macro(connect-push-wake,${EXTEN})
;   same  =>     n,Dial(PJSIP/${EXTEN}_1,30)
;   same  =>     n,Goto(sub-leave-vm,${EXTEN}_1,1)
;
; OR call the whole context as a destination:
;   ; Send extension 101 via the wake path.
;   ; The dialed number IS the target extension number.
;   exten => 101,1,Goto(T25_push_wake_extension,101,1)
;
; Globals (set in globals.conf or Custom Destinations -> globals):
;   CONNECT_API_BASE   = https://app.connectcomunications.com/api
;   CONNECT_CDR_SECRET = <same value as Connect API CDR_INGEST_SECRET env>
;   T25_VITAL_TENANT   = T25
; ──────────────────────────────────────────────────────────────────────────

[macro-connect-push-wake]
; ARG1 = target extension number (e.g. "101")
exten => s,1,NoOp(== Connect Push-Wake start ext=${ARG1} call=${LINKEDID} ==)
 same =>   n,Set(__CONNECT_WAKE_EXT=${ARG1})
 same =>   n,Set(__CONNECT_WAKE_PBXCALLID=${LINKEDID})
 same =>   n,Set(__CONNECT_WAKE_FROM=${IF($["${CALLERID(num)}" != ""]?${CALLERID(num)}:unknown)})
 same =>   n,Set(__CONNECT_WAKE_DISPLAY=${IF($["${CALLERID(name)}" != ""]?${CALLERID(name)}:${CALLERID(num)})})
 same =>   n,Set(__CONNECT_WAKE_PAYLOAD=\{\"pbxCallId\":\"${LINKEDID}\",\"pbxVitalTenantId\":\"${T25_VITAL_TENANT}\",\"extensionNumber\":\"${ARG1}\",\"fromNumber\":\"${CONNECT_WAKE_FROM}\",\"fromDisplay\":\"${CONNECT_WAKE_DISPLAY}\"\})
 same =>   n,NoOp(Wake payload: ${CONNECT_WAKE_PAYLOAD})
 ; Curl with a tight timeout so a slow Connect API never hangs the call.
 ; max-time 3 = 3s ceiling; the API typically responds in <500 ms.
 same =>   n,Set(CONNECT_WAKE_RESP=${SHELL(curl --silent --show-error --max-time 3 \
                -X POST '${CONNECT_API_BASE}/internal/pbx/wake-extension' \
                -H 'content-type: application/json' \
                -H 'x-cdr-secret: ${CONNECT_CDR_SECRET}' \
                -d '${CONNECT_WAKE_PAYLOAD}' 2>&1)})
 same =>   n,NoOp(Wake response: ${CONNECT_WAKE_RESP})
 ; 6 second wait. This is the magic number — long enough for FCM delivery
 ; + JS bootstrap + SIP REGISTER on cold-killed Samsung S25, short enough
 ; that callers don't hear awkward silence. Tune to taste (4-8s).
 same =>   n,Wait(6)
 same =>   n,NoOp(== Connect Push-Wake end ext=${ARG1} call=${LINKEDID} ==)
 same =>   n,MacroExit()

[T25_push_wake_extension]
; Catch-all: dialed digits = target extension number.
; Wakes the device first, then dials normally.
exten => _X!,1,NoOp(== T25 push-wake context entered exten=${EXTEN} ==)
 same =>     n,Macro(connect-push-wake,${EXTEN})
 same =>     n,Set(__CONNECT_TARGET=PJSIP/${EXTEN}_1)
 same =>     n,Dial(${CONNECT_TARGET},30,Tt)
 same =>     n,NoOp(Dial finished status=${DIALSTATUS})
 same =>     n,GotoIf($["${DIALSTATUS}"="ANSWER"]?hangup)
 ; Fall through to voicemail on no-answer / busy / unavailable.
 same =>     n(vm),Goto(sub-leave-vm,${EXTEN}_1,1)
 same =>     n(hangup),Hangup()
```

## Configure globals

In **PBX Admin → PBX Settings → Asterisk Files → globals.conf** (or via the
GUI's *Custom Destinations → Globals*):

```asterisk
[globals]
CONNECT_API_BASE = https://app.connectcomunications.com/api
CONNECT_CDR_SECRET = REPLACE_WITH_VALUE_FROM_CONNECT_API_ENV
T25_VITAL_TENANT = T25
```

> **Get `CONNECT_CDR_SECRET`** from the Connect API's environment file at
> `/opt/connectcomms/env/api.env` on the prod server. Look for
> `CDR_INGEST_SECRET=…`. **Never commit this value to git.**

## Wire it to T25's inbound route

For each T25 DID:

1. Open **PBX Admin → External → Inbound Routes**.
2. Edit the route for the DID.
3. Set **Destination** = `Custom Application` and the application to
   `Goto(T25_push_wake_extension,101,1)` (replace `101` with the target
   extension).
4. Save and Apply.

If the DID is currently routed via an IVR, the IVR's "extension" entry can
be changed to the same Goto, so all paths use the wake context.

## Verify

After applying the dialplan, place a test call:

```bash
# On the PBX host, watch the call live:
asterisk -rvvv

# In another terminal (or via Connect logs), watch the wake events:
ssh prod 'docker logs -f --since=1m app-api-1 2>&1 | grep CALL_WAKE'

# In the mobile app: Settings → Diagnostics → Call Wake — Timeline.
```

Expected sequence (each row = one event in the Diagnostics timeline):

```
WAKE_HTTP_RECEIVED         api          T+0ms     pbxCallId=… ext=101
WAKE_REQUESTED             pbx_dialplan T+5ms     ext=101
WAKE_DEVICES_RESOLVED      api          T+12ms    deviceCount=1
WAKE_PUSH_QUEUED           api          T+340ms   queued=1
WAKE_HTTP_RESPONDED        api          T+342ms   devicesNotified=1
WAKE_PUSH_DELIVERED        api          T+345ms   expoStatus=ok
DEVICE_PUSH_RECEIVED       device       T+1.2s    appState=BACKGROUND
DEVICE_REGISTER_TRIGGERED  device       T+1.3s    forceRestart=true
DEVICE_REGISTER_COMPLETE   device       T+2.4s    registerLatencyMs=1100
INVITE_PUSH_DELIVERED      api          T+6.1s    (from telephony PSTN ring)
DEVICE_INVITE_RECEIVED     device       T+6.4s    inviteId=…
DEVICE_INVITE_UI_SHOWN     device       T+6.5s    presentation=full_screen
DEVICE_ANSWER_TAPPED       device       T+9.0s    (when user picks up)
```

## Roll back

To disable wake on a single DID, change its inbound destination back to the
old `Goto(from-did-direct,101,1)` (or whatever it was before). The
`T25_push_wake_extension` and `macro-connect-push-wake` definitions can stay
in place — they're inert until called.

To remove the dialplan entirely:

1. Delete the two contexts from Custom Contexts.
2. Optionally remove the `CONNECT_*` globals.
3. Run `asterisk -rx "dialplan reload"`.

## Universal applicability

This dialplan works on **all** Android phones (Pixel, OnePlus, Xiaomi,
OPPO, Samsung S22-S25), all Android versions (8 → 16), and is the
foundation for the upcoming iOS implementation (which will replace the
Expo push with PushKit / VoIP push to the same backend endpoint).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `WAKE_HTTP_RECEIVED` never appears in API logs | PBX can't reach `${CONNECT_API_BASE}` | Check egress firewall; `curl -v ${CONNECT_API_BASE}/health` from the PBX |
| `WAKE_HTTP_RECEIVED` returns 401 | `CONNECT_CDR_SECRET` mismatch | Re-fetch `/opt/connectcomms/env/api.env` on the prod server and update globals |
| `WAKE_TENANT_NOT_FOUND` | `T25_VITAL_TENANT` doesn't match `TenantPbxLink.pbxTenantCode` in DB | Check via `psql` or set `tenantId` in the payload directly |
| `WAKE_EXTENSION_NOT_FOUND` | Extension not active or not owned by a user in Connect | Open Extensions in the portal; ensure ownerUserId is set and status=ACTIVE |
| `DEVICE_PUSH_RECEIVED` missing | FCM delivery failed (battery saver, app uninstalled, token expired) | Check `MobileDevice.lastPushStatus` in the portal; user may need to re-open the app once |
| `DEVICE_REGISTER_COMPLETE` missing but push received | SIP UA rejected register (auth failure / SBC down) | Check `apps/realtime` and SBC logs |
| Call still drops to voicemail | `Wait(6)` too short for the phone in question | Increase to `Wait(8)` or `Wait(10)` |
