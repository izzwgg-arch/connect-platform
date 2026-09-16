# 2026-09-16 · TELNYX 10DLC REGISTRATION — BUILT + DEPLOYED, LIVE-PROVEN TO "READY TO FILE", NO REAL FILING YET

Full handoff: **`docs/ai-context/AGENT_HANDOFF_TELNYX_10DLC_2026-09-16.md`** (§000 = the build; §00/§0 = design revisions; §2 = Telnyx API facts)

- ✅ **Built end to end** (`85dee5bc` + wiring `34ff3aae`): admin page `/admin/texting-registration`
  (board + per-customer review/file/tracking), customer link `/texting-registration/<token>`
  (Loopcom logo, light/dark, customer EDITS ONLY legal name/type/EIN/IRS address/website + signs;
  carrier wording + account facts LOCKED), server-rendered `/texting-policy/<slug>` (the business's
  own privacy policy + SMS terms), invite email on the Loopcom shell with Izzy's copy
  (regulation → continue using SMS → fill out the 10DLC form → link), "File with Telnyx" that then
  runs brand → verify → campaign → carrier review → attach numbers → live unattended.
- ⛔ EIN = AES-GCM token bound to the registration, destroyed on verification / 14 days. Six keys,
  none default, page SUPER_ADMIN-forced. Separate tables from the wizard's TenantSmsRegistration.
- ⛔ **Charge = a SEPARATE uncharged $24 one-time invoice** (traced: never autopaid, never counts for
  the service cutoff, no email) — NOT a line on the next cycle invoice. Monthly fee/marketing shown nowhere.
- ✅ **Deployed** api `34ff3aae` (migration applied, `TEXTING_REGISTRATION_SWEEP_ARMED`) + portal
  (`06a77e7a`, then a CSS-fix redeploy). ✅ 41 tests incl. 300-customer stress (found+fixed a double-assign race).
  ✅ **Live in the container**: 25 concurrent submits → 1; EIN token has no digits; audited reveal;
  real invite email SENT; token flood 404 + per-IP 429; forged webhooks 401; TENANT_ADMIN 403.
- ⛔⛔ **The real browser found TWO bugs every test missed**: the public form couldn't scroll (portal locks html/body — `.tr-page` is its own scroller now) and ConnectSelect's inline 160px width pushed State into ZIP. Proven in Chrome: light/dark + logo, 10 errors, typed submit → thank-you, board, review page, audited EIN Show, Close.
- ⛔⛔ Worktree hazard: `2acf52b8` swept this module's uncommitted server.ts wiring (origin couldn't
  boot) → `5f279499` took it back → module committed on a private index, re-wired by pathspec,
  shared index re-synced (it showed the new files as deleted).
- ⏳ **NOT PROVEN: no real Telnyx filing** (needs a real EIN, $24) — brand/campaign/assign/charge/
  ready email only ran against the simulated registry; sole-prop PIN on a real phone; a human
  filling the form in a browser. Customer links are on **app.connectcomunications.com**
  (platform canonical origin) — Izzy may want loopcom.net.
