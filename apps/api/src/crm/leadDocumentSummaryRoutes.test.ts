import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(dir, "..", "..", "..", "..");

function readRoute(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

const routesSource = readRoute("apps/api/src/crm/leadIntelligenceRoutes.ts");
const serviceSource = readRoute("apps/api/src/crm/leadDocumentSummaryService.ts");
const portalSource = readRoute("apps/portal/components/crm/contact/ContactDocumentSummary.tsx");

test("document-summary route uses requireCrmAccess and assertCrmContactAllowed", () => {
  const block = routesSource.slice(
    routesSource.indexOf('app.get("/crm/contacts/:id/document-summary"'),
    routesSource.indexOf('app.get("/crm/contacts/:id/intelligence"'),
  );
  assert.match(block, /requireCrmAccess\(req, reply\)/);
  assert.match(block, /assertCrmContactAllowed\(user, id, reply\)/);
});

test("document-summary route returns sanitizeSummaryForResponse", () => {
  const block = routesSource.slice(
    routesSource.indexOf('app.get("/crm/contacts/:id/document-summary"'),
    routesSource.indexOf('app.get("/crm/contacts/:id/intelligence"'),
  );
  assert.match(block, /sanitizeSummaryForResponse/);
  assert.doesNotMatch(block, /textExtraction\.text/);
});

test("leadDocumentSummaryService masks SSN at response boundary", () => {
  assert.match(serviceSource, /maskSsnFromDigits/);
  assert.match(serviceSource, /sanitizeSummaryForResponse/);
  assert.doesNotMatch(serviceSource, /console\.log.*ssn/i);
});

test("leadIntelligenceService strips SSN from persisted documentProfile", () => {
  const intelSource = readRoute("apps/api/src/crm/leadIntelligenceService.ts");
  assert.match(intelSource, /stripSsnFromAiDocumentProfile/);
});

test("portal ContactDocumentSummary fetches document-summary endpoint", () => {
  assert.match(portalSource, /document-summary/);
  assert.match(portalSource, /Verified CRM fields/);
  assert.match(portalSource, /From imported documents/);
  assert.match(portalSource, /All phones on file/);
});

test("portal documents SSN masking notice without reveal control", () => {
  assert.match(portalSource, /SSN is masked/);
  assert.doesNotMatch(portalSource, /reveal|show full|unmask/i);
});
