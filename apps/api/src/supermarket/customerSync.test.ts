/**
 * The customer mirror (2026-09-08): parser on the REAL shapes the register
 * answered with the all-customer key, the sweep against the faithful fake db,
 * the type-ahead ranking, and the wiring guards — server.ts arms the sweep,
 * the routes read the mirror, the three portal boxes render the type-ahead,
 * the card extractor reads the register's real field names.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { extractPosCustomer, parseCustomersPage, toMirrorCustomer } from "./posWithLogic";
import { extractPosCard } from "./customerCards";
import {
  customerQueryIsNumeric,
  customerSearchDigits,
  mirrorCustomerByPhone,
  runCustomerSyncSweep,
  searchMirrorCustomers,
} from "./customerSync";
import { makeSupermarketDb } from "./supermarketTestKit";

const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── the real shapes (captured live 2026-09-08, personal details trimmed) ──
const LIVE_CUSTOMER = {
  id: "3762",
  firstName: "JACOB",
  lastName: "WEINSTOCK",
  phone: "8457823064",
  phones: ["8457823064"],
  email: "x@example.com",
  address: { addressLine1: "68 JEFFERSON ST", addressLine2: "", city: "HIGHLAND MILLS", state: "NY", zipCode: "10930" },
  customerCreditCards: [{ id: "395", masked: "4xxxxxxxxxxx9603", exp: "0228", name: "", zipCode: "", issuer: "Visa" }],
  shippingAddresses: [],
  lastModified: "2025-08-14T17:21:46-04:00",
  isOnAccountEligible: false,
  route: "",
  seq: 0,
};
const LIVE_TWO_PHONES = {
  id: "20001190",
  firstName: "",
  lastName: "FEURWEKER",
  phone: "8452815596",
  phones: ["8457991397", "8452815596"],
  email: "",
  address: { addressLine1: "2 AMSTERDAM #101", addressLine2: "", city: "MONROE", state: "NY", zipCode: "10950" },
  customerCreditCards: [{ id: "1376", masked: "4xxxxxxxxxxx6883", exp: "0628", name: "", zipCode: "10950", issuer: "Visa" }],
  lastModified: "2026-09-07T14:21:31-04:00",
  isOnAccountEligible: true,
  route: "C",
};
const LIVE_PAGE = { results: [LIVE_CUSTOMER, LIVE_TWO_PHONES], hasMore: true, cursor: "abc123", total: 13837 };

test("toMirrorCustomer reads the live record: name, every phone, address object, card COUNT (never the card), route, on-account", () => {
  const c = toMirrorCustomer(LIVE_TWO_PHONES)!;
  assert.equal(c.posCustomerId, "20001190");
  assert.equal(c.name, "FEURWEKER");
  assert.deepEqual(c.phones, ["8457991397", "8452815596"]);
  assert.equal(c.primaryPhone, "8457991397");
  assert.equal(c.address, "2 AMSTERDAM #101");
  assert.equal(c.city, "MONROE");
  assert.equal(c.route, "C");
  assert.equal(c.onAccount, true);
  assert.equal(c.cardCount, 1);
  assert.equal(c.posLastMod, "2026-09-07T14:21:31-04:00");
  // ⛔ no masked number, no exp, no card id ever lands in the mirror row
  assert.ok(!JSON.stringify(c).includes("9603") && !JSON.stringify(c).includes("6883"));
});

test("parseCustomersPage reads the {results, hasMore, cursor, total} envelope and drops the cursor on the last page", () => {
  const p = parseCustomersPage(LIVE_PAGE)!;
  assert.equal(p.items.length, 2);
  assert.equal(p.cursor, "abc123");
  const last = parseCustomersPage({ ...LIVE_PAGE, hasMore: false })!;
  assert.equal(last.cursor, null);
  assert.equal(parseCustomersPage({ nonsense: true }), null);
  assert.equal(parseCustomersPage("x"), null);
});

test("⛔ extractPosCustomer no longer prints [object Object] for the address object", () => {
  const ext = extractPosCustomer(LIVE_CUSTOMER)!;
  assert.equal(ext.address, "68 JEFFERSON ST, HIGHLAND MILLS NY, 10930");
  assert.ok(!ext.address.includes("[object"));
  assert.equal(ext.posCustomerId, "3762");
  assert.equal(ext.name, "JACOB WEINSTOCK");
});

test("⛔ extractPosCard reads the register's REAL field names (masked / exp MMYY / issuer)", () => {
  const card = extractPosCard(LIVE_CUSTOMER.customerCreditCards[0]);
  assert.equal(card.posCardId, "395");
  assert.equal(card.last4, "9603");
  assert.equal(card.exp, "02/28");
  assert.equal(card.brand, "Visa");
  // ⛔ a register card carries no gateway token, so it is listed but NOT
  // chargeable through our Sola lane
  assert.equal(card.gatewayToken, null);
});

test("search digits + numeric detection: 11-digit 1-prefix folds to 10, names read as names", () => {
  assert.equal(customerSearchDigits("1 (845) 782-3064"), "8457823064");
  assert.equal(customerSearchDigits("782"), "782");
  assert.equal(customerQueryIsNumeric("845 78"), true);
  assert.equal(customerQueryIsNumeric("weinstock"), false);
  assert.equal(customerQueryIsNumeric("12"), false);
});

test("the sweep walks every page inside ONE run, mirrors the rows, advances customerLastMod only when finished", async () => {
  const db = makeSupermarketDb();
  db.seed("tenant", { id: "t1", crmMode: "supermarket", name: "Gesheft" });
  db.seed("providerCredential", { tenantId: "t1", provider: "POS_TRACKING", credentialsEncrypted: "x" });
  const calls: any[] = [];
  const pages = [
    { results: [LIVE_CUSTOMER], hasMore: true, cursor: "c1" },
    { results: [LIVE_TWO_PHONES], hasMore: false },
  ];
  const fakeClient = {
    listCustomers: async (q: any) => {
      calls.push(q);
      return pages[calls.length - 1];
    },
  };
  const res = await runCustomerSyncSweep({
    db,
    clientFor: (async () => fakeClient) as any,
    pagePaceMs: 0,
    sleep: async () => {},
  });
  assert.equal(res.upserted, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cursor, "c1", "cursor pages must carry the cursor");
  const state = db.rows("posCatalogSyncState")[0];
  assert.equal(state.customerLastMod, "2026-09-07T14:21:31-04:00", "the newest lastModified becomes the high-water");
  assert.equal(state.customerCount, 2);
  assert.equal(state.customerLastError, null);
  const rows = db.rows("posCustomer");
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r: any) => r.posCustomerId === "20001190").phonesText, "8457991397 8452815596");

  // an unfinished walk (budget hit) must NOT advance the high-water
  const db2 = makeSupermarketDb();
  db2.seed("tenant", { id: "t1", crmMode: "supermarket", name: "Gesheft" });
  db2.seed("providerCredential", { tenantId: "t1", provider: "POS_TRACKING", credentialsEncrypted: "x" });
  const endless = { listCustomers: async () => ({ results: [LIVE_CUSTOMER], hasMore: true, cursor: "again" }) };
  await runCustomerSyncSweep({ db: db2, clientFor: (async () => endless) as any, pageBudget: 3, pagePaceMs: 0, sleep: async () => {} });
  assert.equal(db2.rows("posCatalogSyncState")[0].customerLastMod, null);
  assert.equal(db2.rows("posCustomer").length, 1, "the same row upserts, never duplicates");
});

test("an unparseable page records the error and stops — nothing is wiped", async () => {
  const db = makeSupermarketDb();
  db.seed("tenant", { id: "t1", crmMode: "supermarket", name: "Gesheft" });
  db.seed("providerCredential", { tenantId: "t1", provider: "POS_TRACKING", credentialsEncrypted: "x" });
  db.seed("posCustomer", { tenantId: "t1", posCustomerId: "old", name: "OLD", phonesText: "8450000000" });
  const bad = { listCustomers: async () => ({ garbage: 1 }) };
  await runCustomerSyncSweep({ db, clientFor: (async () => bad) as any, pagePaceMs: 0, sleep: async () => {} });
  assert.equal(db.rows("posCatalogSyncState")[0].customerLastError, "pos_unparseable_page");
  assert.equal(db.rows("posCustomer").length, 1);
});

test("type-ahead: digits match ANY phone on the record and a starts-with beats a contains; letters match the name", async () => {
  const db = makeSupermarketDb();
  db.seed("posCustomer", { tenantId: "t1", posCustomerId: "A", name: "FEURWEKER", phonesText: "8457991397 8452815596", primaryPhone: "8457991397" });
  db.seed("posCustomer", { tenantId: "t1", posCustomerId: "B", name: "JACOB WEINSTOCK", phonesText: "8457823064", primaryPhone: "8457823064" });
  db.seed("posCustomer", { tenantId: "t1", posCustomerId: "C", name: "ZZZ", phonesText: "2128457823", primaryPhone: "2128457823" });
  db.seed("posCustomer", { tenantId: "t2", posCustomerId: "D", name: "OTHER TENANT", phonesText: "8457823064", primaryPhone: "8457823064" });
  // the SECOND number on a record is searchable
  const bySecond = await searchMirrorCustomers(db, "t1", "281-5596");
  assert.deepEqual(bySecond.map((h) => h.posCustomerId), ["A"]);
  // starts-with outranks contains
  const byPrefix = await searchMirrorCustomers(db, "t1", "845782");
  assert.equal(byPrefix[0].posCustomerId, "B");
  assert.ok(byPrefix.some((h) => h.posCustomerId === "C"));
  // ⛔ never another tenant's row
  assert.ok(!byPrefix.some((h) => h.posCustomerId === "D"));
  const byName = await searchMirrorCustomers(db, "t1", "weins");
  assert.deepEqual(byName.map((h) => h.posCustomerId), ["B"]);
  assert.deepEqual(await searchMirrorCustomers(db, "t1", ""), []);
  // exact-phone fallback returns the record whose phone list holds that number
  const exact = await mirrorCustomerByPhone(db, "t1", "8452815596");
  assert.equal(exact?.posCustomerId, "A");
  assert.equal(await mirrorCustomerByPhone(db, "t1", "8450000000"), null);
});

// ── wiring guards ─────────────────────────────────────────────────────────
test("server.ts arms the customer sweep with a boot kick AND an interval, inside the kill switch", () => {
  const src = read("../server.ts");
  assert.match(src, /runCustomerSyncSweep/);
  const start = src.indexOf("SUPERMARKET_SWEEPS_DISABLED");
  const block = src.slice(start, start + 4000);
  assert.match(block, /CUSTOMER_SYNC_BOOT_DELAY_MS/, "no boot kick — starved on a deploy day");
  assert.match(block, /runCustomerSyncSweep[\s\S]{0,300}customerMs/, "no interval");
});

test("the routes: a search door reads the mirror, and BOTH lookup paths fall back to it when the register misses", () => {
  const src = stripComments(read("./supermarketRoutes.ts"));
  assert.match(src, /app\.get\("\/supermarket\/customers\/search"/);
  assert.match(src, /searchMirrorCustomers\(db, tenantId, q, limit\)/);
  // the search never reaches the register
  const searchBlock = src.slice(src.indexOf('app.get("/supermarket/customers/search"'), src.indexOf('app.get("/supermarket/lookup"'));
  assert.ok(!/clientFor\(|getCustomerByPhone|listCustomers/.test(searchBlock), "the type-ahead must never bill a register call per keystroke");
  assert.equal((src.match(/mirrorCustomerByPhone\(/g) ?? []).length, 2, "both the lookup route and the draft PATCH fall back to the mirror");
  assert.match(src, /posCustomerId: z\.string\(\)\.min\(1\)\.max\(64\)\.optional\(\)/, "a picked suggestion binds by register id");
  assert.match(src, /mirrorCustomerById\(db, tenantOf\(req\), parsed\.data\.posCustomerId\)/);
});

test("the three 'Whose order is this?' boxes render the type-ahead, and none keeps a bare <input> lookup", () => {
  const portal = (rel: string) => readFileSync(path.join(__dirname, "../../../portal", rel), "utf8").replace(/\r\n/g, "\n");
  for (const rel of ["app/(platform)/orders/new/page.tsx", "app/(platform)/orders/twin/TwinInner.tsx", "app/(platform)/orders/OrdersDesk.tsx"]) {
    const src = portal(rel);
    assert.match(src, /<CustomerTypeahead/, `${rel} does not render the type-ahead`);
    assert.match(src, /onPick=/, `${rel} never binds a picked account`);
  }
  const ta = portal("app/(platform)/orders/CustomerTypeahead.tsx");
  assert.match(ta, /\/supermarket\/customers\/search\?q=/);
  assert.match(ta, /still loading from the register/, "an empty list must say why before the first walk finishes");
});
