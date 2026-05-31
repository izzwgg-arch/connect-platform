import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_QUICK_DISPOSITIONS,
  buildDefaultQuickDispositionItems,
  mergeQuickDispositionItems,
  normalizeCustomQuickDispositionInput,
  canManageQuickDispositions,
} from "./quickDispositions.js";

const repoRoot = join(__dirname, "..", "..", "..", "..");

function readRoute(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

test("buildDefaultQuickDispositionItems includes all required defaults", () => {
  const items = buildDefaultQuickDispositionItems();
  assert.equal(items.length, DEFAULT_QUICK_DISPOSITIONS.length);
  assert.equal(items[0]?.label, "No Answer");
  assert.equal(items.every((item) => item.isDefault), true);
});

test("mergeQuickDispositionItems appends enabled custom labels", () => {
  const merged = mergeQuickDispositionItems([
    { id: "custom-1", label: "Gatekeeper", sortOrder: 0, enabled: true },
  ]);
  assert.equal(merged.some((item) => item.label === "Gatekeeper"), true);
  assert.equal(merged.some((item) => item.label === "No Answer"), true);
});

test("normalizeCustomQuickDispositionInput rejects duplicate labels and default collisions", () => {
  const normalized = normalizeCustomQuickDispositionInput([
    { id: "a", label: "No Answer", sortOrder: 0 },
    { id: "b", label: "Custom A", sortOrder: 1 },
    { id: "c", label: "Custom A", sortOrder: 2 },
  ]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.label, "Custom A");
});

test("canManageQuickDispositions allows manager/admin and platform admin", () => {
  assert.equal(canManageQuickDispositions("TENANT_ADMIN", "AGENT"), true);
  assert.equal(canManageQuickDispositions("AGENT", "MANAGER"), true);
  assert.equal(canManageQuickDispositions("AGENT", "ADMIN"), true);
  assert.equal(canManageQuickDispositions("AGENT", "AGENT"), false);
});

test("GET quick dispositions requires CRM access", () => {
  const source = readRoute("apps/api/src/crm/quickDispositionRoutes.ts");
  assert.match(source, /app\.get\("\/crm\/quick-dispositions"[\s\S]*?requireCrmAccess/);
});

test("PUT quick dispositions requires manager/admin", () => {
  const source = readRoute("apps/api/src/crm/quickDispositionRoutes.ts");
  assert.match(source, /app\.put\("\/crm\/quick-dispositions"[\s\S]*?requireCrmManagerOrAdmin/);
});

test("quick disposition routes are tenant scoped via crmTenantSettings", () => {
  const source = readRoute("apps/api/src/crm/quickDispositionRoutes.ts");
  assert.match(source, /where: \{ tenantId \}/);
});
