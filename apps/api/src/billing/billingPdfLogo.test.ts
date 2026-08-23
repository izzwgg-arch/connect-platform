import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { generateInvoicePdf, generateReceiptPdf } from "./pdf";

process.env.CREDENTIALS_MASTER_KEY ||= "test-master-key-for-billing-pdf-logo-tests";

const LOGO_PATH = path.join(__dirname, "assets", "loopcom-logo.png");
const PDF_SOURCE = fs.readFileSync(path.join(__dirname, "pdf.ts"), "utf8").replace(/\r\n/g, "\n");

/** Read width/height/bit-depth/colour-type/interlace out of a PNG's IHDR chunk. */
function readPngHeader(file: string) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "not a PNG");
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colourType: buf[25],
    interlace: buf[28],
  };
}

test("the bundled invoice logo is a PDFKit-safe RGBA PNG", () => {
  assert.ok(fs.existsSync(LOGO_PATH), "apps/api/src/billing/assets/loopcom-logo.png is missing");
  const h = readPngHeader(LOGO_PATH);
  // PDFKit cannot embed interlaced PNGs and mishandles 16-bit depths. Alpha
  // (colour type 6) is what lets the chrome wordmark sit on the white page
  // without a plate behind it.
  assert.equal(h.bitDepth, 8, "8-bit depth");
  assert.equal(h.colourType, 6, "RGBA (colour type 6)");
  assert.equal(h.interlace, 0, "non-interlaced");
});

test("the invoice logo is the TAGLINE-FREE wordmark", () => {
  const { width, height } = readPngHeader(LOGO_PATH);
  // Izzy, 2026-08-16: "take away the words 'the AI communications platform' …
  // It should just be the logo." Every Signal Core lockup bakes that tagline in
  // as pixels, and a lockup carrying it is ~4.5:1 (e.g. docs/brand/loopcom/
  // invoice/*.png at 1200x265). The cropped wordmark is ~5.6:1. So the aspect
  // ratio alone tells the two apart — a tagline lockup can never pass this.
  const aspect = width / height;
  assert.ok(aspect > 5.2, `expected the tagline-free wordmark (~5.6:1), got ${aspect.toFixed(2)}:1`);
});

test("pdf.ts points at the Loopcom logo and no longer at the Connect one", () => {
  assert.match(PDF_SOURCE, /"assets", "loopcom-logo\.png"/);
  const executable = PDF_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(executable, /connect-logo\.png/, "the old Connect logo must not be referenced");
});

const baseInvoice = {
  id: "inv_logo_1",
  tenantId: "tenant_1",
  invoiceNumber: "CC-LOGO-001",
  status: "OPEN",
  totalCents: 14000,
  balanceDueCents: 14000,
  amountPaidCents: 0,
  dueDate: new Date("2026-09-07T00:00:00Z"),
  periodStart: new Date("2026-08-01T00:00:00Z"),
  periodEnd: new Date("2026-08-31T00:00:00Z"),
  createdAt: new Date("2026-08-23T00:00:00Z"),
  lineItems: [{ description: "Hosted PBX", quantity: 4, unitPriceCents: 3000, amountCents: 12000, type: "SUBSCRIPTION" }],
  tenant: { name: "Test Tenant", billingSettings: {} },
};

/**
 * The failure this guards is SILENT: logoBuffer() swallows a missing file and
 * renders a text fallback instead, so a wrong filename produces a perfectly
 * valid, logo-less invoice with nothing in any log. PDFKit writes the embedded
 * image's real pixel size into the XObject dictionary, so finding those exact
 * dimensions in the bytes proves the artwork actually made it onto the page.
 */
function assertEmbedsLogo(pdf: Buffer, label: string) {
  const { width, height } = readPngHeader(LOGO_PATH);
  const bytes = pdf.toString("latin1");
  assert.ok(bytes.includes("/Subtype /Image"), `${label}: no image embedded at all`);
  assert.ok(bytes.includes(`/Width ${width}`), `${label}: no image ${width}px wide — the logo did not load`);
  assert.ok(bytes.includes(`/Height ${height}`), `${label}: no image ${height}px tall — the logo did not load`);
}

test("the invoice PDF embeds the Loopcom logo", async () => {
  assertEmbedsLogo(await generateInvoicePdf(baseInvoice), "invoice");
});

test("the receipt PDF embeds the Loopcom logo", async () => {
  const pdf = await generateReceiptPdf(
    { ...baseInvoice, status: "PAID", balanceDueCents: 0, amountPaidCents: 14000, paidAt: new Date("2026-08-23T14:02:00Z") },
    {
      transactionId: "tx_logo_1",
      paymentAmountCents: 14000,
      paymentDate: new Date("2026-08-23T14:02:00Z"),
      paymentMethod: "Visa ending 4242",
      processorReference: "REF-88213",
    },
  );
  assertEmbedsLogo(pdf, "receipt");
});

/**
 * Who the invoice says it is FROM. The legal entity became Loopcom LLC on
 * 2026-08-23 (Izzy's call) and the printed website moved to loopcom.net with it.
 * Read out of the RENDERED TEXT, not the source, because the failure that matters
 * is a customer receiving a bill from the wrong company.
 *
 * PDFKit compresses its content stream, so scanning the raw bytes finds nothing —
 * that is why this goes through pdf-parse, the same way billingReceiptPdfContent
 * does, rather than a latin1 substring search.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PDFParse } = require("pdf-parse") as {
  PDFParse: new (opts: { data: Buffer }) => {
    getText(): Promise<{ text: string }>;
    destroy(): Promise<void>;
  };
};

async function renderedText(pdf: Buffer): Promise<string> {
  const parser = new PDFParse({ data: pdf });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

function assertBillsAsLoopcom(text: string, label: string) {
  assert.match(text, /Loopcom LLC/, `${label}: Bill from must name Loopcom LLC`);
  assert.match(text, /loopcom\.net/, `${label}: the printed website must be loopcom.net`);
  assert.doesNotMatch(text, /Connect Communications/, `${label}: the old entity must not appear`);
  assert.doesNotMatch(text, /connectcomunications\.com/, `${label}: the old website must not appear`);
}

test("the invoice bills as Loopcom LLC from loopcom.net", async () => {
  assertBillsAsLoopcom(await renderedText(await generateInvoicePdf(baseInvoice)), "invoice");
});

test("the receipt bills as Loopcom LLC from loopcom.net", async () => {
  const pdf = await generateReceiptPdf(
    { ...baseInvoice, status: "PAID", balanceDueCents: 0, amountPaidCents: 14000, paidAt: new Date("2026-08-23T14:02:00Z") },
    {
      transactionId: "tx_logo_2",
      paymentAmountCents: 14000,
      paymentDate: new Date("2026-08-23T14:02:00Z"),
      paymentMethod: "Visa ending 4242",
      processorReference: "REF-88213",
    },
  );
  assertBillsAsLoopcom(await renderedText(pdf), "receipt");
});
