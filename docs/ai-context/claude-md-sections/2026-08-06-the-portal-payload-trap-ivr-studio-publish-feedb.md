# ⛔ AGENT HANDOFF — the portal `.payload` trap + IVR Studio publish feedback (2026-08-06) — READ FIRST before writing ANY portal error message, or for "publish did nothing" / "the error is just a code"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_IVR_STUDIO_PUBLISH_FEEDBACK_2026-08-06.md`**
(commit `62a5e3ac`, on `feat/ivr-migration-takeover` — ✅ **DEPLOYED 2026-08-06**
inside portal `7f7ec541`; portal-only, nothing touching call routing).

- ⛔ **`ApiError` exposes the server's JSON body as `.body` — NOT `.payload`.**
  `.payload` has never existed. Every `e?.payload?.detail` in the portal is
  **dead code** that silently falls through to `e?.message`, which `apiRequest`
  builds from only the `error` and `message` fields and **never `detail`**. So
  the API sends a full explanation plus structured lists and the UI prints a
  bare slug like `prompt_refs_not_in_catalog`. This survives review because the
  chain *reads* correct and nothing fails loudly — the catch var is `any`, so
  there is no crash, no console error, and no type error.
  Correct examples live in the billing, login, and onboarding pages.
  **Triage by which field the dead read targets:** `.payload?.detail` is
  **total loss** (only the slug survives — the customer-visible kind);
  `.payload?.message` is **cosmetic** (`e.message` is built as
  `"<error>: <message>"`, so the sentence still gets through with the slug glued
  on front). ⛔ **A bare `grep .payload` MISLEADS — most hits are legitimate**
  (`admin/call-timeline`, `admin/call-flight`, `ai-trainer`, `useSipPhone.ts`
  and the admin billing components all read `.payload` as a real field on event
  / WS-envelope objects). Only hits **inside a `catch` on a value from
  `apiGet`/`apiPost`** are the bug.
  **Status (swept 2026-08-06):** both IVR pages fixed — studio `62a5e3ac`,
  migration `3fc51bb0` (merged `8b2c29f6`). One instance remains,
  `admin/card-test/page.tsx:40`, and it is the cosmetic kind on a
  super-admin-only screen — not worth a dedicated deploy.
  ⛔ Switching to `.body` is only half the job: where the server sends a code
  with **no `detail`** (`pbx_tenant_not_found`, `forbidden`, …) you still get a
  slug on screen. Map those to plain English, as ivr-studio's
  `PUBLISH_ERROR_TEXT` and ivr-migration's `ERROR_TEXT` do.
- **"It didn't publish" was a 3-second toast.** Success flashed and vanished, so
  admins clicked again — two real publishes 16s apart for *A plus center*. Both
  succeeded; the second was redundant, not harmful, and needed no cleanup.
  Success now leaves a banner up until the next edit (gated on `!dirty`), with
  the `keysWritten` count and the time; 422s render the API's `detail` plus each
  blocking recording translated into a place on screen; the button reads
  "Publishing…" and `publish()` guards re-entry itself, because the warnings
  dialog and the assistant deep-link both call it **without going through the
  button**.
- ⛔ **Not verified in a browser** — typechecked only. After deploy, watch one
  real publish and one deliberate 422.
- Env traps re-confirmed: `apps/portal/tsconfig.tsbuildinfo` is **tracked** and
  dirtied by `tsc` (restore before committing); fresh `.claude` worktrees spawn
  from **stale `main`, which has no IVR Studio at all** — fast-forward onto
  `feat/ivr-migration-takeover` first or the files don't exist; ESLint is not
  configured (`next lint` opens an interactive setup prompt), so typecheck is
  the gate. ⛔ **A worktree was deleted out from under this session mid-task** —
  push early; new customer-facing strings must be added to the page's
  `UI_PHRASES` with byte-exact em-dashes/apostrophes or they never reach Yiddish.
