# ⛔⛔ AGENT HANDOFF — REMOTE DESKTOP IS BUILT END TO END: own computers unattended, Connect ID + password app-to-app, sound and mic follow you (2026-09-02) — READ FIRST before touching `apps/api/src/remoteDesktop*`, `RemoteDesktopHost`, the `remoteDesktop` preload key, `setExternalMicrophoneStream`, or before "simplifying" the machine-key identity

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_REMOTE_DESKTOP_BUILD_2026-09-02.md`**
(`698fafa1` on `feat/ivr-migration-takeover`. Built exactly to the approved mockups
<https://claude.ai/code/artifact/8796c75d-4089-431a-874a-b93265a647e8>, both themes.
Deploy state: ✅ **api DEPLOYED and container-verified** — `app-api-1` `.build-commit` = `d4fa4836` (⊇ `698fafa1`, merge-base-verified; another session's tip carried it), 0 restarts, migration `20260902120000_remote_desktop` applied **2026-09-02 12:51:05Z** and read back (`RemoteDesktopMachine` 0 rows, `RemoteDesktopShare` 0 rows, the four new `RemoteSupportSession` columns present), `remoteDesktop/` + `hashMatchedAny` grepped in the container. **Live probes** with role-bucket tokens against `127.0.0.1:3001`: ordinary USER → `/me` 200 `canUseRemoteDesktop:true, canConnectById:false`, `/machines` 200 `[]`; poll without a key **400 `machine_key_required`**, with a bogus key **403 `machine_key_mismatch`**; connect-by-id without the key **403 `missing_connect_permission`**; SUPER_ADMIN from a browser UA **403 `desktop_app_required`**, from the app UA **401 `invalid_id_or_password`**; no token **401**; **0 rows written by any probe**. ✅ **portal DEPLOYED and bundle-verified** — `app-portal-1` = `4eb5bd03` (⊇ `698fafa1`), 0 restarts; shipped CSS carries `rd-stage-grid`, the server tree has `remote-desktop/{page,session,this-computer}`, client chunks carry `remoteDesktopSetup` (3), "Allow Remote Desktop to this computer" (2) and `workspace.remote_desktop`; `/remote-desktop` + `/remote-desktop/this-computer` **200 on both hostnames**. ⛔ Both deploys ran through ANOTHER session's `deploy-direct` runs (the branch tip they shipped contains this commit) — my own runs died on the heavy-job lock, which is the correct outcome. ⛔ The GitHub-401 trap held: the server clone fetches only through the `/root/connect-mirror.git` bundle route; origin URL restored to GitHub afterwards. Desktop installer
**`apps/desktop/release/Connect-Setup-0.1.17-rc.4.exe`** (100,298,040 bytes,
sha256 `cef67ffcbe0f4053…`, `FileVersion 0.1.17-rc.4` / `Loopcom LLC`, `verify:icon`
OK, built from a **clean `git archive` export of the commit** — ⛔ NOT installed on
any machine and ⛔ NOT published to the update feed; both are Izzy's.)
Memory: [[remote-desktop-built-end-to-end]] (supersedes [[remote-desktop-mockups-only]]).
Izzy: *"Approved, start building exactly like the mock-ups dark and light end-to-end,
production-ready, stress-tested the fuck out of, ready to start using … do not stop
until that's done."*

- ⛔⛔ **THE MACHINE IS ITS KEY, NEVER ITS USER.** An own-computer session has the
  SAME person on both ends, so the support engine's target/requester split cannot
  say who is calling. Each install mints a 32-byte `machineKey` + `deviceId` once
  (settings.json); every machine-side call carries `x-machine-key`; the server
  stores `sha256(deviceId + NUL + key)` and `decideDesktopParticipation` compares
  it against THIS session's machine only. A colleague's key, a wrong key, a key
  for another machine, or a signed-in colleague with no key — all nobody (403).
  Proven by the attack suite with the same user on both ends.
- ⛔⛔ **THE REMOTE COMPUTER'S USERNAME AND PASSWORD NEVER REACH A SERVER.** Typed
  in the connect sheet → sessionStorage for ONE read → a `login` frame over the
  encrypted peer channel → `remote-desktop:verify-login` in the desktop MAIN
  process → scrypt against `settings.remoteDesktop.accessLogin` → the verdict back
  over the channel; `POST …/login-result` carries `ok` / `attemptsLeft` / `locked`
  and nothing else, and the transcript renders a COUNT. Five wrong tries lock the
  machine 15 minutes (persisted before the verdict returns). **The screen is
  attached only after the verdict** — three transceivers pre-allocated with no
  tracks, one offer/answer, then `replaceTrack`; ⛔ never `addTrack` after the
  offer (a renegotiation the other side is not built for). Guarded in
  `remoteDesktopWiring.test.ts` (all 8 fail replayed against HEAD).
- ⛔⛔ **CONNECT BY ID: ONE ANSWER FOR EVERY MISMATCH.** No such id, wrong
  password, other company on a company-only password, expired, used, revoked —
  `401 invalid_id_or_password`, identical text. Only facts about the CALLER are
  specific (no key → 403 `missing_connect_permission`; a browser → 403
  `desktop_app_required`, judged on the `Loopcom/<ver>` user agent — a product
  rule, the password + scope + lockout are the security). Five guesses lock the ID
  15 min; **a spent-but-correct password is NOT a guess** — the stress suite found
  49 losers of a one-time race locking the machine for everybody, so the counter
  moves only when the password hashes to NO share on that machine. One-time
  passwords are consumed with a guarded `updateMany` (20-way and 50-way races →
  exactly one session). Passwords compare case/dash/space-insensitively and are
  hashed with the share id; shown ONCE. Scope default = company; `allowMic` and
  `allowClipboard` default OFF for someone else.
- ⛔⛔ **THE SECOND FLEET GATE, same shape as remote support:**
  `DesktopSettings.remoteDesktopEnabled` (absent = OFF) → `main.ts` passes
  `--connect-remote-desktop=1` → `preload.ts` publishes `connectDesktop.remoteDesktop`;
  when off the key is ABSENT (`...(remoteDesktopEnabled() ? {remoteDesktop} : {})`),
  never a stub — `RemoteDesktopHost` is mounted in `providers.tsx` for EVERY
  signed-in user and registers + polls every 5 s the moment it sees the key, and
  it ALSO requires `windowKind === "full"` (the mini is a proxy with no phone
  engine). `remoteDesktopSetup` is published always (it polls nothing).
  Turning ON needs a login to exist (`no_access_login` refuses server-side too),
  takes effect at the next launch; turning OFF stops a running session now.
  `fleetGate.test.ts` guards both gates. ⛔ **An update changes nothing for anybody
  until a tray switch is flipped — `RemoteDesktopMachine` has 0 rows.**
- ⛔ **AUDIO.** System sound only as Electron `loopback` (what the computer PLAYS,
  never a microphone), only when the renderer recorded `remote-desktop:allow-audio`
  for a session the server granted `sound`; the display-media handler's other path
  stays `audio: undefined`, and `loopbackWithMute` is forbidden (the person at the
  machine keeps hearing their own computer). The viewer's mic reaches the remote
  SIP phone through `useSipPhone.setExternalMicrophoneStream` — ONE
  `acquireMicStream()` serves dial / answer / answerSession and a live call gets
  `replaceTrack` on its sender; it is a no-op on proxy windows (a MediaStream
  cannot cross IPC). ⛔ No virtual audio driver ships (decision A step 1): the mic
  reaches the remote LOOPCOM, not every program.
- ⛔⛔ **THE WINDOWS LOCK SCREEN IS NEITHER BYPASSED NOR TYPEABLE — the mockups'
  decision D said typing works and that was WRONG** (the secure desktop takes
  input from SYSTEM/UIAccess only). The machine reports `locked` via
  `powerMonitor`; the card reads "Windows is locked", the stage shows a black
  picture with a note, the setup page says someone must unlock it at the computer.
  Loopcom never stores or types Windows passwords.
- ✅ **What rides the support engine unchanged:** the kill switch (rows are
  `RemoteSupportSession` with `kind:"desktop"`, so `controls {enabled:false}` ends
  a live desktop session at its next heartbeat and refuses new ones — and `end`
  never consults it), revocations, `RemoteSupportSignal` relay + backlog cap,
  `recordEvent` transcript (10 new codes, count/label only), `decideMediaBudget`
  (rule 15: only the MACHINE may say a call is up), request rate. One live
  session per machine (a second connect supersedes the first).
- ✅ **The page shipped with its toggles:** nav `workspace.remote_desktop` on
  `can_use_remote_desktop` (END_USER bucket, also the page gate); action keys
  `can_connect_by_id` + `can_share_own_computer` (TENANT_ADMIN extra); rule
  `{ prefix: "/remote-desktop", permission: null }` — ⛔ gating the prefix on a key
  403s every machine's own poll (the `/voice/diag` lesson). `permissionToggleCoverage`
  passes.
- ✅ **Proven:** api 218/218 across `remoteDesktop/{policy,attack,stress}` + the
  remote-support suites (attack = real Fastify + faithful fake db; stress = 100
  machines, 50-way connect, 50-way one-time race, 200-guess storm, 400-signal
  flood, 600-session lapse sweep, 40-session heartbeat storm); desktop 171/171;
  portal 511/513 (the two documented pre-existing); typechecks shared/desktop/portal
  0, api 0 in edited files. ⛔ Two defects the suites caught pre-ship: the
  spent-password lockout, and a `{toString}` object reaching scrypt as a password.
- ⛔⛔ **THE SHARED-TREE HAZARD BIT AGAIN AND WAS CAUGHT BEFORE THE PUSH:** `git add
  <path>` on `preload.ts`, `remoteSupport/mainWiring.ts` and api
  `remoteSupport/controls.ts` staged ANOTHER SESSION'S in-flight elevated-injector
  work (`ElevatedInputInjector`, `enableElevatedControl`, an `admin` capability).
  Found by grepping the staged diff for words I never wrote. Rebuilt through a
  private index (HEAD + only my hunks, reconstructed in Python), CAS `update-ref`,
  then `git reset -- <my paths>` so their hunks read unstaged again. **Grep every
  staged diff for a word you did not write before committing.** The installer was
  built from a `git archive` export with `node_modules` junctions — a tree build
  would have shipped their untested injector under the Loopcom name.
- ⏳ **NOT PROVEN, and it is the whole gap: no session has run between two
  machines, no login has been typed, no sound or mic has moved, and nobody has
  opened any of the three screens.** Acceptance is §8 of the handoff (two PCs:
  set the login, quit + reopen, connect, wrong password ×5 → locked, sound and
  mic both ways, a share password from a colleague's app and its refusal from a
  browser, Stop on the banner, the kill switch). ⛔ The negative that matters
  most: a machine with the switch OFF must produce **zero** `/remote-desktop/*`
  traffic and no `RemoteDesktopMachine` row.
