# A second VoIP.ms account can be attached (2026-09-15)

Full handoff: `docs/ai-context/AGENT_HANDOFF_VOIPMS_SECOND_ACCOUNT_2026-09-15.md`

- `GlobalVoipMsConfig` is one row per VoIP.ms account now; the **primary keeps id
  `"default"`** so every legacy `findUnique({id:"default"})` consumer
  (provisioning, guardrail, billing SMS, port watchdog) is untouched and stays
  on the primary. Extra accounts: UUID id + `label`.
- `TenantSmsNumber.voipmsAccountId` (default `'default'`) says which account
  owns each DID — **stamped by the DID sync**, followed by the worker's outbound
  send, the inbound poller (grouped per account, per-account credentials), and
  send-test-sms. Migration `20260915220000_voipms_second_account`, additive.
- UI: `/apps/voip-ms` → Connection → "VoIP.ms accounts" panel (attach/test/
  sync/remove) + an Account column on Numbers when >1 account. No new page, no
  new permission key.
- ⛔ Second account must enable API access for the Connect server IP in ITS
  VoIP.ms portal, or every call answers `ip_not_enabled`.
- ⛔ Trunk guardrail + provisioning still watch ONLY the primary — extend them
  before ever putting PBX-trunked numbers on a second account.
- ✅ 11 new tests (3 source guards fail vs pre-feature HEAD), worker 168/168,
  typechecks clean in changed files. ⏳ NOT PROVEN: no real second account
  attached yet; no second-account text sent/received.
