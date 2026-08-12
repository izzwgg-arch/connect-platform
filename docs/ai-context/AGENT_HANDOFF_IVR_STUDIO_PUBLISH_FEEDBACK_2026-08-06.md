# AGENT HANDOFF — IVR Studio publish feedback + the portal `.payload` trap (2026-08-06)

**Commit:** `62a5e3ac` on `feat/ivr-migration-takeover` (pushed to origin).
**Scope:** one file — `apps/portal/app/(platform)/pbx/ivr-studio/page.tsx`.
**Status:** ✅ **DEPLOYED 2026-08-06** (merged to `feat/ivr-migration-takeover`
and shipped inside portal `7f7ec541`; confirmed still present in the live portal
image `0cf18b14` on 2026-08-12). Portal-only; no PBX or API side. Nothing here
changes call routing — it changes what the admin is told.

---

## 1. The reported symptom

Publishing a phone menu looked like it did nothing.

- **On success**: a toast appeared for 3 seconds and vanished. Miss it and the
  screen was identical to before the click, so admins assumed the publish had
  failed and clicked again. Observed live 2026-08-06: **two successful publishes
  16 seconds apart** for tenant *A plus center*, with the owner reporting "it
  didn't publish". Both publishes really ran and really succeeded — the second
  was redundant, not harmful. No cleanup was needed.
- **On failure**: the banner showed a bare error slug, e.g.
  `prompt_refs_not_in_catalog`, with none of the explanation the API sends.

## 2. ⛔ ROOT CAUSE — `ApiError` exposes `.body`, and the page read `.payload`

This is the important finding and it is **repo-wide**, not IVR-specific.

`apps/portal/services/apiClient.ts` defines:

```ts
export class ApiError extends Error {
  status: number;
  body: unknown | null;   // ← the parsed JSON error body lives HERE
}
```

There is no `.payload` property and there never has been. The Studio page was
already *trying* to show the friendly text — it read `e?.payload?.detail` — but
that branch was **dead code**. It silently fell through to `e?.message`, and
`apiRequest` builds that message from only the `error` and `message` JSON
fields:

```ts
const detail = [errCode, errMessage].filter(Boolean).join(": ");
```

It **never reads `detail`**. So the API was sending a full human explanation and
a structured `missing` list on every 422, and the UI threw both away and printed
the slug.

⛔ **Why this survives code review:** `e?.payload?.detail || e?.message` reads
like a correct fallback chain. Nothing fails loudly — no crash, no console
error, and no type error, because the catch variable is `any`. The only
observable is a customer saying "the error doesn't tell me anything."

**Correct-usage examples already in the repo** (all use `.body`): the billing
pages, `app/login/page.tsx`, `app/onboarding/[token]/page.tsx`.

**Triage by which field the dead read targets** — the impact is not uniform:

| dead read | impact |
| --- | --- |
| `e?.payload?.detail` | **total loss.** `e.message` never carries `detail`, so only the slug survives. The customer-visible kind. |
| `e?.payload?.message` | **cosmetic.** `e.message` is built as `"<error>: <message>"`, so the sentence still reaches the user with the slug glued on front. |

⛔ **A bare `grep .payload` over `apps/portal` MISLEADS — most hits are
legitimate.** `admin/call-timeline`, `admin/call-flight`, `ai-trainer`,
`hooks/useSipPhone.ts` and the admin billing components all read `.payload` as a
real field on event / WS-envelope objects, not on an `ApiError`. **Only hits
inside a `catch` on a value from `apiGet`/`apiPost` are the bug.**

⛔ **Switching to `.body` is only half the fix.** Where the server sends a code
with **no `detail`** (`pbx_tenant_not_found`, `nothing_to_copy`, `forbidden`, …),
`.body` alone still leaves a slug on screen. Map those codes to plain English
too — see `PUBLISH_ERROR_TEXT` here and `ERROR_TEXT` in ivr-migration. Also
check whether the 4xx carries structured lists worth rendering (`missing`,
`problems`, `warnings`) rather than discarding them.

## 3. What shipped

All in `ivr-studio/page.tsx`:

1. **Persistent success banner** (`published` state) — replaces the 3-second
   toast. Stays up until the next edit, because every edit path calls
   `setDirty(true)` and the banner renders under `{published && !dirty && …}`.
   It states what the publish means for callers (already live / waiting on a
   number / which number just switched), the `keysWritten` count taken from the
   response body, and the time.
2. **Structured failure banner** (`publishBlocked` state) — renders the API's
   `detail` and lists each blocking recording. Field keys are translated into
   places on screen by `describeMissingSpot()`: `active_prompt` → "the greeting
   on this menu", `opt_3/announce` → "the recording that plays when a caller
   presses 3". For error codes the API returns *without* a `detail`,
   `PUBLISH_ERROR_TEXT` supplies plain English, so no slug can reach a user.
3. **In-flight state** — the button already had `disabled={… || saving || …}`
   but still read "Publish", so nothing looked like it was happening. It now
   reads "Publishing…". `publish()` also guards re-entry itself (`if (saving)
   return`) because the warnings dialog and the assistant deep-link both call it
   **without going through the button**.
4. Fixed the three other `.payload` reads in the same file (first-run setup,
   number switch, number cancel) — same dead branch, same swallowed messages.

## 4. Things that are easy to get wrong here

- **The success banner must not survive an edit.** It is gated on `!dirty`
  rather than cleared by hand. `loadAll()` does not touch `dirty`, so the banner
  correctly survives the reload that follows a "publish and switch".
- **The `missing[]` shape is `{ key, ref, profileType?, reason }`** — set by
  `ivrResolveMissingPromptRefs()` in `apps/api/src/server.ts`. If you add a new
  publish gate, keep that shape or the list renders blank.
- **New customer-facing strings must be registered** in the page's `UI_PHRASES`
  array or they never reach Yiddish Labs. Six were added. Verify with an exact
  string match — em-dashes and curly apostrophes must match byte-for-byte
  between the `t("…")` call and the `UI_PHRASES` entry.
- `apps/portal/tsconfig.tsbuildinfo` **is tracked in git** and gets dirtied by
  running `tsc`. Restore it before committing.
- A fresh `.claude` worktree needs `pnpm install` before typecheck, and these
  worktrees **spawn from stale local `main`, which has no IVR Studio at all** —
  fast-forward onto `feat/ivr-migration-takeover` first or the files won't exist.
- ESLint is **not configured** in this repo; `next lint` drops into an
  interactive setup prompt. Typecheck is the gate.

## 5. Open / not done

- ⛔ **Not deployed.** Portal deploy required before anyone sees this.
- **Not verified in a browser.** The change typechecks and the logic is
  straightforward, but no one has watched a real publish render the new banners.
  Worth one look at a real tenant after deploy — including a deliberate 422
  (point a menu at a recording that isn't in the catalog) to confirm the
  `missing` list renders.
- ✅ **`pbx/ivr-migration/page.tsx` is DONE** — filed as a separate task during
  this session and fixed in `3fc51bb0`, merged to `feat/ivr-migration-takeover`
  as `8b2c29f6`. That session also found a companion bug worth knowing about:
  a `setError` page banner is **invisible while a modal is open**, so a refused
  action looks like the button did nothing. Actions fired from inside a modal
  must render their error inside that modal.
- **One `.payload` instance remains repo-wide:**
  `admin/card-test/page.tsx:40`. It is the *cosmetic* kind
  (`/billing/card-test/start` sends `{error, message}` with no `detail`, so the
  sentence still gets through) on a super-admin-only screen. Low priority — not
  worth a dedicated deploy.

## 6. Environment notes from this session

- ⛔ **Worktrees are being deleted out from under running sessions.** This
  session's worktree (`.claude/worktrees/charming-nightingale-cfff91`) was
  removed by another session mid-task, after the commit but before the docs were
  written. Push early — anything committed but unpushed in a worktree can
  disappear.
- ⛔ **The main tree is edited by several sessions at once.** During this
  session alone, `CLAUDE.md`, `apps/api/src/server.ts`, `schema.prisma`,
  `apps/mobile/src/api/client.ts` and a new migration folder all appeared as
  uncommitted changes belonging to other sessions, and the branch tip moved
  more than once between commands. **Stage explicit paths, never `git add -A`**,
  or you will sweep someone else's work into your commit.
- The branch also diverged locally vs origin twice during the session. Re-check
  `git log` immediately before committing; a snapshot from a few minutes ago
  lies.
