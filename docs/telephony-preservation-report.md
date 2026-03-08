# Telephony Preservation and UI Shelving Report

## 1) Asterisk/SBC related modules discovered

### Core telecom API and orchestration (PRESERVE)

- `apps/api/src/server.ts`
  - Voice/SBC/PBX endpoints (`/voice/*`, `/admin/sbc/*`, `/admin/pbx/*`, `/webhooks/pbx`)
  - SIP/SBC readiness checks, telephony routing controls, PBX event ingestion
  - VoIP.ms/Twilio/SMS/WhatsApp/Billing integration touchpoints used by telecom flows
- `apps/worker/src/main.ts`
  - PBX job pipeline (`PbxJob` execution)
  - Active call polling, CDR sync, invite state transitions
  - Voice diagnostics worker cycles and alerting

### PBX integration clients (PRESERVE)

- `packages/integrations/src/vitalpbx/index.ts`
  - VitalPBX auth, retries, endpoint wrappers (tenants/extensions/trunks/queues/IVR/routes/recordings/reports)
- `packages/integrations/src/pbx-wirepbx/index.ts`
  - Canonical PBX event normalization, webhook and active-call polling support
- `packages/integrations/src/index.ts`
  - Exports PBX integration modules consumed by API/worker

### SBC and signaling infrastructure (PRESERVE)

- `infra/sbc/kamailio/kamailio.cfg`
- `infra/sbc/kamailio/tls.cfg`
- `infra/sbc/kamailio/start.sh`
- `infra/sbc/rtpengine/README.md`
- `docker-compose.sbc.yml`
- `scripts/sbc-remote/deploy-remote-sbc.sh`
- `scripts/sbc-remote/verify-remote-sbc.sh`
- `scripts/sbc-remote/rollback-remote-sbc.sh`

### Telephony data models (PRESERVE)

- `packages/db/prisma/schema.prisma` (voice/pbx/sbc/ivr/recording/call entities)
  - `PbxInstance`, `TenantPbxLink`, `PbxExtensionLink`, `PbxDidLink`, `PbxJob`, `PbxCdrCursor`
  - `PbxCallEvent`, `IvrSchedule`, SIP/SBC-related fields on tenant/user/session entities

### Mobile/client SIP hooks (PRESERVE)

- `apps/mobile/src/sip/*`
- `apps/mobile/src/context/SipContext.tsx`
- `apps/mobile/src/screens/IncomingCallScreen.tsx`
- `apps/mobile/src/screens/DialpadScreen.tsx`

## 2) What backend telephony code was preserved

No telephony backend modules were deleted or modified in this task.

- API telecom endpoints: preserved
- Worker telecom cycles/jobs: preserved
- PBX integration clients: preserved
- SBC/Kamailio/RTPengine configs: preserved
- Prisma telephony schema: preserved

## 3) Where the old UI was archived

- Previous UI moved to: `apps/frontend-legacy/portal-v2-legacy`
- Legacy archive marker: `apps/frontend-legacy/README.md`

## 4) New frontend folder structure

New primary frontend scaffold is now under `apps/portal`:

- `app`
- `components`
- `layout`
- `navigation`
- `dashboard`
- `team`
- `chat`
- `sms`
- `calls`
- `voicemail`
- `contacts`
- `recordings`
- `reports`
- `settings`
- `admin`
- `apps`
- `permissions`
- `integrations`
- `hooks`
- `services`
- `types`
- `theme`

## 5) Telephony service interface created

- `apps/portal/services/asteriskService.ts`
  - `getTenantTelephonyState()`
  - `assertCreateAllowed()`
  - `getExtensions()`
  - `getRegistrationStatus()`
  - `getActiveCalls()`
  - `getCallHistory()`
  - `getVoicemail()`
  - `getRecordings()`
  - `getTrunks()`
  - `getQueues()`
  - `getIVRs()`
- `apps/portal/types/telephony.ts` for typed discovery contracts

Behavior enforced:

1. Discover existing telephony objects first.
2. If object exists, load/display existing data.
3. Block duplicate create (`assertCreateAllowed`) unless object is missing.

## 6) Potential conflicts found (old UI vs telephony services)

- Legacy UI mixed layout/navigation refactors with telephony pages, making frontend failures capable of surfacing as broad route 500s.
- Legacy PBX screens could call create/update actions without an explicit shared discovery guard layer.
- New scaffold isolates telephony discovery logic in a dedicated service to prevent blind re-creation paths.

## 7) Server access safety confirmation

This task made no infrastructure or server access changes:

- SSH config untouched
- Port 22 untouched
- Firewall rules untouched
- nginx untouched
- PM2 untouched
- Docker/systemd untouched
- DB/recordings/uploads untouched
- Env files untouched
