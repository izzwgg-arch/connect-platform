import { NAV_ITEMS_ALWAYS_VISIBLE } from "@connect/shared";
import test from "node:test";
import assert from "node:assert/strict";
import { buildSearchCatalog, findSearchResults } from "./globalSearch";
import { navItems, isNavItemVisibleForUser } from "../navigation/navConfig";

test("every available page comes from the authoritative navigation catalog", () => {
  for (const role of ["USER", "TENANT_ADMIN", "SUPER_ADMIN"]) {
    const results = buildSearchCatalog(() => true, role);
    assert.deepEqual(results.filter(r => r.kind === "page").map(r => r.id), navItems.filter(n => !n.download && isNavItemVisibleForUser(n, () => true, role)).map(n => n.id));
    for (const result of results) assert(result.personalSection || (result.href?.startsWith("/") && !result.href.startsWith("//")));
  }
});
test("each page requires its section and page grant; hidden pages cannot appear", () => {
  for (const page of navItems.filter(n => !n.download)) {
    const grants = new Set([page.sectionPermission, page.permission]);
    const can = (p: any) => grants.has(p);
    assert(buildSearchCatalog(can, "SUPER_ADMIN").some(r => r.id === page.id));
    assert(!buildSearchCatalog(p => p === page.permission, "USER").some(r => r.id === page.id));
    if (!NAV_ITEMS_ALWAYS_VISIBLE.includes(page.id)) assert(!buildSearchCatalog(can, "SUPER_ADMIN", { hidden: [page.id], ownerOnlyLifted: [] }).some(r => r.navId === page.id));
  }
});
test("no grants still allows personal settings but never tenant or platform pages", () => {
  const results = buildSearchCatalog(() => false, "USER");
  assert(results.length > 0); assert(results.every(r => r.id.startsWith("personal.")));
});
test("common terms find actual settings and pages without exact label knowledge", () => {
  const catalog = buildSearchCatalog(() => true, "SUPER_ADMIN");
  for (const [query, id] of [["DND", "personal.dnd"], ["microphone", "settings.audio"], ["call forwarding", "settings.forwarding"], ["dark mode", "personal.theme"], ["permission", "admin.roles"], ["invoice", "billing.overview"], ["extension", "workspace.team"]]) {
    assert(findSearchResults(catalog, query!).some(r => r.id === id), `${query} must find ${id}`);
  }
  assert.equal(findSearchResults(catalog, "Do Not Disturb")[0]?.id, "personal.dnd");
  assert.deepEqual(findSearchResults(catalog, "nonsense-unmatched-qzxy"), []);
});
test("word matching is case/accent insensitive and requires every search term", () => {
  const record = { id: "test", title: "José Smith", description: "Contact", kind: "record" as const };
  assert.equal(findSearchResults([record], "JOSE smith").length, 1);
  assert.equal(findSearchResults([record], "Jose unrelated").length, 0);
});
