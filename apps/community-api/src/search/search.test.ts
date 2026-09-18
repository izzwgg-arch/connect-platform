import { test } from "node:test";
import assert from "node:assert/strict";
import { api, createOrg, createUser, tdb, testApp, uniq } from "../testing/harness.js";
import { buildSearchText } from "../lib/search.js";
import { interpretQuery } from "./nlq.js";

test("nlq: interprets a natural-language query", () => {
  const r = interpretQuery("commercial security-camera installer serving nursing homes in Brooklyn");
  assert.equal(r.location, "Brooklyn");
  assert.equal(r.customerType, "nursing homes");
  assert.equal(r.typeHint, "organizations");
  assert.ok(r.service.includes("security camera installer"), r.service);
});

test("nlq: distance and defaults", () => {
  const r = interpretQuery("bookkeeper within 25 miles");
  assert.equal(r.distanceMiles, 25);
  assert.equal(r.location, null);
  assert.equal(r.typeHint, null);
});

async function seed() {
  const app = await testApp();
  const suffix = uniq("emb");
  // Unique first names (not just last names) so /search/suggest prefix matching can't collide
  // with a "Shloimy"/"Chany"/"Rivky" created by another test's seed() in this shared database.
  const pA = await createUser(app, { firstName: uniq("Zev"), lastName: `Weiss${suffix}`, headline: "Embroidery digitizing specialist" });
  const pB = await createUser(app, { firstName: uniq("Chana"), lastName: `Gross${suffix}` });
  const pC = await createUser(app, { firstName: uniq("Rivka"), lastName: `Stern${suffix}` });

  const org1 = await createOrg(app, pA, `Weiss Embroidery & Uniforms ${suffix}`);
  const org2 = await createOrg(app, pB, `Kaufman Plumbing Supply ${suffix}`);

  const post = await api(app, {
    method: "POST",
    url: "/posts",
    token: pB.accessToken,
    payload: { kind: "TEXT", body: `Excited to share our new embroidery machine setup! ${suffix}` },
  });
  if (post.status !== 201) throw new Error(`post create failed ${post.status} ${JSON.stringify(post.body)}`);

  // Jobs domain isn't built yet — write the row directly, same as production code would via buildSearchText.
  const job = await tdb().job.create({
    data: {
      organizationId: org1.id,
      createdById: pA.personId,
      title: `Embroidery Machine Operator ${suffix}`,
      description: "Run our embroidery machines daily, digitize new designs.",
      status: "OPEN",
      searchText: buildSearchText([`Embroidery Machine Operator ${suffix}`, "Run our embroidery machines daily, digitize new designs."]),
    },
  });

  return { app, pA, pB, pC, org1, org2, post: post.body, job, suffix };
}

test("search: full-text hit on a real word", async () => {
  const { app, pA, org1, suffix } = await seed();
  // Scope to this test's own unique org name so accumulated rows from other test
  // runs against the same shared database can't crowd it out of a small page.
  const r = await api(app, { method: "GET", url: `/search?q=${encodeURIComponent(`embroidery ${suffix}`)}&type=organizations`, token: pA.accessToken });
  assert.equal(r.status, 200);
  const orgHit = r.body.results.find((x: any) => x.id === org1.id);
  assert.ok(orgHit, JSON.stringify(r.body.results.map((x: any) => [x.type, x.id])));
  assert.ok(orgHit.why.length > 0);
});

test("search: a typo is rescued by trigram similarity", async () => {
  const { app, pA, org1 } = await seed();
  // A word unique to this org, misspelled — "embroidry" alone is crowded out by
  // the hundreds of embroidery rows the Tier-1 loop leaves behind in a shared dev db.
  const unique = `zephyrquilt${Date.now().toString(36)}`;
  await tdb().organization.update({ where: { id: org1.id }, data: { description: `${unique} embroidery`, searchText: `${org1.displayName} ${unique} embroidery uniforms`.toLowerCase() } });
  const typo = unique.replace("quilt", "qilt");
  const r = await api(app, { method: "GET", url: `/search?q=${encodeURIComponent(typo)}&type=organizations`, token: pA.accessToken });
  assert.equal(r.status, 200);
  assert.ok(r.body.results.some((x: any) => x.id === org1.id), JSON.stringify(r.body.results).slice(0, 400));
});

test("search: type filter restricts to one type", async () => {
  const { app, pA } = await seed();
  const r = await api(app, { method: "GET", url: `/search?q=embroidery&type=jobs`, token: pA.accessToken });
  assert.equal(r.status, 200);
  assert.ok(r.body.results.every((x: any) => x.type === "jobs"));
});

test("search: counts cover every type on the 'all' tab", async () => {
  const { app, pA } = await seed();
  const r = await api(app, { method: "GET", url: `/search?q=embroidery`, token: pA.accessToken });
  assert.equal(r.status, 200);
  for (const t of ["people", "organizations", "posts", "jobs", "listings", "groups", "events", "rfqs", "opportunities"]) {
    assert.ok(typeof r.body.counts[t] === "number", `missing count for ${t}`);
  }
  assert.ok(r.body.counts.organizations >= 1);
  assert.ok(r.body.counts.people >= 1);
});

test("search: a blocked person never appears in results", async () => {
  const { app, pA, pC } = await seed();
  const block = await api(app, { method: "POST", url: `/people/${pA.personId}/block`, token: pC.accessToken });
  assert.equal(block.status, 200);
  const r = await api(app, { method: "GET", url: `/search?q=embroidery&type=people`, token: pC.accessToken });
  assert.equal(r.status, 200);
  assert.ok(!r.body.results.some((x: any) => x.id === pA.personId), JSON.stringify(r.body.results));
});

test("search/suggest: prefix match on first name", async () => {
  const { app, pA } = await seed();
  const r = await api(app, { method: "GET", url: `/search/suggest?q=${encodeURIComponent(pA.firstName.slice(0, 9))}`, token: pA.accessToken });
  assert.equal(r.status, 200);
  assert.ok(r.body.people.some((p: any) => p.id === pA.personId), JSON.stringify(r.body.people));
});

test("saved search: create, list, toggle alerts, delete", async () => {
  const { app, pA } = await seed();
  const created = await api(app, { method: "POST", url: "/search/saved", token: pA.accessToken, payload: { query: "embroidery wholesale" } });
  assert.equal(created.status, 200);
  assert.equal(created.body.alerts, false);

  const list = await api(app, { method: "GET", url: "/search/saved", token: pA.accessToken });
  assert.ok(list.body.items.some((s: any) => s.id === created.body.id));

  const toggled = await api(app, { method: "PATCH", url: `/search/saved/${created.body.id}`, token: pA.accessToken, payload: { alerts: true } });
  assert.equal(toggled.status, 200);
  assert.equal(toggled.body.alerts, true);

  const del = await api(app, { method: "DELETE", url: `/search/saved/${created.body.id}`, token: pA.accessToken });
  assert.equal(del.status, 200);
  const list2 = await api(app, { method: "GET", url: "/search/saved", token: pA.accessToken });
  assert.ok(!list2.body.items.some((s: any) => s.id === created.body.id));
});

test("recent search: a signed-in search is recorded and can be cleared", async () => {
  const { app, pA, suffix } = await seed();
  const term = `embroidery-${suffix}`;
  await api(app, { method: "GET", url: `/search?q=${encodeURIComponent(term)}`, token: pA.accessToken });
  const recent = await api(app, { method: "GET", url: "/search/recent", token: pA.accessToken });
  assert.ok(recent.body.items.some((r: any) => r.query === term));

  const cleared = await api(app, { method: "DELETE", url: "/search/recent", token: pA.accessToken });
  assert.equal(cleared.status, 200);
  const recent2 = await api(app, { method: "GET", url: "/search/recent", token: pA.accessToken });
  assert.equal(recent2.body.items.length, 0);
});

test("search: anonymous viewers get public results with no auth error", async () => {
  const { app, org1, suffix } = await seed();
  const r = await api(app, { method: "GET", url: `/search?q=${encodeURIComponent(`embroidery ${suffix}`)}&type=organizations` });
  assert.equal(r.status, 200);
  assert.ok(r.body.results.some((x: any) => x.id === org1.id));
});

test("search/click: records without throwing for signed-out callers", async () => {
  const { app } = await seed();
  const r = await api(app, { method: "POST", url: "/search/click", payload: { type: "organizations", id: "x", position: 0, q: "embroidery" } });
  assert.equal(r.status, 200);
});
