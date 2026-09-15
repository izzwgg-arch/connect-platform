# LoopCom Mobile UI: the FULL-PRODUCT MOCKUP PASS is done and AWAITING IZZY'S APPROVAL — nothing production was built, on his explicit instruction — 2026-09-15

Full handoff: **`docs/ai-context/AGENT_HANDOFF_LOOPCOM_MOBILE_UI_2026-09-15.md`** (read it
before building ANY LoopCom Mobile UI — it records the approved-pending IA, every design
decision, and the wiring-gap list).

- **Izzy's verdict on the shipped `/mobile` page: "too sparse, looks like a placeholder."**
  He ordered a complete separate product area (own sidebar section, dashboard, users, lines,
  plans, usage, SEPARATE billing/invoicing, porting, devices/SIMs, support, settings, plus a
  13-view owner console) — ⛔ **with a hard process rule: FULL MOCKUPS FIRST, then STOP for
  his approval, only then production UI.** The stop is part of the instruction; do not
  "helpfully" start building.
- ✅ **The mockup pass is COMPLETE**: 30 clickable screens in ONE self-contained HTML file at
  **`docs/mockups/loopcom-mobile/index.html`**, published as a Claude artifact:
  **https://claude.ai/artifact/JGi8xGn5FnAVPPPJKvdvmt** (private to Izzy). Customer/Owner
  persona toggle, dark/light, desktop/laptop/tablet widths, per-screen design notes with
  wiring tags (wired today / backend exists / needs backend / carrier-gated). Tokens copied
  verbatim from `apps/portal/app/globals.css` (drawer sidebar, billing-card, KPI, pill,
  state-box patterns) so it reads native.
- **Proposed IA (pending approval)**: customer = NEW sidebar section `mobile` "LoopCom
  Mobile" with 10 pages under `/mobile/*`, one permission key per page + a section key (the
  fourth rule); owner = ONE Admin item `/admin/mobile-console` with 13 internal views (the
  PBX-Console pattern — keeps the SUPER_ADMIN Locked toggle singular). API prefixes stay
  `/mobile-service` + `/admin/mobile-service` (⛔ `/mobile/*` API is the phone app's).
- **Honesty carried into the mockups**: Voice = carrier beta chip, SMS = locked until 10DLC,
  E911 gaps surfaced, invoicing screen carries the "not wired into live invoices" banner,
  port submission stays a console act, provision-eSIM keeps its cannot-be-un-bought confirm.
- ⏳ **NOT DONE, by design**: no production UI, no new routes/models, no navConfig change, no
  toggles — all of it waits for approval. The handoff §4 lists the backend work the screens
  need (subscriber model, daily-usage series, invoice persistence LM- series, port
  submission, settings persistence, rollups).
- **v2 (same day, Izzy's first revision round): "more user-friendly, SaaS 2026,
  professional; polish the dashboard; an admin page for ALL settings and controls."**
  Shipped as artifact Version 2 (same URL): a v2 polish CSS layer over the same tokens
  (hero dashboard with greeting + cycle progress + action rail, iconized KPI tiles with
  delta chips, gradient primary buttons, hover depth on cards/quick-actions/line-cards),
  and the admin Settings view rebuilt as **"Settings & Controls"** — master-gate cards up
  top (product ON, voice/SMS/auto-suspend LOCKED with reasons), plus Access & visibility,
  Notifications & recipients, Data & sync, and Maintenance sections. Verified rendered in
  BOTH themes via real Chrome (never the in-app pane). Still ⛔ awaiting approval.
- Repo state: mockup + docs committed and pushed; **no deploy** (docs-only, zero runtime
  files touched).
