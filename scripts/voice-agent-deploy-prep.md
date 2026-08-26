# Voice agent — deploy runbook

The conversational order-taking IVR. Two code halves (telephony bridge + api
doors), a PBX dialplan context, and per-tenant enablement. All steps are
idempotent and each fails toward the human fallback.

## Preconditions
- api carries the supermarket migration (`20260826020000_supermarket_mode`:
  VoiceAgentSettings, VoiceAgentCall, PosCatalogItem, SupermarketOrderDraft,
  ProviderCredential enum OPENAI) — the fork's commit.
- api carries `apps/api/src/voiceAgent/*` + server.ts/bypass wiring (this work).
- telephony carries `apps/telephony/src/voiceAgent/*` (committed 58fafae9).

## 1. Platform env (loopcom `/opt/connectcomms/env/.env.platform`)
⛔ env_file ONLY — never `environment:` in compose (the `${VAR:-}` blank trap).
```
VOICE_AGENT_ENABLED=1
VOICE_AGENT_PORT=4590
VOICE_AGENT_MAX_SESSIONS=8
```
`CDR_INGEST_SECRET` is already set (the telephony↔api internal lane the voice
agent reuses). Back up the file first (`.bak.<stamp>.voiceagent`).

## 2. Firewall — restrict the AudioSocket port to the PBX (defense in depth)
The docker-published `4590` bypasses ufw, so lock it at DOCKER-USER. The UUID
bearer token is the STRUCTURAL lock; this is belt-and-braces.
```
# on loopcom, PBX is 209.145.60.79
iptables -I DOCKER-USER -p tcp --dport 4590 ! -s 209.145.60.79 -j DROP
# persist (netfilter-persistent or the host's usual mechanism)
```

## 3. Deploy order
1. Deploy **api** first (migration + doors). Container-verify:
   `docker exec app-api-1 grep -c registerVoiceAgentRoutes /app/apps/api/src/server.ts`
   and the migration applied (VoiceAgentCall table exists).
2. Deploy **telephony** (bridge). Boot line to confirm:
   `docker logs app-telephony-1 | grep VOICE_AGENT_ARMED` — shows the port +
   `apiConfigured: true`.
3. Patch the PBX dialplan (from the repo, on the PBX):
   `VA_HOST=45.14.194.179 bash scripts/pbx/patch-connect-voice-agent.sh`
   Confirms `[connect-voice-agent]` loads and sets `connect/va host|port`.

## 4. Enable ONE pilot tenant (Loopcom Demo T102)
```
# Connect tenant id for T102 — resolve from TenantPbxLink pbxTenantId=102.
# a) OpenAI key + settings via the admin door (SUPER_ADMIN token):
PUT /api/admin/voice-agent/<tenantId>
  { "enabled": true, "voice": "cedar", "storeName": "Loopcom Demo Grocery",
    "openAiKey": "<the tenant's OpenAI key>", "greeting": "" }
# b) catalog: either a live POS sync (fork's catalogSync) OR a manual import:
POST /api/admin/voice-agent/<tenantId>/catalog-import { "items": [ ... ] }
# c) PBX: point the demo DID at the context + set the human fallback:
#    database put connect/va/<slug>/fallback_dest "T102_cos-all,101,1"
#    and route the DID's dialplan Goto to connect-voice-agent,s,1 with
#    TENANT_SLUG/PBX_TENANT_ID/VA_DID set.
```

## 5. Acceptance — a real call
Call the pilot DID. The AI greets, takes a small order (by number and by name),
reads it back, confirms; the order appears as a `SupermarketOrderDraft`
(sourceType `voice_call`, status NEEDS_REVIEW) with `agentItems` frozen. Then:
say "let me talk to a person" on a second call and confirm it lands at the
fallback (`connect/va/<uuid>` = transfer in the log, then the human dest).

## Rollback (any layer, independent)
- Kill the AI instantly: `VOICE_AGENT_ENABLED` unset + telephony restart, OR
  per-tenant `enabled:false`, OR point the DID back at its old destination.
- Dialplan: the patch script backs up `extensions__60_custom.conf`; restore it
  and `dialplan reload`.
- Every layer fails toward the human fallback, so a half-rolled-back state
  still reaches a person.
