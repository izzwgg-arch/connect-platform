import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildDispositionTimelineMetadata,
  dispositionTimelineTitle,
  mergeLatestPhoneDispositions,
} from "./contactPhoneDisposition.js";

const repoRoot = join(__dirname, "..", "..", "..", "..");

function readRoute(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

test("mergeLatestPhoneDispositions keeps newest row per phone", () => {
  const map = mergeLatestPhoneDispositions([
    {
      phoneId: "p1",
      disposition: "No answer",
      channel: "CALL",
      note: null,
      createdAt: new Date("2026-05-31T10:00:00Z"),
      createdByUserId: "u1",
    },
    {
      phoneId: "p1",
      disposition: "Interested",
      channel: "SMS",
      note: "follow up",
      createdAt: new Date("2026-05-31T12:00:00Z"),
      createdByUserId: "u1",
    },
    {
      phoneId: "p2",
      disposition: "Wrong number",
      channel: "CALL",
      note: null,
      createdAt: new Date("2026-05-31T11:00:00Z"),
      createdByUserId: "u2",
    },
  ]);
  assert.equal(map.get("p1")?.disposition, "Interested");
  assert.equal(map.get("p2")?.disposition, "Wrong number");
  assert.equal(map.size, 2);
});

test("mergeLatestPhoneDispositions ignores rows without phoneId", () => {
  const map = mergeLatestPhoneDispositions([
    {
      phoneId: null,
      disposition: "Global",
      channel: "EMAIL",
      note: null,
      createdAt: new Date("2026-05-31T12:00:00Z"),
      createdByUserId: "u1",
    },
  ]);
  assert.equal(map.size, 0);
});

test("disposition timeline metadata includes phone and channel", () => {
  const metadata = buildDispositionTimelineMetadata({
    disposition: "No answer",
    phoneId: "p1",
    phoneType: "MOBILE",
    phoneNumber: "+15551234567",
    channel: "CALL",
    note: "left vm",
  });
  assert.equal(metadata.disposition, "No answer");
  assert.equal(metadata.phoneId, "p1");
  assert.equal(metadata.phoneType, "MOBILE");
  assert.equal(metadata.phoneNumber, "+15551234567");
  assert.equal(metadata.channel, "CALL");
  assert.equal(metadata.note, "left vm");
});

test("dispositionTimelineTitle formats phone and channel", () => {
  assert.equal(
    dispositionTimelineTitle({ disposition: "Interested", phoneType: "Office", channel: "SMS" }),
    "Disposition (Office · SMS): Interested",
  );
  assert.equal(dispositionTimelineTitle({ disposition: "Callback" }), "Disposition: Callback");
});

test("disposition route enforces CRM contact scope and tenant-scoped phone lookup", () => {
  const source = readRoute("apps/api/src/crm/contactRoutes.ts");
  const block = source.slice(
    source.indexOf('app.post("/crm/contacts/:id/disposition"'),
    source.indexOf('app.post("/crm/contacts/:id/phones"'),
  );
  assert.match(block, /assertCrmContactAllowed/);
  assert.match(block, /crmContactPhoneDisposition\.create/);
  assert.match(block, /phoneId/);
  assert.match(block, /tenantId/);
});

test("GET contact detail enriches phones with latest disposition", () => {
  const source = readRoute("apps/api/src/crm/contactRoutes.ts");
  const block = source.slice(
    source.indexOf('app.get("/crm/contacts/:id"'),
    source.indexOf('app.delete("/crm/contacts/:id"'),
  );
  assert.match(block, /loadLatestPhoneDispositionsForContact/);
});

test("agent in-scope disposition: requireCrmAccess on disposition route", () => {
  const source = readRoute("apps/api/src/crm/contactRoutes.ts");
  const block = source.slice(
    source.indexOf('app.post("/crm/contacts/:id/disposition"'),
    source.indexOf('app.post("/crm/contacts/:id/phones"'),
  );
  assert.match(block, /requireCrmAccess/);
});

test("tenant isolation: phone disposition queries include tenantId", () => {
  const helper = readRoute("apps/api/src/crm/contactPhoneDisposition.ts");
  assert.match(helper, /where: \{ tenantId, contactId/);
});

test("GET /crm/contacts list maps formatContact without passing array index", () => {
  const source = readRoute("apps/api/src/crm/contactRoutes.ts");
  const block = source.slice(
    source.indexOf('app.get("/crm/contacts"'),
    source.indexOf('app.post("/crm/contacts"'),
  );
  assert.doesNotMatch(block, /rows\.map\(formatContact\)/);
  assert.match(block, /rows\.map\(\(c\) => formatContact\(c\)\)/);
});
