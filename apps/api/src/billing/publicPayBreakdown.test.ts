import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { publicInvoiceLines, publicInvoiceTotals } from "./publicInvoiceView";
import { shouldSkipJwtVerification } from "../jwtPublicRouteBypass";

/**
 * The public pay pages gained a per-invoice breakdown and a way to open the
 * invoice itself. These guard the two halves that a unit test of any single
 * function would pass straight through: what the ROUTES include, and what the
 * public projection is allowed to carry.
 */

// ⛔ __dirname, not import.meta — apps/api compiles as CommonJS and
// import.meta is a TS1343 typecheck error here.
const here = __dirname;
const read = (p: string) => fs.readFileSync(path.join(here, p), "utf8").replace(/\r\n/g, "\n");
/** Comments quote the old shapes on purpose — match executable lines only. */
const code = (p: string) =>
  read(p)
    .split("\n")
    .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"))
    .join("\n");

test("the public breakdown never carries line-item metadata", () => {
  const lines = publicInvoiceLines({
    lineItems: [
      {
        type: "EXTENSION",
        description: "Billable extensions",
        quantity: 1,
        unitPriceCents: 3000,
        amountCents: 3000,
        metadata: { extensionIds: ["cme1", "cme2"], suggestedExtensionCount: 4 },
      },
    ],
  });
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(lines[0]).sort(), [
    "amountCents",
    "description",
    "quantity",
    "type",
    "unitPriceCents",
  ]);
  assert.ok(!JSON.stringify(lines).includes("cme1"), "internal ids must not ride an unauthenticated response");
});

test("a missing lineItems relation costs the breakdown, never a throw", () => {
  assert.deepEqual(publicInvoiceLines({}), []);
  assert.deepEqual(publicInvoiceLines(null), []);
  assert.deepEqual(publicInvoiceLines({ lineItems: null }), []);
});

test("publicInvoiceTotals never emits totalCents — every caller already has one", () => {
  const t = publicInvoiceTotals({ subtotalCents: 4000, taxCents: 500, totalCents: 4500 });
  assert.ok(!("totalCents" in t), "a second totalCents here silently overwrites the caller's");
  assert.equal(t.subtotalCents, 4000);
  assert.equal(t.taxCents, 500);
});

test("the combined pay view LOADS the line items (it never used to)", () => {
  const src = code("publicPayRoutes.ts");
  const loader = src.slice(src.indexOf("async function loadInvoicesForMultiPayToken"));
  const body = loader.slice(0, loader.indexOf("\n}"));
  assert.match(body, /lineItems:\s*\{\s*orderBy/, "the combined loader must include lineItems");
});

test("all three public surfaces project the breakdown through the ONE helper", () => {
  const pay = code("publicPayRoutes.ts");
  const link = code("payLinkRoutes.ts");
  assert.ok(pay.includes("publicInvoiceLines("), "publicPayRoutes must use the shared projection");
  assert.ok(link.includes("publicInvoiceLines("), "payLinkRoutes must use the shared projection");
  // and the pay-link row must carry the id the "open invoice" link is built from
  assert.match(link, /invoiceId:\s*inv\.id/, "the pay-link row needs the invoice id");
});

test("the token-scoped PDF routes exist on all three surfaces", () => {
  const pay = code("publicPayRoutes.ts");
  const link = code("payLinkRoutes.ts");
  assert.ok(pay.includes('"/billing/platform/invoices/pay/:token/pdf"'), "single-invoice PDF route");
  assert.ok(
    pay.includes('"/billing/platform/invoices/pay-multi/:token/invoice/:invoiceId/pdf"'),
    "combined PDF route",
  );
  assert.ok(link.includes('"/billing/platform/pay-links/:code/invoice/:invoiceId/pdf"'), "pay-link PDF route");
});

test("⛔ a PDF route only ever serves an invoice its own token names", () => {
  const pay = code("publicPayRoutes.ts");
  const multiPdf = pay.slice(pay.indexOf('"/billing/platform/invoices/pay-multi/:token/invoice/:invoiceId/pdf"'));
  const body = multiPdf.slice(0, multiPdf.indexOf("\n  });"));
  assert.match(
    body,
    /parsed\.invoiceIds\.includes\(invoiceId\)/,
    "a valid token for OTHER invoices must not open this one",
  );
  assert.match(body, /tenantId:\s*parsed\.tenantId/, "and the row must still be tenant-scoped");

  const link = code("payLinkRoutes.ts");
  const linkPdf = link.slice(link.indexOf('"/billing/platform/pay-links/:code/invoice/:invoiceId/pdf"'));
  const linkBody = linkPdf.slice(0, linkPdf.indexOf("\n  });"));
  assert.match(linkBody, /invoiceIds\s*\|\|\s*\[\]\)\.includes\(invoiceId\)/, "pay-link membership check");
});

test("the login-gated PDF route is untouched — it is NOT public", () => {
  const routes = code("routes.ts");
  const idx = routes.indexOf('"/billing/platform/invoices/:id/pdf"');
  assert.ok(idx > 0, "the tenant PDF route still exists");
  const body = routes.slice(idx, idx + 400);
  assert.match(body, /requireTenantBilling/, "it must still require a login");
});

test("every new public PDF path skips the JWT hook", () => {
  // ⛔ A missing bypass entry answers 401 before the handler runs, so the route's
  // own token check never happens and it reads as a broken link.
  for (const p of [
    "/billing/platform/invoices/pay/tok123/pdf",
    "/api/billing/platform/invoices/pay/tok123/pdf",
    "/billing/platform/invoices/pay-multi/tok123/invoice/inv_1/pdf",
    "/api/billing/platform/invoices/pay-multi/tok123/invoice/inv_1/pdf",
    "/billing/platform/pay-links/ABC123/invoice/inv_1/pdf",
    "/api/billing/platform/pay-links/ABC123/invoice/inv_1/pdf",
  ]) {
    assert.equal(shouldSkipJwtVerification(p), true, `${p} must bypass the JWT hook`);
  }
});

test("the PDF disposition switches for a download but defaults to inline", () => {
  const src = code("billingInvoicePdfAccess.ts");
  assert.match(src, /options\?\.download \? "attachment" : "inline"/);
});
