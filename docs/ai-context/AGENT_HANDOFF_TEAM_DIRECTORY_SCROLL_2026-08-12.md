# AGENT HANDOFF — the Team Directory cut its own list off, with no way to scroll (2026-08-12)

**Status: FIXED, DEPLOYED, container-verified and verified over public HTTPS.**
Portal only. Nothing touching call routing, the PBX, billing or the API.

- Fix commit: **`504ec6ed`** on `feat/ivr-migration-takeover` — one file,
  `apps/portal/app/globals.css`, 25 insertions / 4 deletions.
- Shipped inside portal deploy of tip **`5330620d`** (2026-08-13 ~02:02 UTC /
  2026-08-12 ~22:02 ET), `app-portal-1` rebuilt and cut over.
- ⛔ The commit was authored by a **different session** that found the change
  sitting uncommitted in the shared working tree and committed it as-is (its
  message says so). Same tree, several agents — see §7.

---

## 1. What was reported

Izzy, in the Windows desktop app:

> "Team directory is not scrolling in the Windows app. … when tab is not in
> full screen."

One bug, not two. The clarification is the whole diagnosis: **it only fails when
the window is not maximised.**

## 2. Root cause — the page opted out of scrolling and never opted back in

`apps/portal/app/globals.css` (~line 15246) strips scrolling from the page
wrapper for a short opt-in list of screens:

```css
.console-content:has(> .ch-shell),
.console-content:has(> .vm-shell),
.console-content:has(> .td-page),
.console-content:has(> .billing-ws-shell) {
  height: 100%; min-height: 0; max-width: none; padding: 0; overflow: hidden;
}
```

Being on that list is a **contract**: the screen has taken responsibility for
its own scrolling, so its header and footer bands can stay put. `.ch-shell`
(Calls) honours it in three parts:

1. root — `height: 100%; min-height: 0; overflow: hidden; display: flex; flex-direction: column`
2. header / footer bands — `flex-shrink: 0`
3. the middle band — `flex: 1; min-height: 0; overflow-y: auto`

The Team Directory had part 2 only (`.td-status-bar` was already
`flex-shrink: 0`, which is the tell that it was *designed* as a full-height
shell). It was missing 1 and 3:

```css
.td-page   { display:flex; flex-direction:column; min-height:100%; overflow:visible; }
.td-content{ flex:1; padding:16px; }   /* no overflow, no min-height */
```

So: the wrapper clipped, `.td-page` grew past it, and **no element on the page
was a scroller**. Everything below the window edge was unreachable.

⛔ **`min-height: 0` is the part that does the work and the part everyone
omits.** Without it a `flex: 1` child still grows to fit all its content, so it
never becomes a scroller and the parent silently clips instead.

## 3. Why maximising hid it for so long

Nothing about the bug is size-dependent — the *symptom* is. Maximised, the
member list happened to fit inside the window, so there was nothing to scroll
and the screen looked perfect. Shrink the window and the overflow is cut off
with no scrollbar anywhere.

⛔ **Test every screen on that `:has()` list at a short window, never
maximised.** A maximised window proves nothing here.

## 4. Measured, not assumed

The page was rebuilt against the **real** `globals.css` (5,412 rules parsed, so
the whole cascade was in play) and measured in a browser at 1100×700:

| | before | after |
|---|---|---|
| `.console-content` overflow-y | `hidden` | `hidden` |
| `.td-page` scrollable by | 0 | 0 |
| `.td-content` overflow-y | `visible` | **`auto`** |
| `.td-content` scrollable by | **0 px** | **1,425 px** |
| content hanging below the cut | 1,425 px, unreachable | reachable |
| last member's position | y = 2,077 in a 700 px window | fully visible after scrolling |
| status bar visible | **no** | **yes, pinned** |

Total scrollable containers on the page before the fix: **zero**.

## 5. A second defect the fix would have introduced

Making the page scroll exposed the list (table) view's sticky column headers.
`.td-list-wrap` had `overflow-x: auto`, and **`overflow-x: auto` computes
`overflow-y` to `auto` too** — so the wrap was itself a scrollport, and
`position: sticky` pins to the *nearest* scrollport. That wrap never scrolls
vertically, so the headers slid away.

Measured: with `.td-content` scrolled 600 px, the header sat at **y = −523**
(gone). Moving the sideways scroll off `.td-list-wrap` and onto `.td-content`
put it at **y = 77** against a content top of 61 — i.e. pinned at the padding
edge, exactly right.

⛔ **One scrollport per page.** A nested `overflow` wrapper captures any sticky
header inside it.

## 6. The change

Three rules in `apps/portal/app/globals.css`:

```css
.td-page    { height: 100%; min-height: 0; overflow: hidden; }   /* was min-height:100%; overflow:visible */
.td-content { flex: 1; min-height: 0; overflow-y: auto; overflow-x: auto; }
.td-list-wrap { overflow: visible; }                              /* was overflow-x: auto */
```

**Blast radius is exactly one screen** — `td-page` / `td-content` /
`td-list-wrap` appear in only one file,
`apps/portal/app/(platform)/team/page.tsx`.

**Safe to clip:** the detail panel, its backdrop and the toasts are all
`position: fixed`, so `overflow: hidden` on the root does not reach them. This
was checked before adding the clipping, and must be checked before adding
clipping to any other screen.

**Later rules do not undo it:** the only subsequent `.td-page` / `.td-content`
rules (lines ~18147, ~32859, and the light-theme blocks) set background, colour
and padding only.

## 7. Verification chain

Not read off the commit — read out of the running container, then off the
public site:

```
docker exec app-portal-1 cat /app/.build-commit
  -> 5330620db22c5716acac2f0f94633ada9d7e69cc

docker exec app-portal-1 grep -o '\.td-page{[^}]*}'    <built css>
  -> .td-page{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;...}
docker exec app-portal-1 grep -o '\.td-content{[^}]*}' <built css>
  -> .td-content{flex:1;min-height:0;overflow-y:auto;overflow-x:auto;padding:16px}
docker exec app-portal-1 grep -o '\.td-list-wrap{overflow:visible}' <built css>
  -> present;  old '.td-list-wrap{overflow-x:auto}' -> GONE

curl https://app.connectcomunications.com/_next/static/css/2ae66cc1d0a8146c.css
  -> http 200, 1,128,615 bytes, all three rules present
```

## 8. Deploy notes from this run

- An **api deploy was already mid-flight** on the same tip when this started.
  `deploy-direct.sh` fails fast against a running queue job — polled
  `/ops/deploy/status` until `runningCount: 0` (~70 s) before firing.
- Checked first, both clean: stale deploy waiters
  (`ps aux | grep -E "[e]nqueue|[c]ommitHash"`) and the heavy-build lock.
- ⛔ **`pgrep -f "deploy-direct.sh portal"` in an ssh one-liner self-matches**
  and reported `RUNNING` long after the log said `[deploy-portal] done`. The
  log is the truth; the pgrep is a liar. (Documented in CLAUDE.md, hit again.)
- The launching ssh call hangs even with `setsid nohup … & disown` — poll the
  log from a **fresh** connection rather than waiting on the launcher.

## 9. What is NOT proven

⏳ **Nobody has opened the real Team Directory in the real app since the
deploy.** What is proven: the styling behaves correctly when measured against
the actual shipped stylesheet, and that stylesheet is live and being served.
The end-to-end "shrink the window and scroll" check is still outstanding.

⛔ **The desktop app will still show the bug until it is fully closed and
reopened** — it loads the hosted portal, but an already-open window keeps the
old bundle. "It's deployed" without "now restart it" leaves the customer looking
at the identical bug.

## 10. The other three screens — CHECKED, all healthy (2026-08-12)

The Team Directory was the only screen with the defect. Verified by measurement
at a 640 px window, not by reading the CSS:

| screen | scroller | scrolls | reaches bottom row |
|---|---|---|---|
| Voicemail `.vm-shell` | `.vm-feed` | 1,490 px | yes |
| Voicemail detail panel | `.vm-detail` / `.vm-detail-placeholder` | 742 px | yes |
| Billing `.billing-ws-shell` | `.billing-ws-main-scroll` | 1,430 px | yes |
| Calls `.ch-shell` | — | reference implementation | — |

Every parent in both chains clips with **0 px stranded**, i.e. nothing is hidden
behind a clipped container the way `.td-page` was.

Their chains, for reference:

- **Voicemail** — `.vm-shell` (h100/mh0/hidden/flex-col) → `.vm-hero` +
  `.vm-toolbar` (`flex-shrink: 0`) → `.vm-workspace` (`flex:1; min-height:0;
  overflow:hidden`, a 2-column grid) → `.vm-feed` **and** the right-hand
  `.vm-detail` panel, both `min-height: 0; overflow-y: auto`.
- **Billing** — `.billing-ws-shell` (h100/mh0/hidden/flex-col) →
  `.billing-ws-main--wide` → `.billing-ws-toolbar` (`flex-shrink: 0`) +
  `.billing-ws-main-scroll` (`flex:1; min-height:0; overflow-y:auto`), which does
  wrap `{children}` on the success path as well as the loading/error branches.

⛔ **The contract list is exactly these four screens.** The other
`.console-content:has(…)` rules — wallboard, checklist, scripts, voicemail-drops,
forms — set **background only** and never touch `overflow`, so those pages keep
normal page scrolling and are not under this contract.

Two Billing-specific notes for anyone extending it:

- `.billing-ws-main` gets its `flex: 1` from
  `.billing-ws-shell--context-wide .billing-ws-main--wide`, **not** from its own
  rule. A page rendering `.billing-ws-main` without `--wide` loses it.
- `AdminBillingShell` only wraps routes **absent** from its `REBUILT` list.
  Rebuilt pages return a bare `<Suspense>`, so no `.billing-ws-shell` element
  exists, the `:has()` never matches, and `.console-content` scrolls them
  normally. (`<Suspense>` renders no DOM node, which is why the shell is still a
  direct child and the `:has(>)` matches for the non-rebuilt pages.)

Any screen **added** to that list in future must ship all three parts of the
contract in §2, or it arrives with this exact bug.
