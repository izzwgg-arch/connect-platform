# ⛔⛔ AGENT HANDOFF — the brand is **Loopcom** (lowercase c) and it is LIVE on login, the topbar, the invite email, all 9 billing emails and the pay pages (2026-08-16) — READ FIRST before any branding or email-template work, before adding a card-entry surface, or before previewing an email

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_LOOPCOM_REBRAND_EMAILS_2026-08-16.md`**
(commits `140dec3e` → `cf8d16ff`. **api + portal DEPLOYED and container-verified.**)

- ⛔ **Customer-facing text says `Loopcom`** — not LoopCom, not Connect
  Communications. Izzy, 2026-08-16: *"the C from com and LoopCom should be
  lowercase"* and *"we're changing everything to LoopCom, no more Connect
  Communications."* Tests assert "Connect Communications" appears nowhere in the
  invite email or the billing emails. Internal identifiers (`loopComShell`,
  `LoopComLogo`) keep camel case on purpose — they are not customer text.
- ⛔ **`/login` renders CLIENT-SIDE, so `curl …/login | grep` PROVES NOTHING** —
  you get a 4.8 KB cached shell (`x-nextjs-cache: HIT`) with no markup. Grepping
  it for the NEW classes says ABSENT on a good deploy, and grepping for the OLD
  copy says "gone" regardless: **a false positive in both directions.** Verify
  from the live stylesheet and the `/_next/static/chunks/app/login/page-*.js`
  bundle. This cost a wrong "it's missing" report.
- ⛔ **The topbar had NO logo in light mode** — the stylesheet hid it and printed
  the word "Connect" as a text fallback, because the old SVG was
  white-on-transparent. **Never reintroduce a per-theme show/hide, and never put
  a `filter` on `.brand-logo-svg`.** One transparent PNG serves both themes; the
  kit's deep-ink light variant was explicitly rejected.
  Logo height is **20px**, sized against the topbar's own 13px type — at 26px the
  letters ran ~2× the search placeholder beside them.
- ⛔ **The email logo URL is resolved INSIDE `userEmailTemplates.ts`
  (`brandLogoUrl()`), never passed in by callers** — two paths queue the invite
  email and passing it in is exactly how the Android APK link went missing from
  every self-service sign-up. A test asserts both paths still route through the
  template.
- ✅ **THE EMAIL LOGO IS A HOSTED FILE FETCHED ON EVERY OPEN — and it was costing
  81 KB each time (fixed 2026-08-17, `49799cb7`, portal + api DEPLOYED and
  container-verified).** Izzy: *"why is it when I open the email, the logo loads
  like two seconds later"*. **Two causes, and the header one is the trap:**
  ⛔ **nginx served it `Cache-Control: no-store, must-revalidate`** — that header
  belongs to `location /`, which keeps portal HTML fresh so a deploy is never
  stale, and **any static asset without its own location block falls through to
  it.** So the logo was re-downloaded on *every open of every email, forever*.
  Fixed with a dedicated **`location /brand/`** (immutable, 1 year) placed before
  `location /`; the HTML rule is untouched and still `no-store` (verified). Backup
  `/root/nginx-connectcomms-backup-20260817-210131-brandcache.conf`.
  ⛔ **And the email pointed at the PORTAL wordmark** — 560px/81 KB rendered in a
  **168px** slot. Email now uses `loopcom-wordmark-email-336.png` (a true 2×,
  34 KB); **the portal keeps the 560px file.** Measured: first open **81,078 →
  34,458 bytes**, 1.12 s → 0.82 s; repeat opens now cost nothing (and a
  revalidating client gets a **304, 0 bytes**).
  ⛔ **A colour-quantised 9 KB version was built and REJECTED — check the alpha
  channel, not the pixels.** It looked identical, but quantising caps alpha at
  **253**, so the logo would render faintly translucent everywhere — the wrong
  direction on a white background where it already reads soft. `alpha=255 count`
  was **0**. Never judge a logo swap by eye alone.
  ⛔ **Deploy ORDER is load-bearing: portal BEFORE api.** The api commit points
  the template at the new file; ship it first and every email logo 404s. The new
  asset was confirmed 200 + byte-identical by sha256 before the api went out.
- ⛔ **`billing@loopcom.net`: the DOMAIN is verified, the MAILBOX is not.**
  `loopcom.net` has full Google MX and serves a site — that does **not** prove
  the `billing@` user exists, and Google bounces mail to a non-existent user.
  Confirm before the next invoice goes out.
- ⛔ **Apple Pay was claimed on the pay pages and implemented NOWHERE** (zero
  matches for `ApplePay`/`payment-request` in portal or api). Removed. Note the
  Sola SDK *does* ship Apple Pay support — it has simply never been configured,
  so it is enable-able, not impossible.
- ⛔ **Outlook cannot be previewed** — it renders with Word's engine and no
  browser reproduces it. Desktop and phone were verified by rendering the real
  generated HTML at 1280/375px; **Outlook is structural-only until someone sends
  one.** Every gradient sits on a solid `bgcolor`, every layout has an
  `[if mso]` fixed-600px wrapper, and the media query is an enhancement only.
  ⛔ The invite shell and the billing shell are **separate on purpose** — the
  billing one is better hardened (VML `roundrect` button); don't merge them.
- ⛔ **NOT changed, deliberately — each needs a decision:** `billing/pdf.ts` still
  says **"Connect Communications, LLC"** (the legal entity on invoice PDFs — if
  the LLC was never renamed, the registered name belongs there); the favicon, app
  icons and the three sibling emails (password created/reset/changed) are
  untouched; ~50 `Connect Communications` occurrences remain in apps/api alone.
  ✅ **SUPERSEDED 2026-08-23: `billing/invoices/[id]` no longer loads
  `/connect-logo.png`, and the invoice + receipt PDFs carry the Loopcom wordmark**
  — see the invoice/receipt section below. The legal name moved to **Loopcom LLC**
  later the same day, as did the printed website.
- ⏳ **NOT PROVEN: nobody has opened ANY of these emails in a real inbox**, and
  nobody has opened the rebuilt `/login` or the pay pages in a browser. All of it
  is proven from generated output, tests and container greps.
- ⏳ **Designed and agreed but NOT built** (details in §6 of the handoff):
  voicemail email (blocked — the PBX must stop sending its own first, a PBX
  change); text-by-email via `sms@loopcom.net` (blocked on the mailbox; ✅ the
  hard part exists — `crmEmailSync.ts` already pulls Gmail and parses
  `In-Reply-To`/`References`); one payment page (⛔ both checkout routes require
  an invoice, so "add a card" needs a save-card mode — `/admin/card-test` exists
  purely to work around this); default-card + decline fallback (⛔ removing a
  card clears `isDefault` and **nothing promotes a replacement** — one tenant
  currently has a card and no default, so autopay cannot charge it; and **fall
  back only on an explicit decline**, never a timeout, or you bill twice).
