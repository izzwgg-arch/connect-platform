# AGENT HANDOFF — Remote Desktop is BUILT end to end (2026-09-02)

Commit `698fafa1` on `feat/ivr-migration-takeover`, built to the approved mockups
(<https://claude.ai/code/artifact/8796c75d-4089-431a-874a-b93265a647e8>), both
themes. Mockup-stage handoff (decisions, rejected designs): `AGENT_HANDOFF_REMOTE_DESKTOP_MOCKUPS_2026-09-02.md`.

Izzy, 2026-09-02: *"elevate the remote desktop feature to a new feature to offer my
clients … multiple desktops … log in to somebody else's computer that already has
a Loopcom app, you can make an ID and password … move the microphone and speaker
to the remote computer … a separate page."* Then: *"for somebody that wants
unattended online access to his computer it has to set a username and password.
The ID and password are only from Loopcom to Loopcom app."* Then: *"Approved,
start building exactly like the mock-ups dark and light end-to-end,
production-ready, stress-tested the fuck out of, ready to start using … do not
stop until that's done."*

Deploy state is in §9 (kept current — read it before trusting anything below as live).

## 1. What it is, in one paragraph

A Workspace page, **/remote-desktop**, where a customer (a) reaches one of their
OWN computers running the Loopcom Windows app — unattended, behind a username
and password set on that computer; (b) reaches a colleague's computer with the
computer's permanent **Connect ID** plus a **password the owner issued**,
Loopcom-app-to-Loopcom-app only; and (c) hands out such passwords for the
computer they are sitting at. During a session the remote computer's **sound
plays on the connecting side** and the **connecting side's microphone becomes the
remote Loopcom's microphone**, so a call ringing on the far Loopcom can be
answered from wherever the person sits. The remote computer always shows the
always-on-top banner with Stop. Remote Support (Admin) is untouched and shares
the engine.

## 2. Where everything lives

| Layer | Files |
|---|---|
| Schema | `packages/db/prisma/schema.prisma` — `RemoteSupportSession` += `kind`, `machineId`, `shareId`, `clientAuthenticated`; new `RemoteDesktopMachine`, `RemoteDesktopShare`; migration `20260902120000_remote_desktop` (additive: 4 columns with defaults, 2 tables) |
| Policy (pure) | `apps/api/src/remoteDesktop/policy.ts` — every decision, no db |
| Routes | `apps/api/src/remoteDesktopRoutes.ts` — `/remote-desktop/*`, registered in `server.ts` beside remote support; rule `{ prefix: "/remote-desktop", permission: null }` |
| Engine reuse | `remoteSupport/controls.ts` (`REMOTE_CAPABILITIES` += `sound`, `mic`; kill switch; media budget; rate + signal caps), `remoteSupport/events.ts` (10 new codes), `controlStore`, `RemoteSupportSignal` |
| Desktop | `apps/desktop/src/remoteDesktop/credentials.ts` (scrypt login, lockout, key/id minting), `remoteDesktop/mainWiring.ts` (IPC: identity, set/clear/verify login, enabled, name, connect-id, allow-audio, lock state), `preload.ts` (`remoteDesktopSetup` always; `remoteDesktop` host key behind `--connect-remote-desktop=1`), `main.ts` (flag, tray items, IPC registration, loopback audio, quit teardown), `remoteSupport/mainWiring.ts` + `bannerPreload.ts` (banner desktop mode + in-banner ask), `types.ts` |
| Portal | `services/remoteDesktop.ts` (API client + `RemoteDesktopPeer`), `lib/remoteDesktop.ts` (pure: ids, frames, wording, link grade), `components/RemoteDesktopHost.tsx` (the machine side, mounted in `app/providers.tsx`), pages `app/(platform)/remote-desktop/page.tsx` (screen 1 + connect sheet + share dialog + by-ID card), `remote-desktop/session/[id]/page.tsx` (screen 3), `remote-desktop/this-computer/page.tsx` (screen 5), `.rd-*` block at the end of `globals.css`, nav `workspace.remote_desktop` |
| Permissions | `packages/shared/src/portalPermissions.ts` — `can_use_remote_desktop` (END_USER; also the nav key), `can_connect_by_id`, `can_share_own_computer` (TENANT_ADMIN extra) |
| Tests | api `remoteDesktop/{policy,attack,stress}.test.ts` (glob registered); desktop `remoteDesktop/credentials.test.ts` + extended `remoteSupport/fleetGate.test.ts` (glob registered); portal `lib/remoteDesktop.test.ts`, `lib/remoteDesktopWiring.test.ts` (registered in the `test` list) |

## 3. The rules that shaped it (each is a trap the next person will walk into)

1. **⛔ The machine is its KEY, never its user.** On your own computer both ends
   are signed in as the same person, so the support engine's target/requester
   split cannot say who is calling. Every machine-side call carries
   `x-machine-key` (32 random bytes, minted once per install, kept in
   settings.json); the server stores `sha256(deviceId + NUL + key)` and compares
   against THIS session's machine only. `decideDesktopParticipation` is the one
   place that decides MACHINE vs VIEWER; anyone else is nobody (403).
2. **⛔ The username and password of the remote computer never reach a server.**
   Typed in the connect sheet → sessionStorage for one read → `login` frame over
   the DTLS peer channel → `verify-login` IPC in the desktop main process →
   scrypt compare against settings.json → verdict back over the channel, and
   `POST …/login-result` carries `ok` / `attemptsLeft` / `locked` and nothing
   else. Five wrong tries lock the machine 15 minutes (persisted before the
   verdict is returned, so a crash cannot lose a strike). The transcript renders
   a COUNT, never a username.
3. **⛔ Nothing is shown before the verdict.** The host pre-allocates three
   transceivers (video out, sound out, mic in) with NO tracks, does one
   offer/answer, and `replaceTrack`s the screen in only after `login_result ok`
   (or immediately for a share session, whose password IS the consent). No
   renegotiation anywhere — never `addTrack` after the offer.
4. **⛔ Connect by ID is one answer for every mismatch.** No such id, wrong
   password, other company on a company-only password, expired, used, revoked —
   all `401 invalid_id_or_password` with byte-identical text. Only facts about the
   CALLER are specific (no permission, not the desktop app → 403; locked out →
   429). App-to-app is enforced on the `Loopcom/<ver>` user agent — a product
   rule, not a security boundary; the password + scope + lockout are.
5. **⛔ A spent-but-correct password is NOT a guess.** Found by the stress suite:
   50 people racing one one-time password → 1 winner, 49 losers, and the losers
   were counted as guessers, so the machine's ID locked for everybody in one
   race. `connect-by-id` now increments the failure counter only when the typed
   password hashes to NO share on that machine at all.
6. **⛔ One live session per machine.** A second connect supersedes the first
   (`endedReason: "superseded"`); two viewers never fight over one mouse.
7. **⛔ The kill switch is the support engine's and ends desktop sessions too**
   (rows live in `RemoteSupportSession` with `kind:"desktop"`): a live session dies
   at its next heartbeat, a new one is refused — and `end` never consults it.
8. **⛔ The second fleet gate, same shape as remote support:**
   `DesktopSettings.remoteDesktopEnabled` (absent = OFF) → `main.ts` passes
   `--connect-remote-desktop=1` → the preload publishes `remoteDesktop`; when off
   the key is ABSENT, never a stub. `RemoteDesktopHost` is mounted for every
   signed-in user and does nothing unless that key exists AND `windowKind ===
   "full"` (the window with the SIP engine; the mini is a proxy). Turning ON
   needs a login to exist and takes effect at the next launch; turning OFF stops a
   running session now. `remoteDesktopSetup` is published always — it polls
   nothing and shares nothing.
9. **⛔ Audio.** System sound is captured ONLY as Electron's `loopback` device
   (what the computer plays, never a microphone) and only when the renderer
   recorded `allow-audio` for a session the server granted `sound`; the display
   media handler's other path keeps `audio: undefined`. The viewer's microphone
   becomes the remote SIP phone's mic through
   `useSipPhone.setExternalMicrophoneStream` — one `acquireMicStream()` serves
   dial, answer and answerSession, and a live call gets `replaceTrack` on its
   sender. No virtual audio driver ships (decision A, step 1): the mic reaches the
   remote LOOPCOM, not every program.
10. **⛔ The Windows lock screen is neither bypassed nor typeable.** The mockups'
    decision D said typing on the lock screen works; it does not (secure desktop,
    SYSTEM/UIAccess only). The machine reports `locked` (powerMonitor), the
    machine card says "Windows is locked", the stage shows a black picture with a
    note, and the setup page says someone must unlock it at the computer. Loopcom
    never stores or types Windows passwords.
11. **⛔ Grants come from the door, never the request.** Own computer allows
    everything asked; a share allows only what the owner ticked (`allowControl`,
    `allowSound`, `allowMic` default OFF, `allowClipboard` default OFF); `view` is
    always present; `admin` and `files` are not capabilities here and the UI draws
    them disabled with the reason. A new owner signing in on the same install
    takes the computer and every password the old owner issued is revoked.
12. **⛔ Banner.** Desktop mode says who is connected from where and where the
    sound and mic are; Stop reads "Stop" and consults nothing; the mid-session
    ask lives INSIDE the banner (`banner-answer` IPC) so it can never sit behind a
    window, and "No" is an equal button.

## 4. The screens, as built

- **Home** (`/remote-desktop`): machine cards (status pill = you / online /
  Windows-locked / offline+last seen; access = "Unattended · username set" or a
  warn pill; Connect disabled with a title reason when it would fail; kebab =
  Rename / Share / Remove), "Add another computer" card, Recent connections
  (support sessions included), the by-ID card (reads as a note in a browser or
  without the key), the share card (Connect ID + Copy + Create a password + live
  passwords with Remove). Connect sheet = username, password, monitor, picture,
  three toggles. Share dialog = expiry (once / 24h / standing), scope (company /
  anyone), the four allows, then the ONE-TIME display of the password with Copy
  both.
- **Session** (`/remote-desktop/session/[id]`, fixed full-viewport stage, dark in
  both themes on purpose): Monitor N of M, Sound → here/there, My mic →
  there/here, Clipboard, Send a file (disabled, "Not in this version"),
  Ctrl+Alt+Del (disabled, the Windows reason), Fit/Actual, Full screen, link
  readout with a real "Measuring…" state, Disconnect. Login overlay when the
  handoff is missing or the verdict was wrong (tries left / locked wording).
  Details + Activity rail. Audio note when the far Loopcom rings.
- **This computer** (`/remote-desktop/this-computer`): the switch (disabled until
  a login exists), Connect ID, username/password/confirm, name, and the two honest
  fixed rows (banner always on; lock screen not unlocked).

## 5. Proven, and how

- api: `policy.test.ts` 13, `attack.test.ts` 14 (real Fastify, faithful fake db,
  machine-key header, same-user-both-ends, oracle equality, lockout, one-time
  race ×20, supersede, kill switch, signals, hostile bodies, history, owner
  change), `stress.test.ts` 7 (100 machines, 50-way connect, 50-way one-time race
  across two companies, 200-guess storm over 20 machines, 400-signal flood, 600
  -session lapse sweep, 40-session heartbeat storm). With the remote-support
  suites: **218 / 218**. `events.test.ts`'s transcript-shape guard was extended
  for the five new codes that render a bounded label.
- desktop: `credentials.test.ts` 7; `fleetGate.test.ts` now guards BOTH gates,
  the loopback-only audio rule and the quit teardown; whole suite **164 → 171**.
- portal: `remoteDesktop.test.ts` 9, `remoteDesktopWiring.test.ts` 8 — **all 8 fail
  replayed against HEAD** (`PORTAL_GUARD_ROOT` on a `git archive` of HEAD). Suite
  511 / 513 (the two documented pre-existing).
- typechecks: shared 0, desktop 0, portal 0; api 0 in any edited file (the total
  reads 84–86 — 76 baseline + 8 pre-existing in `remoteSupport/attack.test.ts` /
  `people.test.ts`, untouched here, plus another session's in-flight work).
- ⛔ **Two defects the suites caught before ship**: the spent-password lockout
  (§3.5) and a non-string password reaching scrypt via `toString` (refused now).

## 6. The shared-tree incident, so it is not repeated

`git add <path>` on `preload.ts`, `remoteSupport/mainWiring.ts` and api
`remoteSupport/controls.ts` staged ANOTHER SESSION'S in-flight elevated-injector
work along with mine (`ElevatedInputInjector`, `enableElevatedControl`, an
`admin` capability). Caught by grepping the staged diff for words I never wrote.
The commit was rebuilt through a private index: `git read-tree HEAD`, then for
those three files a Python reconstruction of HEAD + only my hunks
(`%TEMP%/rd-clean/`), `hash-object --path`, `write-tree`, `commit-tree -p <base>`,
`update-ref` with the base as the compare value, then `git reset -- <my paths>`
so the shared index showed their hunks as unstaged again. **Before staging any
file in this tree, `git diff -- <file> | grep` for a word you did not write.**
The desktop installer was then built from a `git archive HEAD` export
(`%TEMP%/rd-build`) with `node_modules` junctions — never from the live tree,
which would have baked their untested injector into a build that carries the
Loopcom name.

## 7. Deliberately NOT built

- A virtual microphone driver (decision A step 2) — the mic reaches the remote
  Loopcom only.
- File transfer, Ctrl+Alt+Del / administrator windows (drawn disabled).
- Browser as the CONNECTING side for own computers (decision E: app-only for now
  — the page itself renders in a browser, the session page would work, but the
  by-ID path refuses and the own-computer path is untested there).
- Wake-on-LAN, session recording, a per-machine audit screen.
- Publishing the desktop build to the fleet feed.

## 8. Acceptance (needs two machines and Izzy)

1. On PC-A (Windows app 0.1.17-rc.4): tray → "Allow Remote Desktop to this
   computer…" → set username/password → switch on → **fully quit and reopen** →
   the machine card shows Online · Unattended · username set, with a Connect ID.
2. On PC-B (any signed-in Loopcom, same account): Connect → username/password →
   the screen appears only after the login; PC-A shows the banner; a wrong password
   says "N tries left"; five wrong ones say locked and the session ends.
3. Sound: play something on PC-A → heard on PC-B; flip "Sound → there" → PC-A
   hears it again. Mic: call PC-A's extension → answer on the far Loopcom from
   PC-B by clicking → the caller hears PC-B's microphone.
4. Share: PC-A → Create a password (24h, company) → on PC-C (a colleague's
   Loopcom app) → Connect by ID → session with only the ticked capabilities; the
   same password from a browser tab is refused with the "open the Loopcom app"
   sentence; a wrong password five times locks the ID.
5. The negatives that matter most: a machine with the switch OFF never registers
   (`RemoteDesktopMachine` has no row for it, no `/remote-desktop/machines/poll`
   traffic), Stop on PC-A's banner ends it within a heartbeat, and
   `POST /admin/remote-support/controls {enabled:false}` ends a live desktop session.

## 9. Deploy state

**2026-09-02, both halves live.**

- **api**: `app-api-1` `.build-commit` = `d4fa4836` (⊇ `698fafa1`, merge-base-verified —
  another session's branch tip carried this commit; my own `deploy-direct api` run died on the
  heavy-job lock, correctly). 0 restarts. Migration `20260902120000_remote_desktop` applied
  12:51:05Z and read back: `RemoteDesktopMachine` 0 rows, `RemoteDesktopShare` 0 rows, the four
  new `RemoteSupportSession` columns present. `remoteDesktop/` and `hashMatchedAny` grepped in
  the container.
- **Live probes** (60–90 s self-signed tokens inside the container, role-bucket USER and
  SUPER_ADMIN, payloads from files — ⛔ the first attempt's inline `-d` JSON was mangled by
  nested-ssh quoting and answered `400 Expected property name`, which is the probe's fault,
  not the route's; `UID` is also a read-only bash variable, so name your variables):
  USER `/me` 200 `canUseRemoteDesktop:true, canConnectById:false, canShareOwnComputer:false`
  (`fromDesktopApp` follows the UA); `/machines` 200 `[]`; `/history` 200 `[]`;
  poll without key **400 `machine_key_required`**; bogus key **403 `machine_key_mismatch`**;
  connect-by-id without the key **403 `missing_connect_permission`** (browser and app alike);
  SUPER_ADMIN from a browser **403 `desktop_app_required`**, from the app UA
  **401 `invalid_id_or_password`**; unknown session **404**; no token **401**.
  **0 rows written by any probe**, 0 api error-level lines attributable (one unrelated
  level-50 line in the window — read it before blaming this feature).
- **portal**: `app-portal-1` = `4eb5bd03` (⊇ `698fafa1`), 0 restarts, deployed by the other
  session's run at 13:03Z. Bundle-verified by STRING: shipped CSS carries `rd-stage-grid`;
  the server tree holds `remote-desktop/{page,session,this-computer}`; client chunks carry
  `remoteDesktopSetup` (3 chunks), "Allow Remote Desktop to this computer" (2) and
  `workspace.remote_desktop` (1). `/remote-desktop` and `/remote-desktop/this-computer`
  answer **200 on both hostnames**; `/api/health` 200 on both.
- **Deploy route**: the GitHub-401 trap held (`could not read Username for
  'https://github.com'` at git-sync). Route used: incremental `git bundle` →
  `scp` → `/root/connect-mirror.git` (already existed; `fetch <bundle> feat:feat`) →
  wrapper script that `set-url origin` to the mirror, runs `deploy-direct.sh`, restores
  the origin URL and echoes an exit marker (poll the LOG, never `pgrep` the script name).
  ⛔ Two sessions were deploying the same branch in the same half hour; the mirror's tip
  was already ahead of my commit both times — check `merge-base --is-ancestor` on the
  mirror before trusting that "their" deploy carried yours.
- **Desktop**: `apps/desktop/release/Connect-Setup-0.1.17-rc.4.exe` (100,298,040 bytes,
  sha256 `cef67ffcbe0f4053…`, `FileVersion 0.1.17-rc.4`, `CompanyName Loopcom LLC`,
  `verify:icon` OK, `dist/remoteDesktop/{credentials,mainWiring}.js` present and
  `ElevatedInput` absent from the built `mainWiring.js`). Built from a `git archive` of
  `698fafa1` in `%TEMP%d-build` with `node_modules` junctions. ⛔ **Not installed on any
  machine, not on the update feed** (`latest.yml` on the server still reads the fleet
  version) — installing over Izzy's running app closes his phone until relaunched, and
  publishing renames every customer's tray switch set; both are his.
