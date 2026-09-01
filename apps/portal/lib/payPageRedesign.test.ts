import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The customer pay page redesign (2026-08-31).
 *
 * These read SOURCE on purpose. Every defect being fixed here lived in a
 * caller, a stylesheet or a field ORDER — none of it is reachable from a unit
 * test of any one function.
 */

/** PAY_GUARD_ROOT lets these be replayed against a checkout of the pre-change
 *  tree, which is how they are proven non-vacuous. */
const root = process.env.PAY_GUARD_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
/** ⛔ Strip comments before any negative match — the comments deliberately quote
 *  the old broken shapes to explain why they must not come back. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const FORM = "components/billing/CardknoxIFieldsForm.tsx";
const CSS = "app/pay/invoice/[token]/pay-invoice.css";
const PAY_SURFACES = [
  "app/pay/invoices/[token]/page.tsx",
  "app/pay/invoice/[token]/page.tsx",
  "app/p/[code]/page.tsx",
  "app/(platform)/billing/payments/add-card/page.tsx",
];

/* ── the instruction that outranks the design ─────────────────────────────── */

test("⛔ the iFields options are copied across UNCHANGED (Izzy: 'we worked hard to adjust it')", () => {
  const src = read(FORM);
  const start = src.indexOf("const ifieldOptions = useMemo(");
  assert.ok(start > 0, "ifieldOptions must still exist");
  const block = src.slice(start, src.indexOf("[resolvedFieldTheme],", start));

  // Every value that controls what the customer sees INSIDE the processor's
  // iframe. Nothing in our stylesheet can reach in there, so a regression here
  // is invisible until somebody looks at a live card field.
  const required: Array<[string, RegExp]> = [
    ["autoFormat", /autoFormat:\s*true/],
    ["blockNonNumericInput", /blockNonNumericInput:\s*true/],
    ["border", /border:\s*"0"/],
    ["outline", /outline:\s*"0"/],
    ["boxShadow", /boxShadow:\s*"none"/],
    ["appearance", /appearance:\s*"none"/],
    ["WebkitAppearance", /WebkitAppearance:\s*"none"/],
    ["MozAppearance", /MozAppearance:\s*"textfield"/],
    ["fontFamily", /fontFamily:\s*"-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif"/],
    ["fontSize", /fontSize:\s*"14px"/],
    ["fontWeight", /fontWeight:\s*"500"/],
    ["lineHeight", /lineHeight:\s*"46px"/],
    ["padding", /padding:\s*"0"/],
    ["margin", /margin:\s*"0"/],
    ["width", /width:\s*"100%"/],
    ["height", /height:\s*"46px"/],
    ["overflow", /overflow:\s*"hidden"/],
    ["resize", /resize:\s*"none"/],
    ["color", /color:\s*resolvedFieldTheme === "dark" \? "#e5eefb" : "#0f172a"/],
    ["background", /background:\s*"transparent"/],
  ];
  for (const [name, re] of required) {
    assert.match(block, re, `iFields option ${name} was changed — it must be copied verbatim`);
  }
  // and nothing NEW slipped in: 3 top-level options + 18 style keys
  const keys = (block.match(/^\s{6,8}[A-Za-z]+:/gm) || []).length;
  assert.equal(keys, 21, "the iFields options gained or lost a key");
});

test("the detected issuer is never fed back into a live iframe", () => {
  const src = code(read(FORM));
  const cvv = src.slice(src.indexOf("type={CVV_TYPE}"));
  const body = cvv.slice(0, cvv.indexOf("</span>"));
  assert.ok(
    !/\bissuer=/.test(body),
    "passing issuer to the CVV iframe changes a prop mid-entry and can clear a typed CVV",
  );
});

test("⛔ every field box is ONE height — inputs, dropdowns and secure fields alike", () => {
  const css = code(read(CSS));
  // 46px inside the processor's iframe + our 1px border top and bottom = 48px
  // outside. Measured live: all 11 boxes report 48.
  assert.match(css, /--pay-field-h:\s*48px/);
  for (const sel of [
    /\.billing-pay-page \.billing-pay-form input:not\(\[type="checkbox"\]\)/,
    /\.billing-pay-page \.billing-pay-form \.cs-trigger/,
    /\.billing-pay-page \.billing-ifields-host/,
  ]) {
    assert.match(css, sel, "a field kind was left out of the one-height rule");
  }
  // ConnectSelect ships a 36px trigger and globals sizes it to 42 for admin
  // forms; the pay surface must out-specify both.
  assert.match(css, /\.billing-pay-page \.billing-pay-form \.cs-trigger\s*\{[^}]*height:\s*var\(--pay-field-h\)/);
});

/* ── the layout faults ────────────────────────────────────────────────────── */

test("⛔ the two-column checkerboard is gone and does not come back", () => {
  const css = code(read(CSS));
  for (const cls of [
    "billing-field-cardholder",
    "billing-field-email",
    "billing-field-address1",
    "billing-field-address2",
    "billing-ifields-card",
  ]) {
    const re = new RegExp(`\\.${cls}\\s*\\{\\s*grid-column:\\s*[12];`);
    assert.ok(!re.test(css), `${cls} is pinned to a hand-picked column again`);
  }
  assert.match(
    css,
    /\.billing-pay-form\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    "the form must be one column",
  );
});

test("the amount is stated once — the duplicate currency row is gone", () => {
  const css = code(read(CSS));
  assert.ok(!/\.billing-pay-currency/.test(css), "the second copy of the total was removed");
  for (const p of PAY_SURFACES) {
    assert.ok(!/billing-pay-currency/.test(read(p)), `${p} still prints the total twice`);
  }
});

test("card number, expiry and CVV sit together, before the name and address", () => {
  const src = code(read(FORM));
  const card = src.indexOf("billing-ifields-card");
  const cvv = src.indexOf("billing-ifields-cvv");
  const expRow = src.indexOf("billing-pay-row--expiration billing-pay-row--cardline");
  const name = src.indexOf("billing-field-cardholder");
  const address = src.indexOf("billing-pay-address-group");
  assert.ok(card > 0 && cvv > 0 && expRow > 0 && name > 0 && address > 0);
  assert.ok(card < expRow, "the card number comes first");
  assert.ok(expRow < cvv, "the CVV lives inside the expiry row");
  assert.ok(cvv < name, "the card block comes before the name");
  assert.ok(name < address, "the address comes last");
});

test("the supermarket desk's pinned class names all survive", () => {
  // apps/portal/lib/supermarketPortal.test.ts styles these as .sm- descendants.
  const src = read(FORM);
  for (const cls of [
    "billing-ifields-card",
    "billing-pay-row--expiration",
    "billing-ifields-cvv",
    "billing-field-cardholder",
    "billing-field-zip-only",
    "billing-pay-secure-note",
  ]) {
    assert.ok(src.includes(cls), `${cls} is styled by the desk and must not be renamed`);
  }
});

/* ── the breakdown ────────────────────────────────────────────────────────── */

test("⛔ the breakdown is REALLY collapsible — native details/summary", () => {
  const list = read("components/billing/PayInvoiceList.tsx");
  assert.match(list, /<details/, "must be a real disclosure, not a div that looks like one");
  assert.match(list, /<summary>/);
  const css = code(read(CSS));
  assert.match(css, /\.billing-pay-invoice\[open\]/, "the open state must be styled");
  assert.match(css, /summary::-webkit-details-marker\s*\{\s*display:\s*none/);
});

test("all three pay surfaces render the breakdown through the one component", () => {
  for (const p of PAY_SURFACES.slice(0, 3)) {
    assert.match(read(p), /PayInvoiceList/, `${p} must render the shared breakdown`);
  }
});

test("each invoice offers a way to open the invoice itself", () => {
  const list = read("components/billing/PayInvoiceList.tsx");
  assert.match(list, /Open full invoice/);
  assert.match(list, /Download PDF/);
  assert.match(list, /download=1/, "the download link must ask for the attachment disposition");
});

/* ── the logo and the card marks ──────────────────────────────────────────── */

test("the Loopcom wordmark is INSIDE the card on every pay surface", () => {
  for (const p of PAY_SURFACES) {
    const src = code(read(p));
    assert.match(src, /<PayCardTop/, `${p} must use the shared card top`);
    assert.ok(!/billing-pay-logo/.test(src), `${p} still floats the logo above the card`);
  }
  const top = read("components/billing/PayCardTop.tsx");
  assert.match(top, /loopcom-wordmark-560\.png/, "the real wordmark, not a drawing");
});

test("the card brands are vectors, not styled words", () => {
  const badge = code(read("components/billing/PaymentTrustBadge.tsx"));
  assert.ok(!/brand-visa|brand-mastercard|brand-amex|brand-discover/.test(badge), "text brands are gone");
  assert.match(badge, /CardBrandRow/);
  // ⛔ strip comments: the file's own header explains WHY there is no clipPath.
  const marks = code(read("components/billing/CardBrandMarks.tsx"));
  for (const hex of ["#1434CB", "#EB001B", "#F79E1B", "#FF5F00", "#1F72CF", "#F76B1C"]) {
    assert.ok(marks.includes(hex), `${hex} missing — a network mark lost its colour`);
  }
  assert.ok(!/clipPath/.test(marks), "cross-referenced ids collide when a mark repeats on one page");
});

test("the Sola mark is a DIFFERENT vendor file per theme (Izzy, 2026-09-01)", () => {
  const sola = read("components/billing/SolaLogo.tsx");
  // Sola ships the pair themselves; their README forbids recoloring, so dark
  // mode must render the vendor's own reverse file, never a re-tinted copy.
  assert.match(sola, /sola-logo-positive-rgb\.png/, "light mode uses the vendor's positive file");
  assert.match(sola, /sola-logo-reverse-rgb\.png/, "dark mode uses the vendor's reverse file");
  assert.match(sola, /theme === "dark" \? SOLA_DARK : SOLA_LIGHT/, "the theme picks the file");
  const code = sola.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/filter\s*:/.test(code), "never fake the reverse with a CSS filter");
  assert.ok(!/currentColor/.test(code), "never re-tint one file per theme — use both vendor files");
});
