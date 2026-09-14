# ⛔ AGENT HANDOFF — adding a card goes through the standard Sola payment page now (2026-08-20) — READ FIRST before touching the customer Payment Methods page, before adding ANY card-entry form, or before mounting `.billing-pay-page` inside the console shell

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(`a3b47816` on `feat/ivr-migration-takeover`, portal-only — no api change, no
migration, no PBX write. **portal DEPLOYED and container-verified 2026-08-20**:
queue job `bb39dfe1`, container `.build-commit` = `7f985399` ⊇ `a3b47816`; the
add-card page chunk ships the STRING "Add a payment card" and **0** payments
chunks still carry `cdn.cardknox.com/ifields`; both hostnames 200. Izzy,
2026-08-20: customers adding a card got "a different add card page, not the one
we use all over the platform" — the standard one is the page with "powered by
Sola" on it.)
Memory: [[add-card-goes-through-the-standard-sola-page]].

- ⛔ **THE RULE: there is ONE card-entry surface on this platform —
  `CardknoxIFieldsForm` + `PaymentTrustBadge` ("Secured & powered by Sola") +
  `pay-invoice.css`. Never hand-roll a second one.** The customer Payment
  Methods page (`apps/portal/app/(platform)/billing/payments/page.tsx`) had its
  own raw CDN-iframe form (`window.getTokens`, `sola-ifield-frame`, ~140 lines
  of style-injection JS) — the exact class the admin one-time-charge drawer was
  already cured of (`billingOneTimeChargeIFields.test.ts`). That page now only
  LISTS cards; "Add a card" is a button to **`/billing/payments/add-card`**, a
  new page rendering the byte-same surface as `/pay/invoice/[token]` and
  saving via the existing `POST /billing/payment-methods/sola/save` (no charge;
  the first card becomes the default, as before).
- ✅ **The shared form's `cardToken` IS a Cardknox SUT** — the pay pages already
  post it as `xSut`, and the save route accepts `xSut`, so no api change was
  needed.
- ⛔ **`pay-invoice.css` unhooks the ROOT scroll via
  `html:has(.billing-pay-page)`** (built for the standalone pay pages, where
  globals.css's `html, body { overflow: hidden }` must be overridden). Any page
  that mounts `.billing-pay-page` INSIDE the console shell must pin html/body
  back with **inline styles** while mounted (inline beats the `:has()` rule
  deterministically; fighting it with CSS specificity is order-dependent and
  fragile). The add-card page does this in an effect with cleanup.
- **Guard tests** extended in `apps/portal/lib/billingOneTimeChargeIFields.test.ts`
  (already in the portal test list — no registration needed): the payments page
  must never again contain `cdn.cardknox.com/ifields` / `window.getTokens` /
  `sola-ifield-frame` / `xCardNum`, and the add-card page must use
  `CardknoxIFieldsForm` + `PaymentTrustBadge` + `pay-invoice.css`. ✅ Proven
  non-vacuous: the pre-change HEAD page carries **10** of the banned markers.
  Portal typecheck **0 errors**.
- ⏳ **NOT PROVEN: nobody has saved a card through the new page in a browser.**
  Acceptance (2 min, needs a signed-in customer login): Billing → Payment
  Methods → "Add a card" → the Sola-branded page renders in the app theme →
  save a card → it appears in Saved cards; the negative: the old inline form is
  gone from the Payment Methods page. ⛔ An already-open portal tab or desktop
  window keeps the OLD bundle until reloaded.
