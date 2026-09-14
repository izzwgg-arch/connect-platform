# ⛔⛔ AGENT HANDOFF — billing ignored the app's own theme, and 22 tenants deleted on the PBX were still alive in Connect (2026-08-12) — READ FIRST before styling ANY portal section, before believing a billing count, before adding a field to the tenant-settings PUT, or for "I deleted it on the PBX and it's still here"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_BILLING_THEME_PBX_ORPHANS_2026-08-12.md`**
(commit `438a5e2e` on `feat/ivr-migration-takeover` — **api + portal DEPLOYED and
container-verified, including a database migration.** First tenant sweep run live
under Izzy's explicit go-ahead: **21 companies closed out, none erased.**)

- ⛔ **THE RULE: no section gets its own palette.** `.cbill` had one, switched on
  `@media (prefers-color-scheme: dark)` — the **operating system's** setting.
  Connect's theme is a user preference written to `<html data-theme>` by
  `useAppContext.tsx:390`, so the two agreed only by luck. Proven live: with the
  app on dark, billing stayed a **white slab** and the page heading went
  dark-on-dark and vanished. Everything structural now aliases `--panel`,
  `--panel-2`, `--text`, `--text-dim`, `--border`, `--accent`, `--success`,
  `--warning`, `--danger`. ⛔ Connect's convention is **bare `:root` is DARK,
  light is opt-in**, so dark overrides are written
  `:root:not([data-theme="light"])` — not `[data-theme="dark"]` — or the first
  paint is wrong before hydration. Status *text* stays hand-tuned per theme:
  the app's raw `--success`/`--warning` are display colours that fail contrast
  as 11px pill text. See [[billing-must-use-connect-theme-tokens]].
- ⛔ **Never infer a date from a falsy value.** A tenant with no billingSettings
  reported day `0`, and `ordinal(0)` does `Number(n) || 1` → "1st" — so **19
  accounts with no billing setup at all rendered as a calm, unstyled "1st"**
  while 15 genuine day-1 accounts got a red pill. The banner said 15; the truth
  was 34. Absent is its own state now.
- ⛔ **Three controls on the customer billing page were decorative** — timezone,
  911 fee, regulatory fee: shown, editable, dirty-marking, and dropped on save.
  **Two server-side gaps**, both silent: `billingTimeZone` was **not in the PUT's
  zod schema** (zod strips unknown keys), and **`per_phone_number` was missing
  from the fee `basis` enum** while being the exact basis onboarding stamps for
  E911 (`per_did` counts only *billable* numbers → zero on first-number-free).
  ⛔ A new metadata field must be **destructured out** of the route input —
  `...pricing` is spread straight into the Prisma upsert. ⛔ The fee validator
  needs the **whole item**; a partial object 400s the entire save.
- ⛔ **`/admin/billing/platform/tenants` had NO `where` clause** — every tenant
  row ever created. 50 against a live PBX of 28, while the sidebar has always
  filtered. That gap *was* the inflated counts on every billing screen.
- ⛔ **Deleting a tenant on VitalPBX only ever removed the directory row.** The
  Connect tenant survived with its users, numbers, history and billing, and its
  `TenantPbxLink` stayed **`LINKED`** pointing at a PBX tenant that no longer
  existed. 22 ghosts, 22 signable user accounts. Now swept — but **timidly**,
  because the trigger is a list fetched from the PBX and a short list makes live
  customers look deleted: only links pointing at an absent PBX tenant (a
  **never-linked** tenant was never on the PBX, so it is left alone); an empty
  or half-size answer is refused; **more than `MAX_AUTO_REMOVALS` (3) does
  nothing and waits for a person**; marking removed destroys nothing; the erase
  is a separate confirmed call that **re-reads the money at deletion time**.
  ⛔ **The PBX check does the real work — the money rule is the second lock.**
  Relax Tires, RSBK and Fixup Group have zero billing history and are real live
  customers; they are safe only because they are still on the PBX.
  See [[pbx-tenant-deletion-must-cascade-to-connect]].
- ⛔ **`ConnectChatThread` was the ONLY tenant relation without `onDelete`**, so
  it defaulted to `Restrict` — one chat thread would have made every tenant
  delete fail on a foreign key. The other 240 cascade. Fixed in migration
  `20260808120000_tenant_pbx_removal`, verified live (`confdeltype = 'c'`).
- **Live result:** billing 50 → **29** companies, missing-a-card 32 → **11**,
  no-real-billing-day 34 → **13**, "Needs you" 57 → **30**. Screen is
  `/admin/pbx/removed-tenants`. ⛔ **Ezra stress test 1 (T101) and Loopcom Demo
  (T102) are still ON the PBX** so the rule correctly kept them; delete them
  there and the sweep follows. "Connect" (T1) is VitalPBX's own system tenant.
- **Env:** ⛔ deploy enqueue field is **`service`**, not `target` (`target`
  answers `invalid_service`, which reads like a broken route). ⛔ `PbxInstance`
  filters on **`isEnabled`**. ⛔ PBX tenants live in **`ombu_tenants`** keyed on
  **`tenant_id`** — not `tenants`/`id`. **SSH and `git push` both work directly
  from the Bash tool here**; no sandbox hop and no bundle route needed.
  `apps/api` carries **72 pre-existing** typecheck errors (this adds none);
  portal clean; billing suite **408 pass / 0 fail**.
- ⏳ **Not proven:** nothing has been **permanently erased** (the 21 sit closed
  out, awaiting per-tenant deletes); the customer page's save has **not** been
  exercised against a real customer — change the timezone or a fee and reload
  before trusting it; and the sweep has **never run unattended** (every run so
  far was over the cap and hand-confirmed).
