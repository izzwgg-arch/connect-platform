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

test("every Store page has its OWN key under can_view_section_store — all in NO default bucket (only SUPER_ADMIN sees Store)", async () => {
  // 2026-09-02: the five pages used to share can_view_supermarket_orders, so
  // one toggle moved all five. That key stays as the /supermarket DATA
  // capability; each page now decides its own link and render.
  const { DEFAULT_ROLE_PERMISSIONS } = await import("@connect/shared");
  const expected: Record<string, string> = {
    "store.orders": "can_view_store_orders",
    "store.deliveries": "can_view_store_deliveries",
    "store.drivers": "can_view_store_drivers",
    "store.specials": "can_view_store_specials",
    "store.teach": "can_view_store_teach",
  };
  for (const [id, key] of Object.entries(expected)) {
    const line = navSrc.split("\n").find((l) => l.includes(`id: "${id}"`));
    assert.ok(line, `${id} missing from navConfig`);
    assert.ok(line!.includes(`permission: "${key}"`), `${id} must gate on its own key ${key}`);
    assert.ok(line!.includes('section: "store"') && line!.includes('sectionPermission: "can_view_section_store"'), `${id} must live in the Store section`);
    assert.equal(DEFAULT_ROLE_PERMISSIONS.END_USER.includes(key as never), false, `${key} must not be an END_USER default`);
    assert.equal(DEFAULT_ROLE_PERMISSIONS.TENANT_ADMIN.includes(key as never), false, `${key} must not be a TENANT_ADMIN default`);
    const page = read(`app/(platform)/${id === "store.orders" ? "orders" : "orders/" + id.split(".")[1]}/page.tsx`);
    assert.ok(page.includes(`"${key}"`), `${id}'s page must gate on the same key as its sidebar row`);
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
  // The shared Sola payment form (CardknoxIFieldsForm) renders its OWN
  // .billing-* class names; the desk lays them out under .sm-ifwrap. Those
  // tokens are allowed ONLY as descendants — every line naming one must also
  // name an .sm- ancestor, which the per-line check below enforces.
  const IFIELDS_DESCENDANTS = new Set([
    ".billing-ifields-card", ".billing-pay-row--expiration", ".billing-ifields-cvv",
    ".billing-field-cardholder", ".billing-field-zip-only", ".billing-pay-secure-note",
  ]);
  const foreign = [...new Set(classSelectors.filter((c) => !c.startsWith(".sm-") && !IFIELDS_DESCENDANTS.has(c)))];
  assert.deepEqual(foreign, [], `unscoped selectors would collide with globals.css (.tab/.tabs live there): ${foreign.join(", ")}`);
  for (const line of css.split("\n")) {
    for (const tok of IFIELDS_DESCENDANTS) {
      if (line.includes(tok)) {
        assert.ok(/\.sm-[a-zA-Z0-9_-]+\s+\S/.test(line.slice(0, line.indexOf(tok))), `${tok} may only be styled as a descendant of an .sm- class: ${line.trim()}`);
      }
    }
  }
});

test("the twin page keeps its stay-until-done promise", () => {
  const twin = read("app/(platform)/orders/twin/TwinInner.tsx");
  assert.match(twin, /beforeunload/, "the twin must warn before closing while a draft is open — 'It should not disappear until they put in the order'");
});

test("⛔ the desk 'not in stock' pill fires on onHand === 0 ONLY — a NEGATIVE count is register drift, not an empty shelf (Izzy 2026-08-30)", () => {
  for (const p of ["app/(platform)/orders/OrdersDesk.tsx", "app/(platform)/orders/TeachAgent.tsx"]) {
    const src = read(p);
    assert.ok(!/onHand\s*<=\s*0/.test(src), `${p} must not read a negative onHand as out of stock — that is how organic eggs beat the $3.99 dozen sitting at -75`);
    assert.match(src, /onHand === 0 \? <span className="sm-stock-pill"/, `${p} must still label a true zero`);
  }
});
