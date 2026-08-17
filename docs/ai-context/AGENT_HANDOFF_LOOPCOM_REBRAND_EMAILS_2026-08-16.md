# AGENT HANDOFF — the Loopcom rebrand reached the product: login, topbar, invite + billing emails, pay pages (2026-08-16)

**All DEPLOYED and container-verified.** Read before any branding work, any email
template work, or before adding a card-entry surface.

Companion: `AGENT_HANDOFF_LOOPCOM_BRAND_ASSETS_2026-08-16.md` (where the assets
came from and why Signal Core won).

---

## 1. The brand name is **Loopcom** — lowercase c

Izzy, 2026-08-16: *"the C from com and LoopCom should be lowercase"*, then
*"We're changing everything to LoopCom, no more Connect Communications."*

⛔ **Customer-facing text says `Loopcom`.** Not LoopCom, not Connect
Communications. A test asserts the invite email contains "Connect
Communications" nowhere in html, text or subject, and another asserts the same
for the billing emails. Internal identifiers (`loopComShell`, `LoopComLogo`) and
code comments still use camel case — that is fine, they are not customer text.

## 2. What is live

| Surface | State |
|---|---|
| `/login` | Loopcom wordmark inside the card + light/dark toggle |
| App topbar | Loopcom wordmark, **one file, both themes** |
| Invite email | Fully Loopcom, light, mobile/Outlook-hardened |
| Billing emails (9) | Loopcom, `billing@loopcom.net`, accent `#22a8ff` |
| 3 public pay pages | Loopcom wordmark; **Apple Pay claim removed** |

⛔ **NOT changed, deliberately** — each needs a decision, not an oversight:
- `apps/api/src/billing/pdf.ts` still says **"Connect Communications, LLC"** —
  the legal entity on invoice PDFs. If the LLC has not been renamed, the
  registered name belongs there and only branding should move.
- `apps/portal/app/(platform)/billing/invoices/[id]` still loads
  `/connect-logo.png` (in-app invoice view, has print styling).
- The favicon, app icons, and the three sibling emails (password created / reset
  / changed) still carry Connect branding and the old blue shell.
- ~50 `Connect Communications` occurrences remain across apps/api, 14 in the
  portal app, 3 in portal components, 4 in mobile, 1 in shared.

## 3. ⛔ Traps that cost real time here

- **`/login` is client-rendered.** `curl https://app…/login | grep` returns a
  4.8 KB cached shell (`x-nextjs-cache: HIT`) with none of the markup. Grepping
  it for new classes says ABSENT on a **good** deploy, and grepping for the old
  copy says "gone" regardless — a **false positive both ways**. Verify from the
  live stylesheet and the page chunk under `/_next/static/…` instead.
- **The topbar had NO logo in light mode.** The old stylesheet hid it and printed
  the word "Connect" as a text fallback, because the old SVG was
  white-on-transparent. ⛔ Do not reintroduce a per-theme show/hide, and do not
  put a `filter` on `.brand-logo-svg`.
- **Logo sizing is set against the topbar's type, not the bar height.** At 26 px
  the letters ran ~2× the 13 px search placeholder beside them. It is 20 px.
- **The email logo URL is resolved inside `userEmailTemplates.ts`
  (`brandLogoUrl()`), never passed in by callers.** Two paths queue the invite
  email and passing it in is exactly how the Android APK link went missing from
  every self-service sign-up. A test asserts both paths still route through the
  template.
- **`import.meta` is a TS1343 error in apps/api** (CommonJS). Use `__dirname`.
- **The preview panel and artifacts block external images.** A hosted logo will
  not render there; that is the viewer's CSP, not a broken email. Verify the
  `<img>` tag and fetch the URL instead, or inline the image in a preview copy.

## 4. Email rules worth keeping

- ⛔ **`billing@loopcom.net` — the DOMAIN is verified, the MAILBOX is not.**
  `loopcom.net` has full Google MX and serves a site. That does **not** prove the
  `billing@` user exists; Google bounces mail to a non-existent user. Confirm
  before the next invoice goes out.
- The invite shell (`loopComShell`) and the billing shell are **separate on
  purpose** — the billing one is older and better hardened (it has a **VML
  `roundrect`** button; the invite one does not). Do not merge them casually.
- Every gradient sits on a solid `bgcolor`, every layout has an `[if mso]`
  fixed-600px wrapper, and the media query is an **enhancement only** — the
  layout is correct without it ever running.
- ⛔ **Outlook cannot be previewed.** It renders with Word's engine; no browser
  reproduces it. The only proof is sending one. Desktop + phone were verified by
  rendering the real generated HTML in a browser at 1280 and 375 px.

## 5. ⏳ NOT PROVEN

**No one has opened any of these emails in a real inbox** — not Gmail, not
Outlook, not Apple Mail. Everything is proven from generated output, tests and
container greps. Send one invite to a spare address before trusting it in front
of a customer.

Nobody has opened the rebuilt `/login` or the pay pages in a browser either.

## 6. Designed, agreed, NOT built

- **Number-transfer complete email** (added 2026-08-17, awaiting Izzy's pick) —
  the email a customer gets the moment their ported number goes live. Three
  mockups on the billing shell, built from Matamim's real port:
  <https://claude.ai/code/artifact/6cc32750-47dc-401c-a466-b3bb1f15f6b5>
  (A: matches the invoice emails — recommended; B: the number as a large hero;
  C: a four-sentence note).
  ⛔ **The blocker is the CHANNEL, not the copy.** Port completion already
  queues an email today — `[Connect] Port complete: …` from `portLanding.ts` —
  and it is an **`ADMIN_ALERT`, so the send door drops it `ALERTS_MUTED`**
  (Matamim's was dropped 2026-08-17 18:24). A customer email must therefore be a
  **new EmailJob type**, never ADMIN_ALERT, or it will be built and silently
  never send. Keep the internal alert as it is; this is additional.
  ⛔ **All three drafts route support through "reply to this email" on purpose**
  — that sidesteps the unverified-mailbox problem in §4, but only works if
  replies land somewhere a person reads. Open question.
  Conditional content: the texting line needs the tenant to have texting; the
  temporary-number paragraph needs a temp number to have existed (a
  hand-filed port may have none).
- ⛔ **One customer-facing "Connect" survives the rebrand and the tests do not
  catch it**: `billing/emailTemplates.ts:255`, the autopay T-3 reminder subject
  — *"Your **Connect** payment is due in 3 days"*. The guard asserts only that
  **"Connect Communications"** is absent, so a bare "Connect" passes. Found
  2026-08-17, deliberately not changed (customer-facing copy + needs a deploy).
  **Widen the assertion when you fix it**, or the next one slips through too.
- **Voicemail email** — no button, MP3 attached always, transcript when present
  with `dir="rtl"` (**72% of transcripts are Yiddish**), and **no email at all
  when there is no recording**. ⛔ Blocked: the PBX already emails voicemail, so
  Connect can only take over once the PBX one is switched off — a PBX config
  change, and the PBX is read-only for agents.
- **Text-by-email bridge** (`sms@loopcom.net`) — inbound text emails out, the
  recipient hits **Reply**, the reply becomes a text. One thread per customer via
  `References` pinned to a root `Message-ID`; routing by plus-address
  `sms+<token>@`. ⛔ Blocked on Izzy creating the mailbox. ✅ The hard part
  already exists: `apps/worker/src/crmEmailSync.ts` pulls Gmail via API and
  already parses `In-Reply-To`/`References`.
  ⛔ A `mailto:` button cannot carry threading headers — their own sent copy may
  fall outside the thread. Everything **we** send stays threaded regardless.
- **One payment page** — route the 6 other card-entry surfaces at the existing
  Sola checkout. ⛔ `publicPayRoutes.ts` has only `pay/:token` and
  `pay-multi/:token`; **both require an invoice**, so "add a card" needs a
  save-card token + mode. `/admin/card-test` exists precisely because of this
  gap — it makes a $1 invoice to vault a card.
- **Default card + fallback** — ⛔ removing a card clears `isDefault` and
  **nothing promotes a replacement**; Connect Communications currently has an
  active card and **no default**, so autopay cannot charge it. 6 of 18
  card-holding tenants have >1 card; 21 declines have occurred.
  ⛔ **Fall back only on an explicit decline.** A timeout or unknown outcome may
  mean the first charge succeeded — retrying then is how a customer is billed
  twice. Cap at two cards; stop on hard declines (stolen / do not honour).

## 7. Shared-tree note

Work from this session landed inside **other sessions' commits** twice
(`c0fd007b`, `140dec3e`) because another agent ran a blanket `git add` and
committed while my files were staged. Staging explicit paths does not protect
you — **the index is shared too**. Verify with `git log --oneline -- <path>`
afterwards and record the real sha, because the commit message will describe
someone else's work.
