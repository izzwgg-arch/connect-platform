/**
 * Port-queue guards: the package row is built from the answers a real port-in
 * signup writes, and the generated LOA is a real PDF carrying the typed
 * signature. Marking filed is a record-only stamp (route source guard) — it
 * must never touch a carrier.
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildLoaPdf, buildPortQueueRow } from "./portQueue";

const SUB = {
  id: "sub-1",
  companyName: "Weiss Plumbing LLC",
  provisionedDid: "8452195667",
  submittedAt: new Date("2026-08-30T12:00:00Z"),
  uploadedFiles: [{ id: "f1", filename: "verizon-bill-aug.pdf", kind: "bill" }],
  answers: {
    phone: {
      details: {
        numbers: "(347) 555-0182",
        carrier: "Verizon",
        accountNumber: "889912307",
        nameOnAccount: "Weiss Plumbing LLC",
        serviceAddress: "30 Robert Pitt Dr",
        serviceCity: "Monsey",
        serviceState: "NY",
        serviceZip: "10952",
        isMobile: true,
        portPin: "4417",
        loaSignature: "Sender Weiss",
      },
    },
    provisioning: {
      temporaryDid: "8452195667",
      portFiling: { provider: "signalwire", status: "awaiting_manual_filing", portedDid: "3475550182", requestedAt: "2026-08-30T12:01:00Z" },
    },
  },
};

test("buildPortQueueRow assembles the whole filing package from a real port-in shape", () => {
  const row = buildPortQueueRow(SUB)!;
  assert.equal(row.status, "awaiting_manual_filing");
  assert.equal(row.portedDid, "(347) 555-0182");
  assert.equal(row.temporaryDid, "(845) 219-5667");
  assert.equal(row.carrier, "Verizon");
  assert.equal(row.loaSignature, "Sender Weiss");
  assert.equal(row.isMobile, true);
  assert.ok(row.serviceAddress.includes("Monsey") && row.serviceAddress.includes("10952"));
  assert.deepEqual(row.files, [{ id: "f1", filename: "verizon-bill-aug.pdf", kind: "bill" }]);
});

test("a submission with NO portFiling block (new-number or VoIP.ms-era port) is not in the queue", () => {
  assert.equal(buildPortQueueRow({ id: "x", answers: { phone: {} } }), null);
  assert.equal(buildPortQueueRow({ id: "y", answers: { provisioning: { portFiled: true, portId: "217760" } } }), null);
});

test("the LOA is a real PDF carrying the number, carrier and typed signature", async () => {
  const row = buildPortQueueRow(SUB)!;
  const pdf = await buildLoaPdf(row);
  assert.ok(pdf.length > 800, "non-trivial output");
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
  // pdfkit compresses page streams — read the RENDERED text back (the same
  // pdf-parse check the billing PDFs use; never claim a PDF renders without
  // reading it).
  const { PDFParse } = require("pdf-parse") as {
    PDFParse: new (opts: { data: Buffer }) => { getText(): Promise<{ text: string }>; destroy(): Promise<void> };
  };
  const parser = new PDFParse({ data: pdf });
  const parsed = await parser.getText();
  await parser.destroy();
  for (const needle of ["Letter of Authorization", "Sender Weiss", "Verizon", "889912307", "(347) 555-0182"]) {
    assert.ok(String(parsed.text).includes(needle), `LOA carries ${needle}`);
  }
});

test("mark-filed is a record-only stamp — the route never calls a carrier", () => {
  const src = readFileSync(path.join(__dirname, "provisioningRoutes.ts"), "utf8").replace(/\r\n/g, "\n");
  const start = src.indexOf('app.post("/admin/onboarding/submissions/:id/port-filed"');
  assert.ok(start > 0, "route exists");
  const end = src.indexOf("app.get(", start);
  const body = src
    .slice(start, end)
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  for (const banned of ["fetch(", "signalWire", "voipms", "vms("]) {
    assert.ok(!body.includes(banned), `mark-filed never touches a carrier (${banned})`);
  }
  assert.ok(body.includes('status: "filed"'), "stamps the record");
});
