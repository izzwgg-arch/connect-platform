import test from "node:test";
import assert from "node:assert/strict";
import {
  extractDocumentProfileFromText,
  formatEinDisplay,
  maskSsnFromDigits,
  mergeDocumentProfileExtractions,
  stripSsnFromAiDocumentProfile,
} from "./documentProfileExtractor.js";

const SAMPLE_SSN_DIGITS = "212554321";
const SAMPLE_SSN_FORMATTED = "212-55-4321";

test("formatEinDisplay normalizes EIN", () => {
  assert.equal(formatEinDisplay("123456789"), "12-3456789");
});

test("maskSsnFromDigits masks all but last four", () => {
  assert.equal(maskSsnFromDigits(SAMPLE_SSN_DIGITS), "***-**-4321");
});

test("extractDocumentProfileFromText finds EIN", () => {
  const ext = extractDocumentProfileFromText("Federal EIN: 12-3456789 for Acme LLC");
  assert.equal(ext.ein?.normalized, "12-3456789");
});

test("extractDocumentProfileFromText finds SSN with label (digits internal only)", () => {
  const ext = extractDocumentProfileFromText(`Owner SSN: ${SAMPLE_SSN_FORMATTED}`);
  assert.equal(ext.ssnDigits, SAMPLE_SSN_DIGITS);
});

test("extractDocumentProfileFromText finds revenue and credit score", () => {
  const ext = extractDocumentProfileFromText(
    "Annual revenue: $1.2 million\nCredit score: 720",
  );
  assert.match(ext.revenue?.normalized ?? "", /\$1\.2M|\$1,200,000/);
  assert.equal(ext.creditScore?.normalized, "720");
});

test("extractDocumentProfileFromText separates business and home addresses", () => {
  const ext = extractDocumentProfileFromText(
    "Business address: 100 Main St, Austin, TX 78701\nHome address: 55 Oak Lane, Round Rock, TX 78664",
  );
  assert.match(ext.businessAddress?.normalized ?? "", /100 Main St/);
  assert.match(ext.homeAddress?.normalized ?? "", /55 Oak Lane/);
});

test("stripSsnFromAiDocumentProfile removes ssn keys", () => {
  const stripped = stripSsnFromAiDocumentProfile({
    ein: "12-3456789",
    ssn: SAMPLE_SSN_FORMATTED,
    SSN: SAMPLE_SSN_FORMATTED,
    revenue: "$500K",
  });
  assert.equal(stripped?.ein, "12-3456789");
  assert.equal("ssn" in (stripped ?? {}), false);
  assert.equal("SSN" in (stripped ?? {}), false);
});

test("mergeDocumentProfileExtractions prefers higher confidence", () => {
  const merged = mergeDocumentProfileExtractions([
    { fileName: "old.pdf", text: "Industry: Retail" },
    { fileName: "new.pdf", text: "Industry: Construction" },
  ]);
  assert.equal(merged.industry?.normalized, "Construction");
});

test("extractDocumentProfileFromText never appears in mask helper output as raw", () => {
  const masked = maskSsnFromDigits(SAMPLE_SSN_DIGITS);
  assert.doesNotMatch(masked, /212-55-4321/);
  assert.doesNotMatch(masked, /212554321/);
});
