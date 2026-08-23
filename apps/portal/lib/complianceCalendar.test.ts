// Guards for the compliance-calendar portal surfaces (2026-08-23).
//
// These read SOURCE on purpose: the defects they pin are wiring — a nav item
// without its SUPER_ADMIN force line, a dashboard that stopped rendering the
// banner, a page that lost its gate. A unit test of any helper passes straight
// through all of those.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const NAV = read(join(__dirname, "..", "navigation", "navConfig.ts"));
const PAGE = read(join(__dirname, "..", "app", "(platform)", "admin", "compliance", "page.tsx"));
const DASH = read(join(__dirname, "..", "app", "(platform)", "dashboard", "page.tsx"));
const BANNER = read(join(__dirname, "..", "components", "dashboard", "ComplianceReminders.tsx"));

test("the nav entry exists and carries the owner-only key", () => {
  assert.match(NAV, /id: "admin\.compliance", href: "\/admin\/compliance"/);
  assert.match(NAV, /id: "admin\.compliance"[^\n]*permission: "can_manage_global_settings"/);
});

test("the nav entry is ALSO SUPER_ADMIN-forced — the key alone is not the fence", () => {
  assert.match(NAV, /item\.id === "admin\.compliance" && backendJwtRole !== "SUPER_ADMIN"\) return false/);
});

test("the page gates on the same key the api's prefix rule demands", () => {
  assert.match(PAGE, /PermissionGate/);
  assert.match(PAGE, /can_manage_global_settings/);
});

test("the page has exactly one default export and it is the gated page", () => {
  const defaults = PAGE.match(/export default function/g) || [];
  assert.equal(defaults.length, 1, "a Next.js page may only export a default component");
});

test("the dashboard renders the banner, and the banner stays until completed", () => {
  assert.match(DASH, /<ComplianceReminders \/>/, "the dashboard must show pending deadlines");
  assert.match(BANNER, /backendJwtRole === "SUPER_ADMIN"/, "customers must never fetch an owner-only route");
  assert.match(BANNER, /!i\.completedAt && i\.daysLeft != null && i\.daysLeft <= 30/, "the banner shows the 30-day window until items are done");
});

test("no native <select> anywhere on the new surfaces (ConnectSelect house rule)", () => {
  // ⛔ Comments stripped first — the page's own header documents this very
  // rule, and a naive match fails on the documentation (fifth occurrence of
  // that trap in this repo).
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(strip(PAGE), /<select[\s>]/);
  assert.doesNotMatch(strip(BANNER), /<select[\s>]/);
});
