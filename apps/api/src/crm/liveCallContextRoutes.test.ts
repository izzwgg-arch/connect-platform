import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const routeSource = readFileSync(join(process.cwd(), "src/crm/liveCallContextRoutes.ts"), "utf8");

test("live-call context route requires CRM access", () => {
  assert.match(routeSource, /requireCrmAccess\(req, reply\)/);
});

test("live-call context route scopes contact and call data by tenant", () => {
  assert.match(routeSource, /where:\s*\{\s*id: resolvedContactId,\s*tenantId/);
  assert.match(routeSource, /where:\s*\{\s*linkedId,\s*tenantId/);
  assert.match(routeSource, /where:\s*\{\s*tenantId,\s*contactId: resolvedContactId/);
});

test("live-call context route enforces contact access before returning data", () => {
  assert.match(routeSource, /assertCrmContactAllowed\(user, resolvedContactId, reply\)/);
});

test("live-call context route does not unlock non-CRM phonebook contacts", () => {
  assert.match(routeSource, /matched_contact_not_in_crm/);
  assert.match(routeSource, /if \(!contact\?\.crmMeta\)/);
});

test("live-call context route returns tenant-scoped transcript data", () => {
  assert.match(routeSource, /crmCallTranscript\.findUnique/);
  assert.match(routeSource, /where:\s*\{\s*tenantId_linkedId:\s*\{\s*tenantId,\s*linkedId/);
  assert.match(routeSource, /transcriptAvailable:\s*transcript\?\.status === "COMPLETED"/);
  assert.match(routeSource, /formatTranscript\(transcript\)/);
});
