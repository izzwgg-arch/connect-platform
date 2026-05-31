import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLeadDocumentSummary,
  sanitizeSummaryForResponse,
} from "./leadDocumentSummaryService.js";

const SAMPLE_SSN_DIGITS = "212554321";
const SAMPLE_SSN_FORMATTED = "212-55-4321";

const baseContact = {
  company: "Acme Plumbing",
  phones: [
    { numberRaw: "(512) 555-0100", isPrimary: true, type: "MOBILE" },
    { numberRaw: "512-555-0199", isPrimary: false, type: "OFFICE" },
  ],
  addresses: [
    { street: "100 Main St", city: "Austin", state: "TX", zip: "78701", country: "US" },
  ],
  crmMeta: { timezoneLabel: "Central", timezoneIana: "America/Chicago" },
};

test("buildLeadDocumentSummary includes verified CRM timezone and address", () => {
  const summary = buildLeadDocumentSummary({
    contact: baseContact,
    documentTexts: [],
    discoveredPhones: [],
    aiDocumentProfile: null,
    intelligenceStatus: null,
    intelligenceGeneratedAt: null,
    documentCount: 0,
  });
  assert.equal(summary.verified.timezone?.displayValue, "Central");
  assert.match(summary.verified.businessAddress?.displayValue ?? "", /100 Main St/);
  assert.equal(summary.verified.industry?.displayValue, "Acme Plumbing");
});

test("buildLeadDocumentSummary includes extracted EIN from documents", () => {
  const summary = buildLeadDocumentSummary({
    contact: baseContact,
    documentTexts: [{ fileName: "app.pdf", text: "EIN 98-7654321" }],
    discoveredPhones: [],
    aiDocumentProfile: null,
    intelligenceStatus: null,
    intelligenceGeneratedAt: null,
    documentCount: 1,
  });
  assert.equal(summary.extracted.ein?.displayValue, "98-7654321");
  assert.equal(summary.extracted.ein?.source, "document");
});

test("buildLeadDocumentSummary masks SSN — raw digits absent from JSON response", () => {
  const summary = buildLeadDocumentSummary({
    contact: baseContact,
    documentTexts: [{ fileName: "app.pdf", text: `SSN: ${SAMPLE_SSN_FORMATTED}` }],
    discoveredPhones: [],
    aiDocumentProfile: null,
    intelligenceStatus: null,
    intelligenceGeneratedAt: null,
    documentCount: 1,
  });
  assert.equal(summary.extracted.ssn?.displayValue, "***-**-4321");
  const json = JSON.stringify(summary);
  assert.doesNotMatch(json, /212-55-4321/);
  assert.doesNotMatch(json, /212554321/);
});

test("sanitizeSummaryForResponse redacts non-masked SSN display", () => {
  const bad = buildLeadDocumentSummary({
    contact: baseContact,
    documentTexts: [],
    discoveredPhones: [],
    aiDocumentProfile: null,
    intelligenceStatus: null,
    intelligenceGeneratedAt: null,
    documentCount: 0,
  });
  bad.extracted.ssn = {
    displayValue: SAMPLE_SSN_FORMATTED,
    source: "document",
    confidence: "HIGH",
    documentName: null,
  };
  const safe = sanitizeSummaryForResponse(bad);
  assert.equal(safe.extracted.ssn?.displayValue, "***-**-****");
  assert.doesNotMatch(JSON.stringify(safe), /212-55-4321/);
});

test("buildLeadDocumentSummary lists all contact and discovered phones", () => {
  const summary = buildLeadDocumentSummary({
    contact: baseContact,
    discoveredPhones: [{ phoneNumber: "(512) 555-0300", status: "PENDING" }],
    documentTexts: [],
    aiDocumentProfile: null,
    intelligenceStatus: null,
    intelligenceGeneratedAt: null,
    documentCount: 0,
  });
  assert.equal(summary.phones.length, 3);
  assert.ok(summary.phones.some((p) => p.number.includes("0300") && p.source === "discovered"));
});

test("buildLeadDocumentSummary merges AI documentProfile fields", () => {
  const summary = buildLeadDocumentSummary({
    contact: baseContact,
    documentTexts: [],
    discoveredPhones: [],
    aiDocumentProfile: { revenue: "$2M", creditScore: "710" },
    intelligenceStatus: "COMPLETE",
    intelligenceGeneratedAt: new Date("2026-05-31T00:00:00.000Z"),
    documentCount: 2,
  });
  assert.equal(summary.extracted.revenue?.displayValue, "$2M");
  assert.equal(summary.extracted.revenue?.source, "ai");
  assert.equal(summary.extracted.creditScore?.displayValue, "710");
});

test("buildLeadDocumentSummary flags conflicts between verified and extracted addresses", () => {
  const summary = buildLeadDocumentSummary({
    contact: baseContact,
    documentTexts: [
      { fileName: "lease.pdf", text: "Business address: 999 Other Rd, Dallas, TX 75201" },
    ],
    discoveredPhones: [],
    aiDocumentProfile: null,
    intelligenceStatus: null,
    intelligenceGeneratedAt: null,
    documentCount: 1,
  });
  assert.equal(summary.meta.hasConflicts, true);
});

test("missing extracted fields do not break summary structure", () => {
  const summary = buildLeadDocumentSummary({
    contact: { ...baseContact, company: null, phones: [], addresses: [], crmMeta: null },
    documentTexts: [],
    discoveredPhones: [],
    aiDocumentProfile: null,
    intelligenceStatus: null,
    intelligenceGeneratedAt: null,
    documentCount: 0,
  });
  assert.equal(summary.extracted.ein, null);
  assert.equal(summary.extracted.ssn, null);
  assert.deepEqual(summary.phones, []);
});

test("error strings from summary assembly must not echo raw SSN", () => {
  const err = new Error(`summary failed for tenant (no ${SAMPLE_SSN_FORMATTED} here)`);
  assert.doesNotMatch(err.message, /212554321/);
});
