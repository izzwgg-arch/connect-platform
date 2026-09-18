import { test } from "node:test";
import assert from "node:assert/strict";
import { api, createOrg, createUser, tdb, testApp, uniq } from "../testing/harness.js";

test("GET /marketplace/categories returns a nested tree with rolled-up counts", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const org = await createOrg(app, owner);
  const create = await api(app, {
    method: "POST",
    url: "/listings",
    token: owner.accessToken,
    payload: { type: "SERVICE", title: "Embroidery digitizing (24h)", description: "Fast turnaround digitizing.", categorySlug: "embroidery", organizationId: org.id },
  });
  assert.equal(create.status, 201);

  const r = await api(app, { method: "GET", url: "/marketplace/categories", token: owner.accessToken });
  assert.equal(r.status, 200);
  const apparel = r.body.categories.find((c: any) => c.slug === "apparel-uniforms");
  assert.ok(apparel, "apparel-uniforms root exists");
  const embroidery = apparel.children.find((c: any) => c.slug === "embroidery");
  assert.ok(embroidery, "embroidery child exists");
  assert.ok(embroidery.count >= 1);
  assert.ok(apparel.count >= embroidery.count, "parent count rolls up child count");
});

test("POST /listings: a person can post a personal listing", async () => {
  const app = await testApp();
  const seller = await createUser(app);
  const r = await api(app, {
    method: "POST",
    url: "/listings",
    token: seller.accessToken,
    payload: { type: "PROFESSIONAL_SERVICE", title: "Bookkeeping for wholesale accounts", description: "Monthly close, sales tax, 1099s.", priceUnit: "/mo", priceMin: 350 },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.seller.person.id, seller.personId);
  assert.equal(r.body.seller.organization, null);
  assert.equal(r.body.listing.priceMin, "350");
});

test("POST /listings: unverified actor is refused", async () => {
  const app = await testApp();
  const unverified = await createUser(app, { verify: false });
  const r = await api(app, { method: "POST", url: "/listings", token: unverified.accessToken, payload: { type: "SERVICE", title: "x".repeat(5), description: "d" } });
  assert.equal(r.status, 403);
});

test("POST /listings with organizationId: owner can, an EMPLOYEE without org.manage_listings gets 403", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const org = await createOrg(app, owner);
  const employee = await createUser(app);
  await tdb().membership.create({ data: { personId: employee.personId, organizationId: org.id, role: "EMPLOYEE", affiliation: "VERIFIED_ADMIN" } });

  const ok = await api(app, { method: "POST", url: "/listings", token: owner.accessToken, payload: { type: "PRODUCT", title: "Gildan 18500 hoodies — blank", description: "Blank stock.", organizationId: org.id } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.seller.organization.id, org.id);

  const forbid = await api(app, { method: "POST", url: "/listings", token: employee.accessToken, payload: { type: "PRODUCT", title: "Should not work", description: "d", organizationId: org.id } });
  assert.equal(forbid.status, 403);
});

test("GET /listings: search by text, category descendants, and verifiedOnly filter", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const verifiedOwner = await createUser(app);
  const org = await createOrg(app, owner, uniq("Weiss Embroidery "));
  const verifiedOrg = await createOrg(app, verifiedOwner, uniq("Berger Signs "));
  await tdb().verification.create({ data: { organizationId: verifiedOrg.id, kind: "BUSINESS", status: "VERIFIED" } });

  const a = await api(app, { method: "POST", url: "/listings", token: owner.accessToken, payload: { type: "SERVICE", title: "Embroidery digitizing rush service", description: "Same-day digitizing files.", categorySlug: "embroidery", organizationId: org.id } });
  assert.equal(a.status, 201);
  const b = await api(app, { method: "POST", url: "/listings", token: verifiedOwner.accessToken, payload: { type: "SERVICE", title: "Storefront signage and lettering", description: "Retail signage install.", categorySlug: "signage", organizationId: verifiedOrg.id } });
  assert.equal(b.status, 201);

  const byText = await api(app, { method: "GET", url: "/listings?q=digitizing", token: owner.accessToken });
  assert.equal(byText.status, 200);
  assert.ok(byText.body.items.some((it: any) => it.listing.id === a.body.listing.id));
  assert.ok(!byText.body.items.some((it: any) => it.listing.id === b.body.listing.id));

  const byCategory = await api(app, { method: "GET", url: "/listings?category=apparel-uniforms", token: owner.accessToken });
  assert.ok(byCategory.body.items.some((it: any) => it.listing.id === a.body.listing.id));
  assert.ok(!byCategory.body.items.some((it: any) => it.listing.id === b.body.listing.id));

  const verifiedOnly = await api(app, { method: "GET", url: "/listings?verifiedOnly=1", token: owner.accessToken });
  assert.ok(verifiedOnly.body.items.some((it: any) => it.listing.id === b.body.listing.id));
  assert.ok(!verifiedOnly.body.items.some((it: any) => it.listing.id === a.body.listing.id));
  assert.equal(verifiedOnly.body.items.find((it: any) => it.listing.id === b.body.listing.id)?.verified, true);
});

test("GET /public/listings/:id is readable anonymously and counts a view", async () => {
  const app = await testApp();
  const seller = await createUser(app);
  const created = await api(app, { method: "POST", url: "/listings", token: seller.accessToken, payload: { type: "SERVICE", title: "Anonymous-readable listing", description: "d" } });
  assert.equal(created.status, 201);

  const anon = await api(app, { method: "GET", url: `/public/listings/${created.body.listing.id}` });
  assert.equal(anon.status, 200);
  assert.equal(anon.body.listing.viewCount, 1);

  const missing = await api(app, { method: "GET", url: "/public/listings/does-not-exist" });
  assert.equal(missing.status, 404);
});

test("POST /listings/:id/message creates a thread the seller can read, and notifies them", async () => {
  const app = await testApp();
  const seller = await createUser(app);
  const buyer = await createUser(app);
  const created = await api(app, { method: "POST", url: "/listings", token: seller.accessToken, payload: { type: "PRODUCT", title: "Custom corrugated shipping boxes", description: "MOQ 500." } });
  assert.equal(created.status, 201);

  const msg = await api(app, { method: "POST", url: `/listings/${created.body.listing.id}/message`, token: buyer.accessToken, payload: { body: "Do you ship to Monroe, NY?" } });
  assert.equal(msg.status, 200);
  assert.ok(msg.body.threadId);

  const sellerRead = await api(app, { method: "GET", url: `/threads/${msg.body.threadId}/messages`, token: seller.accessToken });
  assert.equal(sellerRead.status, 200);
  assert.ok(sellerRead.body.items.some((m: any) => m.body === "Do you ship to Monroe, NY?"));

  const notifs = await tdb().notification.findMany({ where: { personId: seller.personId, kind: "inquiry.business" } });
  assert.equal(notifs.length, 1);
});

test("save / unsave a listing shows up in /me/saved-listings", async () => {
  const app = await testApp();
  const seller = await createUser(app);
  const buyer = await createUser(app);
  const created = await api(app, { method: "POST", url: "/listings", token: seller.accessToken, payload: { type: "SERVICE", title: "Site visit signage quote", description: "d" } });

  const save = await api(app, { method: "POST", url: `/listings/${created.body.listing.id}/save`, token: buyer.accessToken });
  assert.equal(save.status, 201);

  const saved = await api(app, { method: "GET", url: "/me/saved-listings", token: buyer.accessToken });
  assert.equal(saved.status, 200);
  assert.ok(saved.body.items.some((it: any) => it.listing.id === created.body.listing.id && it.saved === true));

  const unsave = await api(app, { method: "DELETE", url: `/listings/${created.body.listing.id}/save`, token: buyer.accessToken });
  assert.equal(unsave.status, 204);
  const savedAfter = await api(app, { method: "GET", url: "/me/saved-listings", token: buyer.accessToken });
  assert.ok(!savedAfter.body.items.some((it: any) => it.listing.id === created.body.listing.id));
});

test("PATCH/DELETE a listing: owner can, a stranger is 403, removed listing 404s afterward", async () => {
  const app = await testApp();
  const seller = await createUser(app);
  const stranger = await createUser(app);
  const created = await api(app, { method: "POST", url: "/listings", token: seller.accessToken, payload: { type: "SERVICE", title: "Retail signage & storefront lettering", description: "d" } });

  const forbidPatch = await api(app, { method: "PATCH", url: `/listings/${created.body.listing.id}`, token: stranger.accessToken, payload: { title: "Hijacked title here" } });
  assert.equal(forbidPatch.status, 403);

  const ok = await api(app, { method: "PATCH", url: `/listings/${created.body.listing.id}`, token: seller.accessToken, payload: { title: "Retail signage & storefront lettering — updated" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.listing.title, "Retail signage & storefront lettering — updated");

  const del = await api(app, { method: "DELETE", url: `/listings/${created.body.listing.id}`, token: seller.accessToken });
  assert.equal(del.status, 204);
  const gone = await api(app, { method: "GET", url: `/public/listings/${created.body.listing.id}` });
  assert.equal(gone.status, 404);
});
