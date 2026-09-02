# ⛔⛔ AGENT HANDOFF — the Coworker bubble was DEAD: its drag region ate every click, it would have opened the owner console, and it wore a hand-drawn glyph (2026-09-02)

**Commit:** `3a52c370` on `feat/ivr-migration-takeover` (desktop + portal + one script).
**Desktop:** `apps/desktop/release/Connect-Setup-0.1.17-rc.2.exe` — test build, **NOT published** (the fleet feed still reads 0.1.16; the rc installs over the rc.1 on Izzy's workstation and nothing else).
**Portal:** ✅ deployed and container-verified at `3a52c370` (details §7).
**Read first:** `AGENT_HANDOFF_AI_COWORKER_2026-08-31.md` (what the bubble is) and `AGENT_HANDOFF_DESKTOP_REMOTE_SUPPORT_TEST_BUILD_2026-09-01.md` (the rc test-build discipline this rides on).

Izzy, 2026-09-02: *"The widget is dead. It doesn't do anything. Plus, it doesn't have the real Loopcom logo. For the co-workers."*

---

## 1. What was true on his machine before any code was read

`%APPDATA%\@connect\desktop\settings.json` read:

```json
"coworkerWidgetEnabled": true,
"coworkerWidgetPosition": { "x": 2639, "y": 857 }
```

A saved position means the bubble had been **dragged** — so the window existed, rendered, and moved. And `logs/connect.log` (84 KB, plus a 10 MB rotated `.1`) held **zero lines tagged `coworker-widget`** across both files. Not a failure line, not a click line, nothing. That pair of facts is the whole diagnosis: dragging worked, clicking reached nothing, and nothing was logging either way.

## 2. The three defects

### 2a. The click was swallowed by the OS (why it was "dead")

`assets/coworkerWidget.html` made the whole bubble an `-webkit-app-region: drag` handle and then listened for `mousedown`/`mouseup` on that same element to tell a click from a drag. On Windows an app-region drag handle is treated as the window's **caption bar**: the OS handles the press natively and **the renderer never receives mousedown or mouseup on it**. So the click-vs-drag script never ran once, `api.openChat()` was never called, and the bubble was purely a thing you could move. The 2026-08-31 handoff had flagged exactly this as "the riskiest unknown" — it was never tried on a screen.

⛔ **This is not fixable inside the renderer.** No listener on a drag-region element fires. The fix moves the drag out of the OS's hands:

- the renderer (no Node, sandboxed) uses **pointer events with `setPointerCapture`** and reports only `dragStart` / `dragMove` / `dragEnd` over the preload bridge — **no coordinates**, so it cannot place the window anywhere;
- the main process (`widgetWindow.ts`) reads `screen.getCursorScreenPoint()` on a **16 ms timer** while the press is held (⛔ a timer, not a dependency on renderer `pointermove` — once the window moves under the pointer the renderer's client coordinates barely change, so it may see few or no move events), moves the window with `dragTo()` clamped to `workAreaContaining(cursor)` so it can be carried across monitors, and abandons a press with no release after 30 s;
- on release, `isClick(startCursor, cursor)` (the existing 4 px radial slop) decides: click → toggle the chat; drag → persist the position **once** (the old `on("moved")` persist, which fired on every `setPosition`, is gone).

A click on the bubble while the chat is open **closes** it: the chat hides on blur, which fires before the bubble's release, so `BLUR_CLICK_GRACE_MS = 400` treats a release inside that window as "close" rather than "open again". Without that the chat could never be closed from the bubble.

`focusable` stays `true`. That was chosen for app-region drag and is no longer needed for it, but it is the configuration proven to render on Izzy's machine and a bubble you deliberately press taking focus is fine; `showInactive()` still keeps the boot-time appearance from stealing focus.

### 2b. It would have opened the owner console, with a sidebar, in a 400 px popover

`CHAT_ROUTE` was `/assistant?widget=1`. That page is **the SUPER_ADMIN owner console** — provider self-tests, the model picker, the capability list — and it renders inside the full console shell with the sidebar; `?widget=1` is read by nothing. For a customer this is the wrong screen, and for anyone it is unusable at 400 × 580.

Now `CHAT_ROUTE = "/desktop/coworker"`, a new portal page (`apps/portal/app/desktop/coworker/page.tsx`) that renders `<AuthGate><FloatingAssistant docked /></AuthGate>` — **the same assistant every portal page carries in its corner**, not a second chatbot. `docked` means: starts open, no corner bubble rendered, the panel fills the window (`.fa-docked .fa-panel { inset: 0 … }`), the header is the frameless window's drag handle, and Minimize hides the window through `window.coworkerWidget.closeChat()` instead of collapsing to a bubble that does not exist in that window.

Living under `/desktop/` matters: the portal treats a desktop window whose kind is not `"full"` as **passive** — `AuthGate` waits for the main window's token (shared `localStorage`, same origin) instead of bouncing to `/login`, and `sessionExpiry` never redirects it.

### 2c. ⛔⛔ Any unknown desktop window kind ran a FULL SIP PHONE

Found while wiring 2b, and it outranks the bubble: `useSipPhone.ts`'s `isDesktopProxyWindow()` returned `windowKind === "mini"` and **every other kind fell through to `LocalSipPhoneProvider`** — a real JsSIP engine. So the chat popover, kind `coworker-chat`, would have **registered a second phone on the same extension** and rung and answered inside a chat window. The mini-dialer had only ever been safe because it was the one non-full kind that existed.

`isDesktopProxyWindow()` now returns true for `"mini"` **and** `"coworker-chat"`, and `DesktopWindowKind` (desktop `types.ts` and the portal's declaration) carries `"coworker-widget" | "coworker-chat"`. ⛔ **Any future desktop window kind that loads the portal must be added to that proxy check or it becomes a phone.** A proxy window receives no engine state (main fans `phone:engine-event` to full + mini only), which is correct — the chat does not need the phone.

### 2d. The artwork was a hand-drawn SVG glyph

The bubble drew an inline `<path>` infinity in white on a CSS gradient. The **real** logo is the Blue 2B tile Izzy picked on 2026-08-22 — the same artwork as the app's own launcher icon and the Android/iOS icons. `scripts/desktop-coworker-bubble-asset.py` renders `docs/brand/loopcom/icon-refinement-2026-08/new-apps-icons/blue-2b/android-app-icon-512.png` to a 128 px circle (4× supersampled, transparent outside the circle) and embeds it in the html as a `data:image/png;base64` URI (15,239 bytes; the CSP is `img-src data:`). `--check` fails if the embedded bytes drift from a fresh render, are not 128 px, or are not round.

Rendered in headless Chrome at 2× the result is the round blue plate with the white infinity band and transparent corners — what the taskbar icon looks like, in a circle.

## 3. Diagnosability

Both coworker windows now pass through main.ts's `attachConsoleCapture` (`WidgetDeps.attachDiag`), and main logs `bubble shown at x,y`, `bubble moved to x,y`, `chat panel opened`, `bubble click closed the chat`. The dead build was invisible precisely because success and a swallowed click both logged nothing. The check after the rc.2 install:

```
grep -a coworker "%APPDATA%\@connect\desktop\logs\connect.log" | tail
```

A click on the bubble must produce `chat panel opened` (or `bubble click closed the chat`). If the bubble renderer's bridge is missing it logs `console.error: coworker widget: preload bridge missing`.

## 4. Proven

- Desktop **160/160** (147 before; 13 new in `src/coworkerWidget/widgetWindow.test.ts`), typecheck **0**. ⛔ **All 13 fail replayed against HEAD** (the tree at `7b6b2ce2`), run via `git archive HEAD … | tar` into the scratchpad — the source guards read the html with **HTML comments AND JS/CSS comments stripped**, because the file now carries a comment quoting the very `-webkit-app-region: drag` it forbids.
- Portal **487/489** (the two documented pre-existing: `campaignsIndexLayout`, `webrtcSdpDiagnostics`), typecheck **0**; `lib/coworkerChatWindow.test.ts` registered in the portal `test` list, **4 of its 5 guards fail against HEAD** (the fifth pins `/desktop/` as a passive prefix, which was already true).
- `python scripts/desktop-coworker-bubble-asset.py --check` → OK.
- The html rendered by headless Chrome (`--window-size=64,64 --force-device-scale-factor=2`): corner pixel `(0,0,0,0)`, and the image is the Blue 2B mark in a circle (looked at, not inferred).
- `pnpm dist` produced `release/Connect-Setup-0.1.17-rc.2.exe` (see §7 for the verify:icon line).

## 5. ⏳ NOT PROVEN — and it is the whole point

**Nobody has clicked the rebuilt bubble on a real screen.** The failure was a Windows-native input behaviour that no unit test can see; the fix is proven as source guards, a rendered image and a green build, not as a click that opened a chat. **Acceptance, in this order, on Izzy's workstation after installing rc.2:**

1. The bubble shows the round blue Loopcom mark (not a white glyph).
2. Drag it — it follows the cursor and stays where it is dropped; drag it onto the other monitor.
3. **Click it** — the chat popover opens beside it showing the assistant panel (greeting, Report a problem / Suggest a feature), **not** a sidebar, **not** the owner console.
4. Click the bubble again — the chat closes. Click elsewhere — the chat hides.
5. Minimize inside the chat hides it; the next click brings it back where the bubble now is.
6. ⛔ The negatives that matter most: **no second SIP registration** (`pjsip show endpoint T<t>_<ext>_1` still lists the same contacts as before the click — the popover must never register a phone), and the log shows `chat panel opened` for the click.
7. Restart the app: the bubble returns in the same place.

⛔ **Installing rc.2 closes the running app and does not relaunch it** (`/S` silent install; the rc.1 handoff proved this) — the phone is down until Loopcom is started by hand. Do it when a bad minute is affordable:

```bash
"C:/dev/projects/Connect 2/apps/desktop/release/Connect-Setup-0.1.17-rc.2.exe" /S
```

then start Loopcom from the Start menu.

## 6. Open

- **The bubble is still opt-in** (tray → "Show Coworker Bubble"); Izzy's is on. Default-on for customers is his call (2026-08-31 §9 item 2).
- The badge (`setWidgetBadge`) is wired and nothing drives it yet — no unread/working state reaches the bubble.
- `apps/desktop-support` is still not retired (unchanged).
- The chat popover polls whatever every portal window polls (notifications bridge, remote-support pending when enabled) — one more passive window's worth, same as the mini dialer; not measured.

## 7. Deploy state

- **Portal:** ✅ DEPLOYED 2026-09-02 via `deploy-direct.sh portal --branch feat/ivr-migration-takeover` (14 min). Container-verified: `app-portal-1` `.build-commit` = `3a52c370`, 0 restarts, `.next/server/app/desktop/coworker.html` present, `fa-docked` and `coworker-chat` grepped in the shipped client chunks, `https://app.connectcomunications.com/desktop/coworker` and `https://app.loopcom.net/desktop/coworker` both **200**, `/api/health` 200 on both. ⛔ The rc.1 desktop build on Izzy's machine still points its chat at `/assistant` and still has the dead click — the portal half alone changes nothing he can see until rc.2 is installed.
- **Desktop:** `Connect-Setup-0.1.17-rc.2.exe` built on this workstation; NOT installed, NOT published, `latest.yml` untouched (feed stays 0.1.16).
