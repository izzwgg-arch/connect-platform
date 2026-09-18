# TrimPro Field Deployment (OTA + Builds)

This app supports both EAS Build (APK/AAB) and EAS Update (OTA).

## One-time setup

From `apps/mobile` run:

1. `npm install`
2. `npx eas login`
3. `npx eas init`
4. `npx eas update:configure`

If `eas update:configure` changes files, commit those changes.

## When OTA is enough (no new APK needed)

Use OTA updates for:

- JS/TS code changes
- UI/layout changes
- API usage changes in React code
- Bug fixes in app logic
- Most feature updates that do not add/change native modules

Publish OTA (guarded):

- Preview/internal testers: `npm run ota:preview -- "your release note"`
- Production users: `npm run ota:prod -- "your release note"`

The guarded OTA script blocks publish when:

- Working tree is dirty
- Channel config does not match `eas.json`
- `runtimeVersion.policy` is not `appVersion`
- `updates.url` is missing

It also appends the current short commit hash to the OTA message for traceability.

## When a new APK/AAB is required

Build a new binary when changes involve native runtime:

- Adding/changing native modules (for example SIP native libraries)
- Adding/changing Expo config plugins
- Changing Android permissions that require native rebuild
- Changing `android.package`
- Expo SDK upgrades that change native runtime
- Any `runtimeVersion` break (for example app version bump with policy `appVersion`)

Build commands:

- Internal APK: `npm run build:apk`
- Production AAB: `npm run build:aab`

## Recommended workflow

### Internal testers (preview)

1. First install: `npm run build:apk`
2. Ongoing JS/UI fixes: `npm run ota:preview -- "preview note"`
3. Rebuild APK only for native/runtime changes

### Production releases

1. Store binary: `npm run build:aab`
2. Ongoing JS/UI fixes: `npm run ota:prod -- "production note"`
3. Publish a new store binary for native/runtime changes

## Runtime/version note

OTA updates only apply to builds with matching `runtimeVersion`.
This app uses:

- `runtimeVersion: { "policy": "appVersion" }`

If app version changes, users need a new installed build before receiving updates for the new runtime.
