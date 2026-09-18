# TrimPro Field Build Guide

## Build an Android APK

1) `cd apps/mobile`  
2) `npm install`  
3) Confirm Expo and EAS authentication is already connected  
4) `npm run build:apk`  
5) Open the EAS build URL printed in the terminal and download the APK from that build page

## Build Commands

- APK (internal testing): `npm run build:apk`
- AAB (store): `npm run build:aab`
- OTA preview update: `npm run ota:preview`
- OTA production update: `npm run ota:prod`

## When to Build a New APK vs OTA Update

- Build a new APK when native runtime changes are included, package configuration changes, permissions change, or you need a fresh installable for testers.
- Use OTA update when changes are JavaScript or styling only and the installed app runtime already matches.

## Share Intent (Receive Files From Other Apps)

TrimPro Field uses [`expo-share-intent`](https://github.com/achorein/expo-share-intent) (SDK 54 / package v5)
to appear in the Android share sheet and bridge shared files into JS.

Configured in `app.json`:

- MIME types: `*/*`, `image/*`, `video/*`, `application/pdf`
- Single + multiple file shares
- iOS share extension disabled for now (`disableIOS: true`)
- `MainActivity` launch mode `singleTask`

Flow:

1. User shares a file from Photos / Files / Gmail → TrimPro Field
2. Native module copies the content URI and exposes it via `ShareIntentProvider`
3. App opens `ShareIngressScreen` with the file pre-filled
4. User picks Job / Request / Job Chat and attaches

Manual test paths still work:

- Profile → Sharing → Test Share Ingress
- Deep link: `trimprofield://share-ingress?uri=<file-uri>&name=test.pdf&mimeType=application/pdf`

This is a **native runtime change** — publish a fresh APK (not OTA) after updating share intent config.

### Testing after an APK rebuild

1. Confirm the app appears in Android's share sheet: open Photos/Files/Gmail,
   share an image or PDF, and check "TrimPro Field" is listed.
2. Share a file into TrimPro Field → Share Ingress should open with that file.
3. Attach it to a job / request / job chat and confirm upload.
