# AGENT HANDOFF — iOS CallKit zombie-call fix + TestFlight release (2026-08-02)

**Outcome: iOS build 44 (EAS `3d8103af-1af7-4b54-b85e-15748761764c`, commit
`695a53e6`, ios-clean) is VERIFIED ON DEVICE by Izzy — "I tested it. It was
good."** Its TestFlight twin, **build 45** (EAS `27387fbe-ec15-4ed5-a1ea-8b4b3315789d`,
commit `ecb6071f`, ios-prod), is uploaded, beta-review **APPROVED the same
night**, and live to the external group "Loopcom Testers" (Eli included).

This session fixed a **self-inflicted regression** from the previous session's
auto-decline work, added the missing iOS call-teardown safety net, redesigned the
voicemail multi-select bar, and uncovered a **pre-existing repo defect that made
any clean checkout unbuildable**.

Read this before touching the iOS deferred-decline logic, `nativeCallEndedCleanup`,
or the EAS build pipeline. Prior context lives in
[`AGENT_HANDOFF_IOS_PARITY_2026-07-30.md`](AGENT_HANDOFF_IOS_PARITY_2026-07-30.md)
and [`AGENT_HANDOFF_REGISTRATION_PUSH_2026-07-31.md`](AGENT_HANDOFF_REGISTRATION_PUSH_2026-07-31.md).

---

## What shipped

| Commit | Fix |
|---|---|
| `4640a04d` | **Zombie CallKit call** (green in-call pill with no call; lock-screen call that had to be hung up separately) + **voicemail selection-bar redesign with Select All**. Details below. |
| `695a53e6` | buildNumber 44 — ad-hoc verification build. |
| `0e5207d7` | **`pnpm-lock.yaml` synced with the four declared patches.** Repo-wide build fix, not iOS-specific. |
| `ecb6071f` | buildNumber 45 — TestFlight twin of the verified build 44. |

---

## 1. The zombie CallKit call — a regression I introduced the session before

### Symptom (Izzy, 2026-08-02)

> "That green pill on top is back. There is no active phone call... even after I
> hung up the call, I didn't even answer from the lock screen, but the lock screen
> active call screen somehow also comes active. I have to hang it up separately."

### Proof (from `voiceDiagEvent`, no Mac needed — twice in one session)

```
01:21:20.098  ANSWER_TAPPED   ACCEPT
01:21:20.512  CALL_CONNECTED            <- green pill appears, call is live
01:21:21.386  ANSWER_TAPPED   DECLINE   <- 1.3s INTO the live call
01:22:54.908  ACCEPT -> CONNECTED -> DECLINE 1.1s later (identical repeat)
```

### Root cause

The previous session's fix (`c1b1e0cb`, build 43) widened the iOS deferred-decline
window to 12s so a stray CallKit `endCall` could not auto-decline a call the user
was still reaching for. But the "has this been answered?" test ran **only at
scheduling time**, inside `onEnd`. With a 12-second window the timer now outlives
the answer and fires into a **connected** call.

Firing `handleDeclineInvite` on a connected call is the wrong operation entirely —
it sends a ring rejection (486), which **cannot tear down a confirmed dialog**. The
code already carried that warning from a July fix ("lock-screen hang up doesn't
hang up"). So the SIP session AND the CallKit call both survived. That is the pill.

### The fix (`apps/mobile/src/context/NotificationsContext.tsx`, `onEnd`)

1. Re-evaluate "answered" at **FIRE time**, not scheduling time.
2. Re-evaluate it **again after the `resolveInviteForAction` await** — that await
   yields, and an answer landing inside it would otherwise still be declined.
3. **Ground the check in the module-scope SIP singleton**, not the closure:
   ```ts
   client.listSessions().some(s => !!s?.confirmedAtMs || s?.state === "connected")
   ```
   plus `consumedInviteActionRef` and `lastCallStateRef` (both refs, always fresh).

> ⛔ **`sip.callState` is captured from the render closure that registered these
> handlers and can be STALE by fire time.** It must never be the only signal. A
> naive fix using it would look correct and silently do nothing.

### ⛔ Rule this establishes

**Any deferred call action must re-verify its precondition at FIRE time.** A check
performed at scheduling time is worthless once the window is seconds long. This is
now the second call regression caused by a timing change; both were invisible until
a real call ran.

---

## 2. iOS had NO last-session-ended safety net (`apps/mobile/src/sip/jssip.ts`)

`nativeCallEndedCleanup()` opened with `if (Platform.OS !== "android") return;` —
so when the last SIP session died without CallKit being told, **the system call
stayed up forever**: green pill, live lock-screen call UI, and an AVAudioSession
the OS still believed was in a call.

Added an iOS branch that ends orphaned CallKit calls via `endAllNativeCalls()`.
It fires only when the **last live session** ended, and **re-verifies liveness
after a 1.2s settle** (`noLiveSessions` callback passed from both call sites, i.e.
`() => this.listSessions().length === 0`) so a back-to-back inbound call can never
be killed by it.

---

## 3. Voicemail multi-select bar (`apps/mobile/src/screens/tabs/VoicemailTab.tsx`)

Mockup was approved by Izzy before any code was written (he asked for that
explicitly). Defects in the old bar:

- Delete rendered **red text/icon on a solid blue pill** (`backgroundColor: VM.primary`
  + `color: VM.red`).
- All three actions were identical solid blue — no hierarchy.
- `selectionButtonText` used `VM.text` (near-black) on blue — a **light-mode
  contrast failure**.

New bar: count chip → Select All → Mark read (the single filled accent) → Mark
unread (outline) → Delete (danger-tinted) → divider → close (ghost). All 36px
icon-only squares with `accessibilityLabel`s. Removed the orphaned
`selectionIconButton` style.

> **Select All operates on `filtered`, never `rows`** — selecting rows hidden
> behind an active filter and then deleting them would destroy voicemails the user
> never saw. Keep it that way.

---

## 4. ⛔ Repo defect: `pnpm-lock.yaml` was out of sync with `package.json`

Two `ios-prod` builds died in 19s at `INSTALL_DEPENDENCIES`:

```
ERR_PNPM_LOCKFILE_CONFIG_MISMATCH  Cannot proceed with the frozen installation.
The current "patchedDependencies" configuration doesn't match the value found in
the lockfile
```

Root `package.json` declared **four** patches; the committed lockfile registered
**one**:

| package.json | committed lockfile |
|---|---|
| `react-native-callkeep@4.3.16` | present |
| `expo-av@16.0.8` | **missing** |
| `expo-modules-core@3.0.30` | **missing** |
| `react-native-screens@4.16.0` | **missing** |

The three SDK 54 patches were added without regenerating the lockfile, so **any
clean checkout of this branch was already unbuildable** — it had simply never been
exercised. Fixed with `pnpm install --lockfile-only` + commit (`0e5207d7`); lockfile
only, no dependency versions changed.

**Adding or removing anything under `pnpm.patchedDependencies` REQUIRES re-locking.**

### Why it stayed hidden — the bigger trap

Builds run from loopcom with `EAS_NO_VCS=1`, which uploads the **working directory
as-is, not the git commit**. The build box held a locally-repaired lockfile, so
build 44 passed. A `git reset --hard` before build 45 restored the stale committed
file and the next build failed instantly.

> ⛔ **A green EAS build is NOT proof that the committed tree builds.** After any
> `git reset --hard` or fresh clone in `/tmp/connect-ios-build`, expect the upload
> to differ from whatever previously built.

---

## Build / release state at handoff

| Build | EAS id | Profile | State |
|---|---|---|---|
| 44 | `3d8103af-1af7-4b54-b85e-15748761764c` | ios-clean | **Verified on device by Izzy** |
| 45 | `27387fbe-ec15-4ed5-a1ea-8b4b3315789d` | ios-prod | Uploaded → ASC build `cb3f9b9d-c08a-4b8a-8469-bc37f13d8f37` → beta review **APPROVED**, live to "Loopcom Testers" |
| — | `b8f65aba…`, `33703ceb…` | ios-prod | Failed (lockfile) — see §4 |

TestFlight groups: **"Loopcom Testers"** (external, `fe508ee6-4a3f-49dd-bf53-858839fa2f06`)
holds builds 45/35/32 with testers `eli.lovi@outlook.com` (INSTALLED),
`izzwgg@gmail.com` (INSTALLED), `fixupusa1@gmail.com` (INVITED).
**"Loopcom Internal"** (`05cc8b74-42b0-469a-bce1-6c60881038f4`) has only
`iw5626644@gmail.com`, still INVITED / never accepted.

External groups need Beta App Review per build; internal needs none but testers
must be App Store Connect **users** (an account change — owner's call, not an
agent's).

---

## Diagnostic recipes (use as-is; each cost real time to find)

- **`voiceDiagEvent` is the primary iOS call-bug tool — read it FIRST.** It named
  this root cause in one query. Pull the last N minutes over SSH:
  ```
  db.voiceDiagEvent.findMany({ where: { createdAt: { gte: <cutoff> } }, orderBy: { createdAt: "asc" } })
  ```
- **EAS build logs are BROTLI, not gzip** (`file` reports plain "data").
  `eas build:list --platform ios --limit 1 --json` → `logFiles[0]` → `curl` →
  `zlib.brotliDecompressSync`. The log names the failing phase precisely.
- **Poll a build by its EXPLICIT id, never `--limit 1` / "newest".** A poll firing
  before the new build registers reads the PREVIOUS build's status and reports a
  phantom failure. This happened here and cost a wasted retry.
- `eas build:view` **rejects** `--non-interactive`; `build:list` accepts it.
- ASC API from loopcom: mint an ES256 JWT from
  `/root/.appstoreconnect/AuthKey_QL5RMY8675.p8` (Key `QL5RMY8675`, Issuer
  `c7b93db6-da90-460c-ba20-10d76f015a40`). Helper left at `/tmp/asc-lib.mjs`.
  Note `GET /v1/builds/{id}/relationships/betaGroups` can read back **empty right
  after a successful 204 assign** — verify from the group side
  (`/v1/betaGroups/{id}/builds`) instead.

---

## Process notes from this session

- **Do not call a failure "transient" without reading the log.** I did, and burned
  a build retrying an error that was 100% reproducible. The log named it instantly.
- Izzy asked for a **mockup before any UI code** — honour that for visual work.
- Owner's standing bar: proof before builds, one behavioural change at a time,
  and nothing that already works may break.

---

## Open items

1. **SIP socket churn — still unexplained.** The socket rebuilds ~3× per second on
   wake (`WS_CONNECTED`/`WS_DISCONNECTED` bursts). Builds 43/44/45 make calls
   *survive* it; the churn itself is the underlying fault and remains undiagnosed.
   Both fixes so far treat the symptom.
2. **Two-way contact sync** (phone address book ↔ app) — never started; a real
   subsystem, not a quick fix.
3. **Android is still on the old toolchain** — must build from `feat/ai-agent`
   until the Android SDK 54 upgrade lands (`android-build-broken-sdk54`).
4. **App Store release** still needs listing screenshots, privacy policy URL, the
   App Privacy questionnaire, and a reviewer demo account.
5. Other agent's registration-hardening commit `20ca197b` still needs device proof.
