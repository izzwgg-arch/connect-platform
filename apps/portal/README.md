# New Portal Foundation

This is the clean frontend foundation replacing the old portal shell.

## Goals

- Keep telephony backend logic untouched and reusable.
- Build UI modules on top of service interfaces.
- Enforce discovery-first telephony behavior before create/update actions.

## Folder Layout

- `app`: Next.js app entrypoint and baseline routes.
- `components`: shared UI primitives.
- `layout`: shell and page layout modules.
- `navigation`: nav model and guards.
- `dashboard`, `team`, `chat`, `sms`, `calls`, `voicemail`, `contacts`, `recordings`, `reports`, `settings`, `admin`, `apps`: feature domains.
- `permissions`: role/permission helpers for UI composition.
- `integrations`: frontend integration adapters.
- `hooks`: React hooks.
- `services`: API and telephony service interfaces.
- `types`: shared types.
- `theme`: theme tokens and style contracts.

## Discovery-First Rule

Use `services/asteriskService.ts` before any telephony create flow:

1. Discover existing tenant telephony resources.
2. Display existing configuration if found.
3. Allow create only when the target object does not exist.
