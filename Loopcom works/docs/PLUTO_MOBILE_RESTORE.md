# Snapshot: Pluto Mobile

## Overview

| Field         | Value                        |
|---------------|------------------------------|
| Snapshot name | Pluto                        |
| Tag           | `pluto-mobile`               |
| Branch        | `snapshot/pluto-mobile`      |
| Purpose       | Reliable restore point for the mobile app state at the time of this commit |

---

## What This Snapshot Covers

This snapshot captures the full current state of the TrimPro Field mobile app (`apps/mobile/`) and its supporting backend, including:

- **Mobile app fixes applied in this session:**
  - Chat color blend matching other app pages
  - Keyboard avoidance fix for Android (adjustNothing plugin + KeyboardAvoidingView)
  - Tab bar `tabBarHideOnKeyboard: false` to stop composer bounce
  - Double vibration on chat exit fix (`cancelRecording` silent flag)
  - Hidden sent message fix (pendingScrollAfterSendRef + double rAF scroll)
  - In-app video player and media viewer (ImageViewer + VideoViewer)
  - Video thumbnail component (`VideoThumbnail.tsx`) with safe null fallback
  - Voice note playback fix (normalized `/uploads/...` URLs)
  - `expo-video-thumbnails` removed to prevent native module crash (OTA safe)

- **Backend / API changes in this session:**
  - QuickBooks Online integration refactored to event-driven sync queue
  - `QboSyncJob` queue table + `lib/qbo/sync-queue.ts` worker
  - `vercel.json` cron for QBO worker (every 5 min) and reconcile (every 2 hrs)
  - Per-tenant ACH reconciliation cooldown guard
  - Prisma schema additions: `serviceItemId`, `cachedExpenseAccountId`, `reconcileLastAt`, `QboSyncJob`
  - All direct `syncXToQuickBooks` calls replaced with `enqueueQboSync`

---

## Commit Hash

> **`c8fef5eac73786be7f7f926b547506f970229530`**

To verify at any time:
```bash
git rev-parse pluto-mobile
```

---

## Restore Instructions

### Option A — Restore working tree to this snapshot (non-destructive)
```bash
git checkout pluto-mobile
```

### Option B — Restore and create a new branch from this snapshot
```bash
git checkout -b restore/pluto-mobile pluto-mobile
```

### Option C — Hard reset your current branch to this snapshot
> Warning: this overwrites uncommitted work.
```bash
git fetch origin
git reset --hard pluto-mobile
```

### Option D — Restore only the mobile app folder from this snapshot
```bash
git checkout pluto-mobile -- apps/mobile/
```

---

## Verification

```bash
# Confirm the tag exists and points to the right commit
git show pluto-mobile --stat

# Confirm the backup branch
git log snapshot/pluto-mobile --oneline -5
```

---

*This file was created as part of the Pluto snapshot process and should not be modified.*
