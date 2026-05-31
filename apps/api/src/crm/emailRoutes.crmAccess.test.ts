import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const emailRoutesSource = readFileSync(join(dir, "emailRoutes.ts"), "utf8");
const guardSource = readFileSync(join(dir, "guard.ts"), "utf8");

test("emailRoutes: CRM routes use requireCrmAccess not ad-hoc JWT-only auth", () => {
  assert.match(emailRoutesSource, /requireCrmAccess/);
  assert.doesNotMatch(emailRoutesSource, /async function requireAuth/);
  assert.ok(
    (emailRoutesSource.match(/requireCrmAccess\(req, reply\)/g) || []).length >= 10,
    "expected multiple requireCrmAccess calls",
  );
});

test("emailRoutes: send enforces CRM contact scope", () => {
  assert.match(emailRoutesSource, /assertCrmContactAllowed/);
  const sendBlock = emailRoutesSource.slice(
    emailRoutesSource.indexOf('app.post("/crm/email/send"'),
    emailRoutesSource.indexOf('app.get("/crm/email/templates"'),
  );
  assert.match(sendBlock, /assertCrmContactAllowed/);
});

test("emailRoutes: fleet diagnostics require CRM email settings access", () => {
  assert.match(emailRoutesSource, /diagnostics\/reply-tracking[\s\S]*?requireCrmEmailSettingsAccess/);
});

test("guard: requireCrmEmailSettingsAccess allows platform admin or CRM ADMIN role", () => {
  assert.match(guardSource, /requireCrmEmailSettingsAccess/);
  assert.match(guardSource, /access\.role === "ADMIN"/);
});

test("emailRoutes: oauth callback stays public (no CRM access guard)", () => {
  const callbackBlock = emailRoutesSource.slice(
    emailRoutesSource.indexOf('app.get("/crm/email/oauth/callback"'),
    emailRoutesSource.indexOf('app.delete("/crm/email/connection"'),
  );
  assert.doesNotMatch(callbackBlock, /requireCrmAccess/);
});
