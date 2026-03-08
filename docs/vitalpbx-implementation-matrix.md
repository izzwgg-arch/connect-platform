# VitalPBX 4 Implementation Matrix

Source of truth:
- Postman public docs: `publishedId=2s935hQmgP`
- Collection API: `https://documenter.gw.postman.com/api/collections/5481262/2s935hQmgP?segregateAuth=true&versionTag=latest`

## Coverage summary

- Documented endpoints discovered in collection: `100`
- Endpoints registered in code: all documented route families represented in `packages/integrations/src/vitalpbx/endpointRegistry.ts`
- Generic execution support: `VitalPbxClient.callEndpoint(endpointKey, ...)`
- High-level convenience wrappers:
  - Fully mapped: tenants, queues, CDR, account/customer/authorization codes, AI API keys, SMS, WhatsApp, voicemail actions
  - Read-only mapped: extensions, trunks, outbound routes, users, roles, destinations, conferences, classes of service, phonebooks, faxes
  - Explicitly marked unsupported-by-public-docs for write flows: extension CRUD, trunk CRUD, outbound route CRUD, ring groups, IVR

## Version and capability flags

`VitalPbxClient.detectCapabilities()` exports:
- `supportsAuthorizationCodesCrud`
- `supportsCustomerCodesCrud`
- `supportsAiApiKeysCrud`
- `supportsAccountCodesRead`
- `supportsExtensionAccountCodesRead`
- `supportsTenantsCrud`
- `supportsQueuesCrud`
- `supportsRecordingsRead`
- `supportsVoicemailDelete`
- `supportsVoicemailMarkListened`
- `supportsWhatsappMessaging`
- `supportsSmsSending`
- `supportsCdrRead`
- `supportsRecordingUrlInCdr`

## Auth and tenant behavior

- API key header: `app-key`
- Backward compatible auth also sent: `Authorization: Bearer <token>` and `x-api-secret` when configured
- Tenant context:
  - default transport: `tenant` header
  - configurable transport: header/query/both
  - only injected for tenant-aware endpoints from registry

## Permission enforcement

- Backend role-to-permission map is now explicit for VitalPBX actions:
  - `SUPER_ADMIN`, `ADMIN`, `BILLING`, `MESSAGING`, `SUPPORT`, `READ_ONLY`, `USER`
- Tenant PBX resource routes enforce action-level checks (`view/create/update/delete`) before upstream calls:
  - `/voice/pbx/resources/:resource`
  - `/voice/pbx/resources/:resource/:id`
- Added smoke coverage script:
  - `scripts/smoke-v2.0.2-vitalpbx-perms.sh`

## Error mapping

Client maps upstream failures into:
- `NOT_CONFIGURED`
- `NOT_SUPPORTED`
- `PBX_AUTH_FAILED`
- `PBX_UNAVAILABLE`
- `PBX_VALIDATION_FAILED`
- `PBX_RATE_LIMIT`
- `PBX_TENANT_CONTEXT_ERROR`
- `PBX_TIMEOUT`
- `PBX_PARSE_ERROR`
- `PBX_UNKNOWN_ERROR`

## Notes

- The public VitalPBX collection itself states the API is still under construction; unsupported flows are intentionally explicit and never call invented endpoints.
- Queue CRUD is implemented because those endpoints are documented.
- CDR sync helper includes overlap-window behavior for hangup-written records and dedupe by stable key candidates.
