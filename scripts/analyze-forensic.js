#!/usr/bin/env node
/**
 * Analyze forensic_capture.json from GET /forensic.
 * Usage: node scripts/analyze-forensic.js [path/to/forensic_capture.json]
 * Output: derivedActiveCount, bucketCounts, every non-legitimate activeCallsForensic entry with full fields.
 */

const fs = require("fs");
const path = require("path");

const inputPath = process.argv[2] || path.join(__dirname, "..", "forensic_capture.json");
let raw;
try {
  raw = fs.readFileSync(inputPath, "utf8");
} catch (e) {
  console.error("Cannot read:", inputPath, e.message);
  process.exit(1);
}

let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  console.error("Invalid JSON:", e.message);
  process.exit(1);
}

const forensic = data.forensic || data;
const derivedActiveCount = forensic.derivedActiveCount;
const bucketCounts = forensic.bucketCounts || {};
const activeCallsForensic = forensic.activeCallsForensic || [];

console.log("=== Forensic summary ===\n");
console.log("derivedActiveCount:", derivedActiveCount);
console.log("bucketCounts:", JSON.stringify(bucketCounts, null, 2));

const bad = activeCallsForensic.filter((c) => c.bucket !== "legitimate");
console.log("\n=== Non-legitimate activeCallsForensic count:", bad.length, "===\n");

bad.forEach((c, i) => {
  console.log("--- Bad call", i + 1, "---");
  console.log("  callId:", c.callId);
  console.log("  linkedId:", c.linkedId);
  console.log("  bridgeIds:", c.bridgeIds);
  console.log("  channels:", c.channels);
  console.log("  state:", c.state);
  console.log("  tenantId:", c.tenantId);
  console.log("  bucket:", c.bucket);
  console.log("  whyActive:", c.whyActive);
  console.log("  whyNotMerged:", c.whyNotMerged);
  console.log("  traceNote:", c.traceNote);
  console.log("");
});

const legitimateCount = (bucketCounts.legitimate ?? 0);
const duplicateLeg = bucketCounts.duplicateLeg ?? 0;
const staleOrphan = bucketCounts.staleOrphan ?? 0;
const wrongTenantDuplication = bucketCounts.wrongTenantDuplication ?? 0;
const helperArtifact = bucketCounts.helperArtifact ?? 0;

console.log("=== Leak classification (extra counts by bucket) ===");
console.log("  duplicateLeg:", duplicateLeg);
console.log("  unresolvedBridgeMerge: (same as duplicateLeg in code)");
console.log("  staleOrphan:", staleOrphan);
console.log("  wrongTenantDuplication:", wrongTenantDuplication);
console.log("  helperArtifact:", helperArtifact);
console.log("  legitimate:", legitimateCount);
