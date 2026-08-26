/**
 * Portal guards for the supermarket build. Source-reading tests, because every
 * defect they pin is structural (a missing gate, a nav item without its force
 * line, an active call-path touch) and invisible to a behavioural test of any
 * one component. Reads are CRLF-normalised.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.join(__dirname, "..", p), "utf8").replace(/\r\n/g, "\n");

const navSrc = read("navigation/navConfig.ts");
const popSrc = read("components/SupermarketOrderPop.tsx");
const providersSrc = read("app/providers.tsx");

test("the Store section's items gate on can_view_supermarket_orders under can_view_section_store — both in NO default bucket (only SUPER_ADMIN sees Store)", () => {
  for (const id of ["store.orders", "store.deliveries", "store.drivers", "store.specials"]) {
    const line = navSrc.split("\n").find((l) => l.includes(`id: "${id}"`));
    assert.ok(line, `${id} missing from navConfig`);
    assert.ok(line!.includes('permission: "can_view_supermarket_orders"'), `${id} gates on the wrong key — a visible door that refuses on click`);
    assert.ok(line!.includes('section: "store"') && line!.includes('sectionPermission: "can_view_section_store"'), `${id} must live in the Store section`);
  }
});

test("admin.integrations is SUPER_ADMIN-forced in isNavItemVisibleForUser", () => {
  assert.match(navSrc, /id: "admin\.integrations"/);
  assert.match(
    navSrc,
    /item\.id === "admin\.integrations" && backendJwtRole !== "SUPER_ADMIN"\) return false;/,
    "without the force line every tenant admin holding can_manage_global_settings-shaped custom keys could see the platform key vault",
  );
});

test("⛔ SupermarketOrderPop is a passive observer: it never touches the answer path", () => {
  const stripped = popSrc.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const banned of ["phone.answer", "phone.hangup", "phone.decline", ".answer(", "answerIncoming", "sendDTMF"]) {
    assert.ok(!stripped.includes(banned), `order pop touches the call path (${banned}) — the blast-radius rule forbids it`);
  }
  assert.match(popSrc, /useOptionalSipPhone/, "must use the OPTIONAL hook — chrome never crashes over a missing provider");
  assert.match(popSrc, /hasBrowserAuthToken/, "an unauthenticated probe is the self-ban class");
});

test("the order pop fires only on ringing→connected INBOUND, once per call", () => {
  assert.match(popSrc, /prev === "ringing" && callState === "connected" && callDirection === "inbound"/);
  assert.match(popSrc, /firedForCall/, "no once-per-call latch — every re-render would pop another window");
});

test("SupermarketOrderPop is mounted in providers.tsx", () => {
  assert.match(providersSrc, /SupermarketOrderPop/, "component exists but nothing mounts it — the twin can never pop");
});

test("every orders page.tsx exports ONLY a default component (named page exports fail the production build)", () => {
  for (const p of ["app/(platform)/orders/page.tsx", "app/(platform)/orders/new/page.tsx", "app/(platform)/orders/twin/page.tsx", "app/(platform)/orders/deliveries/page.tsx", "app/(platform)/orders/drivers/page.tsx", "app/(platform)/orders/specials/page.tsx", "app/(platform)/admin/integrations/page.tsx"]) {
    const src = read(p);
    assert.match(src, /export default function/, `${p} missing default export`);
    const named = src.match(/^export (?:const|function|type|interface) /m);
    assert.equal(named, null, `${p} carries a named export — tsc passes, the deploy build dies`);
  }
});

test("the supermarket stylesheet is scoped: every rule sits under .sm- prefixed classes", () => {
  // ⛔ strip comments first — the header comment NAMES .tab/.tabs while
  // explaining why they are avoided (the recurring negative-match-on-a-comment
  // trap, fifth occurrence in this repo).
  const css = read("app/(platform)/orders/supermarket.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const classSelectors = css.match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g) ?? [];
  const foreign = [...new Set(classSelectors.filter((c) => !c.startsWith(".sm-")))];
  assert.deepEqual(foreign, [], `unscoped selectors would collide with globals.css (.tab/.tabs live there): ${foreign.join(", ")}`);
});

test("the twin page keeps its stay-until-done promise", () => {
  const twin = read("app/(platform)/orders/twin/TwinInner.tsx");
  assert.match(twin, /beforeunload/, "the twin must warn before closing while a draft is open — 'It should not disappear until they put in the order'");
});
