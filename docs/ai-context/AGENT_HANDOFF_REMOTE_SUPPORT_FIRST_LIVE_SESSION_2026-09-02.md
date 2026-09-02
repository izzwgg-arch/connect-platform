# AGENT HANDOFF — the first real remote-support session, and what it found (2026-09-02)

Izzy ran the first session ever through the Connect Windows app on 2026-09-02:
technician side in the portal (`/admin/remote-support`), customer side = his own
workstation on the Landau Home login, sharing the Loopcom window. The session
connected, the screen arrived, the mouse moved. Then he reported, in order:
the person dropdown was empty; the picture froze when he minimised the shared
app; there was no full screen; the cursor was "a plus out of sync with the
mouse"; then a crash dialog in the desktop app; then that Administrator access
could not be selected.

Commits on `feat/ivr-migration-takeover`: `99d14c0e` (people list),
`8c6a79dd` (the four session findings), `e074ad93` (desktop `0.1.17-rc.3`).
Memory: [[remote-support-people-list-asked-a-route-that-never-existed]],
[[remote-support-first-live-session-findings]].

## 1. "Choose a person" was empty — for everyone, always

The page loaded its people from `GET /team/members`. **That route has never
existed in apps/api.** `.catch(() => setPeople([]))` turned the 404 into an
empty dropdown, on every load, since the screen shipped on 2026-08-31. No log
line, no error on screen.

Fix: `GET /remote-support/people` in `apps/api/src/remoteSupportRoutes.ts`,
gated on `can_remote_support`, scoped by exactly the rule
`POST /remote-support/sessions` applies — SUPER_ADMIN sees every non-disabled
person on every approved, live CUSTOMER tenant (never the admin tenant, never a
SUPER_ADMIN row); anyone else sees only their own tenant. Proven live inside
`app-api-1`: SUPER_ADMIN → 200, 63 people across 25 companies; ordinary USER →
403. Guards: `apps/api/src/remoteSupport/people.test.ts` (own fake db — the
attack harness's `where` evaluator throws on a nested `tenant: {…}` filter) and
a source guard in `apps/portal/lib/remoteSupportWiring.test.ts` (fails against
the pre-fix page).

⛔ When a dropdown fed by `apiGet` reads empty, grep apps/api for the route
STRING before anything else.

## 2. The crash dialog — `write EPIPE` in Electron's main process

The dialog (screenshot in the chat) reads *Uncaught Exception: Error: write
EPIPE at afterWriteDispatched … Socket._writeGeneric … Socket._writev*. That
is the desktop app's main process — the phone app's process — writing a mouse
command to the PowerShell input helper after the helper had already exited.

⛔⛔ **The EPIPE is asynchronous.** A write to a pipe whose reader has died does
not throw; it "succeeds", and the error arrives later as an `"error"` EVENT on
the child's stdin. `PowerShellInputInjector.send()` had a `try/catch` around
`write()`, which can never see that event. With no `stdin.on("error")` listener,
Node raises it as an uncaught exception, and Electron shows its crash dialog
over the customer's screen.

Fix (`apps/desktop/src/remoteSupport/inputInjector.ts`):
- `stdin` / `stdout` / `stderr` error listeners; one idempotent `die(reason)`
  funnel so the owner hears about the death exactly once whatever order the
  pipe error, the exit event and a `stop()` arrive in.
- `available` checks `stdin.writable && !stdin.destroyed`, not just `killed` —
  a helper that died on its own leaves `killed` false while the pipe is closed.
- `send()` drops after death; `stop()` is safe to call twice and after death.
- The helper's last stderr (600-char tail) rides along with the exit reason,
  and `mainWiring.ts` logs it through an optional `log` sink. **Why the helper
  died is not known** — antivirus is the documented suspect (PowerShell calling
  `SendInput` on an unsigned app). The stderr tail is how the next one gets
  explained. ⛔ `main.ts` does not yet pass the `log` sink (that file was
  another session's in-flight work at the time); until it does the reason goes
  nowhere. One line in `main.ts`: `log: (l) => diag("remote-support", l)`.
- Spawn is injectable (`SpawnLike`); 4 tests rehearse the death with a fake
  child (`inputInjector.test.ts`), including "no listener would throw here".

## 3. The picture froze when the shared window was minimised

He shared **one window** (the Loopcom app), not a screen. Chromium's window
capture stops delivering frames the moment that window is minimised; the
viewer kept the last frame with a green "Good connection" beside it, which is
indistinguishable from a broken session.

Fix: the viewer listens for the remote video track's `mute` / `unmute` — the
only signal that frames stopped — and shows *"Their picture has paused. They
probably minimised the window they are sharing, or the screen is locked…"*
until frames resume. The consent picker sorts whole screens first, labels them
"— whole screen", and warns that a single window stops updating when
minimised. The default pick was already a whole screen.

## 4. Full screen

A **Full screen / Exit full screen** button on the stage. It targets the
`.rs-stage` section, not the `<video>` — the browser's native video fullscreen
would take the keyboard handlers and the footer (badge, link quality, the
button itself) away from the session. Escape exits as usual.

## 5. "A plus that is out of sync with the mouse"

`.rs-video.is-controllable { cursor: crosshair }`. The technician sees their
own local pointer (the crosshair) AND the customer's real cursor, which is
captured with the screen and arrives a fraction of a second late. Chromium
offers no way to exclude the cursor from `getDisplayMedia` under Electron's
`setDisplayMediaRequestHandler`, so two pointers are unavoidable; the crosshair
is what made the second one read as broken. It is a normal arrow now; the
accent border and the "You can control this computer" badge remain the
affordance. The remaining offset is video latency (encode + network + decode).

## 6. Administrator access cannot be selected — on purpose

The row is drawn as *"Not available in this version"* because ticking it would
change nothing: Windows refuses injected input (`SendInput`) to elevated
windows from a non-elevated process, and the UAC secure desktop is off-limits
to everything but SYSTEM/UIAccess. A selectable checkbox would be a lie.

What it would take, for Izzy's decision:
- **Middle path**: launch the input helper elevated (`Start-Process -Verb
  RunAs`) when the customer grants admin access — one UAC "Yes" on their side
  per session. Elevated apps then accept input. ⛔ Stdin pipes do not cross the
  elevation boundary; the helper needs a named-pipe command channel. Still
  cannot drive the UAC prompt itself or the lock screen.
- **Full path**: a Windows service running as SYSTEM with UIAccess, which this
  version deliberately does not ship (its own installer, signing, audit event,
  technician role).
Neither is built.

## 7. Deploy state

- **api** `99d14c0e` deployed + container-verified (route grepped, live probe).
- **portal**: see the last section of the chat / CLAUDE.md bullet for the
  verified container commit. Judge it by grepping the shipped chunks for
  `Exit full screen`, `picture has paused`, `whole screen`, and the CSS for
  `rs-video.is-controllable{cursor:default`.
- **desktop**: `Connect-Setup-0.1.17-rc.3.exe`, built from a CLEAN WORKTREE at
  `e074ad93` (the shared tree carried another session's uncommitted desktop
  work); `helper_pipe_broken` grepped ×2 inside the packed `app.asar`, exe
  `FileVersion 0.1.17-rc.3`, byte-identical copy on Izzy's Desktop as
  `Loopcom-Setup-0.1.17-rc.3.exe`. **Not published** — the update feed still
  reads 0.1.16. Izzy's workstation was on rc.2 (the other session's coworker
  build) at the time; rc.3 installs over it.

## 8. Deploy trap hit twice today: GitHub 401 on the server's fetch

GitHub answers the server's `git-upload-pack` POST with **401**
(`www-authenticate: Basic realm="GitHub"`) while `info/refs` GET is 200 and the
identical unauthenticated clone works from the workstation — per-IP throttling
of unauthenticated pack downloads from loopcom. The repo is public and the
clone has only `credential.helper cache`. `deploy_common_git_sync` fetches
`origin` unconditionally, so the route is: incremental `git bundle` → `scp` →
bare mirror `/root/connect-mirror.git` → `git remote set-url origin
/root/connect-mirror.git` → `deploy-direct.sh` → **set the URL back**. Two
sessions used this within the same hour and each one's "set it back" broke the
other's in-flight deploy at git-sync. ⛔ Check `git remote get-url origin` and
`ps` for a running deploy before touching either. A GitHub token on the server
would end this; that is a credential only Izzy should place.

## 9. Not proven

- No human has pressed Full screen, seen the paused-picture line, or watched
  the arrow cursor on the new build.
- No session has run on rc.3, so the injector's death path has been rehearsed
  only by the fake child. The acceptance test is a session where the helper
  dies (antivirus, or `Stop-Process` on the `powershell.exe` child): control
  stops, the app stays up, **no dialog**.
- Why the helper died on 2026-09-02 is unknown; the stderr tail exists to
  answer that next time — once `main.ts` passes the `log` sink.
