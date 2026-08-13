# iOS standalone (no-Metro) build — incoming-call wake test

Routing: SIG::CURSOR-CONNECT-01. iOS-only. Nothing here has been applied — this
is a prepared runbook for Izzy to execute + review.

## Purpose

Give Izzy a standalone, internal-distribution iOS build he can install directly
on his iPhone (no Metro / no dev-client) to test incoming-call wake-up in all
three app states:

1. **Foreground** — app open on screen.
2. **Backgrounded** — app in the background but not killed.
3. **Force-quit / cold start** — app swiped away; only a VoIP push can wake it.

The on-device DBG call-flow overlay is enabled in this build so the wake path is
observable without a Metro log stream.

## What was changed in the repo (staged for review — NOT committed, NOT deployed)

### `apps/mobile/eas.json` — new `ios-test` build profile (additive only)

```json
"ios-test": {
  "distribution": "internal",
  "channel": "preview",
  "credentialsSource": "remote",
  "ios": { "resourceClass": "m-medium" },
  "env": {
    "EXPO_PUBLIC_VOICE_SIMULATE": "false",
    "EXPO_PUBLIC_LOG_LEVEL": "debug",
    "EXPO_PUBLIC_CALL_FLOW_DEBUG_OVERLAY": "true"
  }
}
```

- `credentialsSource: "remote"` — required because `apps/mobile/credentials.json`
  has only the Android keystore (no iOS creds). EAS-managed credentials are used
  for the iOS signing/provisioning.
- `EXPO_PUBLIC_CALL_FLOW_DEBUG_OVERLAY=true` — turns on the release-build DBG
  overlay. `app.config.ts` maps this env → `extra.callFlowDebugOverlay`, and
  `src/debug/CallFlowDebugOverlay.tsx` (`overlayEnabled()`) shows the overlay in
  a non-`__DEV__` build only when that flag is `true`. Scoped to this profile's
  `env`, so no `app.config.ts` change and no effect on any other build.
- No `android` block → this profile is iOS-only; always build with
  `--platform ios`. No existing profile was modified or reordered.

## Read-only entitlement verification (task 3 — confirmed, nothing modified)

- **`aps-environment: production` for internal distribution** — confirmed.
  Nothing in the mobile repo hardcodes `aps-environment`. `plugins/withIosVoipPush.js`
  leaves `withEntitlementsPlist` as an explicit **no-op** (comment:
  "aps-environment already handled by EAS"). EAS therefore assigns the entitlement
  from the provisioning profile that matches the build's distribution type:
  - dev-client builds (`dev`, `ios-dev-device`, `developmentClient: true`) →
    development provisioning → `aps-environment: development` (**sandbox** APNs).
  - `internal` distribution **without** dev-client (this new `ios-test` profile,
    and `preview`) → ad-hoc distribution provisioning → `aps-environment:
    production` (**production** APNs host).
- **VoIP topic = `com.connectcommunications.mobile.voip`** — confirmed.
  `app.config.ts` sets `ios.bundleIdentifier = com.connectcommunications.mobile`;
  the APNs sender (`packages/shared/src/apnsVoipPush.ts`, `envVoipTopic()`)
  defaults the topic to `<bundleId>.voip`, and `plugins/withIosVoipPush.js`
  documents the same value. `UIBackgroundModes` includes `voip`.

## PREPARED SERVER CHANGE — DO NOT APPLY HERE (owner + deploy-queue only)

A standalone internal build's VoIP token is valid **only** on Apple's
**production** APNs host (`https://api.push.apple.com`). The server currently
targets **sandbox** (the Metro dev-client's environment). To wake the standalone
build, the server must select the production host.

- **Env var:** `APNS_PRODUCTION=true`
  (`packages/shared/src/apnsVoipPush.ts` → `envHost()`: `"true"` →
  `https://api.push.apple.com`, otherwise the sandbox host.)
- **Services that must get it** — both services that send VoIP pushes:
  - **`api`** — the live `CallInvite` path (`apps/api/src/server.ts`).
  - **`worker`** — the PBX-poll fallback path (`apps/worker/src/main.ts`).
- **No other service consumes it.** Only `apps/api` and `apps/worker` import the
  shared `apnsVoipPush.ts`. `realtime` and `telephony` also load `.env.platform`
  as their `env_file`, so the variable is present in their environment, but
  neither imports the VoIP sender, so the flag is a no-op for them. Android/FCM
  never touches this path.

### WHERE the env var actually lands (verified against the deploy pipeline)

Both `api` and `worker` in `docker-compose.app.yml` load:

```
env_file:
  - /opt/connectcomms/env/.env.platform
```

`APNS_PRODUCTION` is **not** present in either service's docker-compose
`environment:` override block, so it is read **straight from that shared env
file**. Therefore the change is a **single edit to `/opt/connectcomms/env/.env.platform`**
(covers both services), followed by recreating both containers so they re-read it.

> Important: do **not** add `APNS_PRODUCTION` to the compose `environment:` blocks.
> `environment:` wins over `env_file`, and a `${APNS_PRODUCTION:-false}` default
> would silently override the env-file value to `false` whenever the host shell
> doesn't export it. The env-file is the correct single source of truth.

### HOW to apply (two steps — neither done by the agent)

1. **Owner edits the env file** (agents may NOT edit `/opt/connectcomms/env/`, per
   AGENTS.md hard rule #10). On the server, in `/opt/connectcomms/env/.env.platform`:

   ```
   APNS_PRODUCTION=true
   ```

   (change the existing `APNS_PRODUCTION=false` line, or add it if absent).

2. **Recreate both containers via the deploy queue** so they re-read the env file.
   Because there is no code/commit change, the deploy scripts would otherwise hit
   the same-commit `no_changes` skip guard and **not** recreate the container — so
   the enqueue MUST pass **`forceRestart: true`** (this bypasses ONLY the
   same-commit skip; build/health/rollback are unchanged — see
   `ops/deploy-queue/src/commitSkip.ts`, comment: "to pick up a changed env var").

   > ⚠️ **Do NOT enqueue these by branch — pin the exact live commit.** The queue
   > does fetch → checkout `<ref>` → build → up, so a branch would rebuild the
   > service from that branch's **tip**. Two traps make branch unsafe here:
   > 1. **`api` is currently deployed via `scripts/deploy-direct.sh`, which BYPASSES
   >    the queue** (and supports only `api|portal`). Its live code is on
   >    `fix/ios-fg-active-gate` (foreground-active gate + voice-note MIME fix +
   >    loudnorm). But the deploy-**queue** history's last recorded `api` job is
   >    **`main` (2026-06-28) — STALE**. Enqueuing `api` on the queue's branch would
   >    **rebuild it from `main` and revert those fixes.** (Verified live: the
   >    running `api` container's baked `/app/.build-commit` = `d21dfd23…`, contained
   >    only in `origin/fix/ios-fg-active-gate`.)
   > 2. A branch tip can advance after deploy, so even the "right" branch can build
   >    newer code than what is live.
   >
   > The helper below detects each service's **actual live commit** and enqueues
   > with `commitHash` pinned to it. In the queue, **`commitHash` wins over
   > `branch`** (`git checkout --detach <commit>`), so the recreate builds
   > byte-identical code — only the env changes.
   >
   > Authoritative live-commit source, per service (NO fallback to `main`):
   > - Prefer the commit **baked into the running container** (`/app/.build-commit`;
   >   `apps/api/Dockerfile` bakes it — correct even for direct-deployed `api`).
   > - Else the deploy-queue's most recent **successful, non-dry-run** job for that
   >   service (authoritative for queue-only services like `worker`, whose image
   >   does not bake `.build-commit` and which cannot be direct-deployed — its live
   >   commit is `9f4a2842…` on `feature/mobile-dnd-wake-skip`).
   > - If neither resolves → the helper **ABORTS that service** (never `main`).

   Prepared helper (staged, review before running — run it **on the server**;
   `127.0.0.1` is a trusted deploy-queue origin so no token is needed). Default is
   a **detect + echo dry-run that enqueues NOTHING**:

   ```
   bash scripts/ops/_enqueue-apns-production.sh          # DRY-RUN: detect + echo only, enqueues nothing
   bash scripts/ops/_enqueue-apns-production.sh --apply   # REAL enqueue (recreates api + worker)
   ```

   The `--apply` run enqueues one commit-pinned, `forceRestart:true` job per
   service, e.g. (commit values are detected live at run time):

   ```json
   { "service": "api",    "branch": "fix/ios-fg-active-gate",     "commitHash": "<live api commit>",
     "forceRestart": true, "source": "manual", "requestedBy": "human:izzy",
     "reason": "recreate to pick up APNS_PRODUCTION=true (iOS-only)" }
   { "service": "worker", "branch": "feature/mobile-dnd-wake-skip","commitHash": "<live worker commit>",
     "forceRestart": true, "source": "manual", "requestedBy": "human:izzy",
     "reason": "recreate to pick up APNS_PRODUCTION=true (iOS-only)" }
   ```

   (`branch` is sent only because the enqueue API requires a non-empty branch
   field; `commitHash` drives the actual checkout.)

   Post-verify after the jobs finish:

   ```
   ssh connect "docker exec app-api-1 printenv APNS_PRODUCTION"      # expect: true
   ssh connect "docker exec app-worker-1 printenv APNS_PRODUCTION"   # expect: true
   ```

### ⚠️ WARNING — this flip affects ALL iOS VoIP pushes

Setting `APNS_PRODUCTION=true` switches the APNs host **globally** for every iOS
device. Any iOS device still registered from a **sandbox / Metro dev-client**
build will **stop waking** on incoming calls (its sandbox token is rejected by
the production host with `BadDeviceToken`) until it is rebuilt/reinstalled as a
production/standalone build and re-registers. Android is unaffected (it never
uses this path). Plan the flip for when no one is relying on a dev-client iOS
device for call wake-up, or move all iOS test devices to standalone builds first.

### Rollback

Set `APNS_PRODUCTION=false` (or remove the line) in
`/opt/connectcomms/env/.env.platform`, then re-run the prepared enqueue helper
(`--apply`) to recreate `api` + `worker`. That reverts VoIP delivery to the
sandbox host (`https://api.sandbox.push.apple.com`) and restores dev-client iOS
wake-up.

This flip must go through the **deploy queue** (per AGENTS.md) — do not set it by
hand on the containers and do not deploy directly. The agent has **not** applied,
deployed, committed, or self-approved anything here.

## Commands for Izzy to run from his machine (needs interactive Apple login)

`eas build` is NOT run by the agent (requires Izzy's Apple login).

```bash
# (ad-hoc internal distribution only) register the iPhone once, first:
cd apps/mobile && eas device:create

# build the standalone iOS test app:
cd apps/mobile && eas build --profile ios-test --platform ios

# when the build finishes, install via the EAS internal-distribution QR / link.
```

After installing, force-quit the app and place an inbound call to verify the
cold-start VoIP wake (the DBG overlay shows the wake path). Foreground and
backgrounded states should also be exercised.

Remember: the standalone build only wakes on cold-start once `APNS_PRODUCTION=true`
has been shipped to `api` + `worker` via the deploy queue (see warning above).
