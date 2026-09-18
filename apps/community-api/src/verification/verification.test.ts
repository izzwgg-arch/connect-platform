import { test } from "node:test";
import assert from "node:assert/strict";
import { api, createOrg, createUser, grantStaff, tdb, testApp } from "../testing/harness.js";

test("BUSINESS verification: creates a pending row, needs org.verify", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const org = await createOrg(app, owner);
  const stranger = await createUser(app);

  const forbid = await api(app, { method: "POST", url: `/organizations/${org.id}/verifications`, token: stranger.accessToken, payload: { kind: "BUSINESS" } });
  assert.equal(forbid.status, 403);

  const r = await api(app, { method: "POST", url: `/organizations/${org.id}/verifications`, token: owner.accessToken, payload: { kind: "BUSINESS", evidence: { note: "COI attached" } } });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, "PENDING");
  assert.equal(r.body.kind, "BUSINESS");
});

test("DOMAIN verification with no TXT record returns PENDING with instructions", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const org = await createOrg(app, owner);

  const noDomain = await api(app, { method: "POST", url: `/organizations/${org.id}/verifications`, token: owner.accessToken, payload: { kind: "DOMAIN" } });
  assert.equal(noDomain.status, 400);

  await api(app, { method: "PATCH", url: `/organizations/${org.id}`, token: owner.accessToken, payload: { domain: "example.invalid" } });
  const r = await api(app, { method: "POST", url: `/organizations/${org.id}/verifications`, token: owner.accessToken, payload: { kind: "DOMAIN" } });
  assert.equal(r.status, 202);
  assert.equal(r.body.status, "PENDING");
  assert.match(r.body.instructions, /loopcom-verify=/);
  assert.match(r.body.instructions, /example\.invalid/);

  const list = await api(app, { method: "GET", url: `/organizations/${org.id}/verifications`, token: owner.accessToken });
  const row = list.body.verifications.find((v: any) => v.kind === "DOMAIN");
  assert.equal(row.status, "PENDING");
  assert.ok(row.instructions);

  const recheck = await api(app, { method: "POST", url: `/organizations/${org.id}/verifications/${row.id}/recheck`, token: owner.accessToken });
  assert.equal(recheck.status, 200);
  assert.equal(recheck.body.status, "PENDING");
});

test("staff decide: approves an org verification and notifies the owner", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const org = await createOrg(app, owner);
  const staff = await createUser(app);
  await grantStaff(staff.personId);

  const created = await api(app, { method: "POST", url: `/organizations/${org.id}/verifications`, token: owner.accessToken, payload: { kind: "INSURANCE", evidence: { expires: "2027-03-01" } } });
  assert.equal(created.status, 201);

  const notStaff = await api(app, { method: "GET", url: "/admin/verifications", token: owner.accessToken });
  assert.equal(notStaff.status, 403);

  const pendingList = await api(app, { method: "GET", url: "/admin/verifications?status=PENDING", token: staff.accessToken });
  assert.equal(pendingList.status, 200);
  assert.ok(pendingList.body.verifications.some((v: any) => v.id === created.body.id));

  const decide = await api(app, { method: "POST", url: `/admin/verifications/${created.body.id}/decide`, token: staff.accessToken, payload: { status: "VERIFIED", note: "COI reviewed." } });
  assert.equal(decide.status, 200);
  assert.equal(decide.body.status, "VERIFIED");

  const notif = await tdb().notification.findFirst({ where: { personId: owner.personId, kind: "org.verification" }, orderBy: { createdAt: "desc" } });
  assert.ok(notif);

  const pub = await api(app, { method: "GET", url: `/public/companies/${org.slug}` });
  assert.ok(pub.body.verifications.some((v: any) => v.kind === "INSURANCE"));
});

test("person-level verification: submit, staff decide, and it never leaks a random person's rows", async () => {
  const app = await testApp();
  const person = await createUser(app);
  const staff = await createUser(app);
  await grantStaff(staff.personId);

  const submit = await api(app, { method: "POST", url: "/me/verifications", token: person.accessToken, payload: { kind: "IDENTITY", evidence: { docType: "license" } } });
  assert.equal(submit.status, 201);
  assert.equal(submit.body.status, "PENDING");

  const mine = await api(app, { method: "GET", url: "/me/verifications", token: person.accessToken });
  assert.ok(mine.body.verifications.some((v: any) => v.kind === "IDENTITY" && v.status === "PENDING"));

  const decide = await api(app, { method: "POST", url: `/admin/verifications/${submit.body.id}/decide`, token: staff.accessToken, payload: { status: "REJECTED", note: "Blurry photo." } });
  assert.equal(decide.status, 200);
  assert.equal(decide.body.status, "REJECTED");

  const notif = await tdb().notification.findFirst({ where: { personId: person.personId, kind: "org.verification" }, orderBy: { createdAt: "desc" } });
  assert.ok(notif);
});
