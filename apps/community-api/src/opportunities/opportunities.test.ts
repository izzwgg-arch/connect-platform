import { test } from "node:test";
import assert from "node:assert/strict";
import { api, createUser, tdb, testApp } from "../testing/harness.js";
import { validateFields, type OpportunityField } from "./types.js";

/* ── pure validateFields unit tests ─────────────────────────────────────── */

const SCHEMA: OpportunityField[] = [
  { key: "need", label: "What you need", type: "text", required: true },
  { key: "budget", label: "Budget", type: "money", required: true },
  { key: "deadline", label: "Deadline", type: "date", required: false },
  { key: "kind", label: "Kind", type: "select", required: true, options: ["A", "B"] },
];

test("validateFields: missing a required field returns a human sentence", () => {
  const errors = validateFields(SCHEMA, { budget: 100, kind: "A" });
  assert.ok(errors.some((e) => e.includes("What you need is required.")));
});

test("validateFields: wrong type returns a human sentence", () => {
  const errors = validateFields(SCHEMA, { need: "office cleaning", budget: "not a number" as any, kind: "A" });
  assert.ok(errors.some((e) => e.includes("Budget must be a positive amount.")));
});

test("validateFields: a select value outside its options is refused", () => {
  const errors = validateFields(SCHEMA, { need: "x", budget: 10, kind: "Z" });
  assert.ok(errors.some((e) => e.includes("Kind must be one of: A, B.")));
});

test("validateFields: a valid submission has no errors", () => {
  const errors = validateFields(SCHEMA, { need: "x", budget: 10, kind: "A" });
  assert.deepEqual(errors, []);
});

/* ── routes ──────────────────────────────────────────────────────────────── */

test("GET /opportunities/types is seeded with schemas", async () => {
  const app = await testApp();
  const user = await createUser(app);
  const r = await api(app, { method: "GET", url: "/opportunities/types", token: user.accessToken });
  assert.equal(r.status, 200);
  const wholesale = r.body.types.find((t: any) => t.slug === "wholesale");
  assert.ok(wholesale);
  assert.ok(Array.isArray(wholesale.fieldSchema));
  assert.ok(wholesale.fieldSchema.some((f: any) => f.key === "moq"));
  const realEstate = r.body.types.find((t: any) => t.slug === "real-estate");
  assert.ok(realEstate.fieldSchema.some((f: any) => f.key === "propertyType" && f.type === "select"));
});

test("POST /opportunities creates one, refuses invalid fields, and lists it by type", async () => {
  const app = await testApp();
  const poster = await createUser(app);

  const bad = await api(app, {
    method: "POST",
    url: "/opportunities",
    token: poster.accessToken,
    payload: { typeSlug: "wholesale", title: "Seeking distributors for a snack line", description: "Tri-state distribution wanted.", fields: { product: "Kosher snacks" } },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /Minimum order quantity is required/);

  const ok = await api(app, {
    method: "POST",
    url: "/opportunities",
    token: poster.accessToken,
    payload: {
      typeSlug: "wholesale",
      title: "Seeking distributors for a snack line",
      description: "Tri-state distribution wanted.",
      fields: { product: "Kosher snacks", moq: "20 cases", pricePerUnit: 12.5, regions: ["Northeast", "Nationwide"] },
    },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.opportunity.status, "OPEN");
  assert.equal(ok.body.type.slug, "wholesale");

  const list = await api(app, { method: "GET", url: "/opportunities?type=wholesale", token: poster.accessToken });
  assert.equal(list.status, 200);
  assert.ok(list.body.items.some((it: any) => it.opportunity.id === ok.body.opportunity.id));
});

test("GET /public/opportunities/:id is readable anonymously and tracks a view", async () => {
  const app = await testApp();
  const poster = await createUser(app);
  const created = await api(app, {
    method: "POST",
    url: "/opportunities",
    token: poster.accessToken,
    payload: { typeSlug: "referrals", title: "Client needs a licensed electrician", description: "Paying referral.", fields: { whoNeeded: "Licensed electrician" } },
  });
  assert.equal(created.status, 201);

  const anon = await api(app, { method: "GET", url: `/public/opportunities/${created.body.opportunity.id}` });
  assert.equal(anon.status, 200);
  assert.equal(anon.body.opportunity.id, created.body.opportunity.id);

  const missing = await api(app, { method: "GET", url: "/public/opportunities/does-not-exist" });
  assert.equal(missing.status, 404);
});

test("POST /opportunities/:id/interest creates a thread + notification, second interest is 409, close hides it", async () => {
  const app = await testApp();
  const poster = await createUser(app);
  const interested = await createUser(app);
  const created = await api(app, {
    method: "POST",
    url: "/opportunities",
    token: poster.accessToken,
    payload: { typeSlug: "collaboration", title: "Looking for a printing partner", description: "40 schools, split the work.", fields: { goal: "Uniform program", commitment: "Design + fulfillment" } },
  });
  assert.equal(created.status, 201);
  const oppId = created.body.opportunity.id;

  const interest = await api(app, { method: "POST", url: `/opportunities/${oppId}/interest`, token: interested.accessToken, payload: { message: "We'd love to help with this." } });
  assert.equal(interest.status, 201);
  assert.ok(interest.body.threadId);

  const posterRead = await api(app, { method: "GET", url: `/threads/${interest.body.threadId}/messages`, token: poster.accessToken });
  assert.equal(posterRead.status, 200);
  assert.ok(posterRead.body.items.some((m: any) => m.body === "We'd love to help with this."));

  const notifs = await tdb().notification.findMany({ where: { personId: poster.personId, kind: "opportunity.interest" } });
  assert.equal(notifs.length, 1);

  const again = await api(app, { method: "POST", url: `/opportunities/${oppId}/interest`, token: interested.accessToken, payload: {} });
  assert.equal(again.status, 409);

  const interests = await api(app, { method: "GET", url: `/opportunities/${oppId}/interests`, token: poster.accessToken });
  assert.equal(interests.status, 200);
  assert.equal(interests.body.interests.length, 1);
  assert.equal(interests.body.interests[0].person.id, interested.personId);

  const closed = await api(app, { method: "POST", url: `/opportunities/${oppId}/close`, token: poster.accessToken });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.opportunity.status, "CLOSED");

  const list = await api(app, { method: "GET", url: "/opportunities?type=collaboration", token: poster.accessToken });
  assert.ok(!list.body.items.some((it: any) => it.opportunity.id === oppId));
});

test("POST /opportunities/:id/question creates a thread without an OpportunityInterest row", async () => {
  const app = await testApp();
  const poster = await createUser(app);
  const asker = await createUser(app);
  const created = await api(app, {
    method: "POST",
    url: "/opportunities",
    token: poster.accessToken,
    payload: { typeSlug: "equipment", title: "Selling 2 Roland VersaCAMM printers", description: "Serviced, with warranty.", fields: { item: "Roland VersaCAMM", condition: "Used - like new", price: 6800, quantity: 2 } },
  });
  assert.equal(created.status, 201);
  const oppId = created.body.opportunity.id;

  const q = await api(app, { method: "POST", url: `/opportunities/${oppId}/question`, token: asker.accessToken, payload: { question: "Are these still under manufacturer warranty?" } });
  assert.equal(q.status, 201);
  assert.ok(q.body.threadId);

  const posterRead = await api(app, { method: "GET", url: `/threads/${q.body.threadId}/messages`, token: poster.accessToken });
  assert.ok(posterRead.body.items.some((m: any) => m.body === "Are these still under manufacturer warranty?"));

  const row = await tdb().opportunityInterest.findUnique({ where: { opportunityId_personId: { opportunityId: oppId, personId: asker.personId } } });
  assert.equal(row, null);
});
