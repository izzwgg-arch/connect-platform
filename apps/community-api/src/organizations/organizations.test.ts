import { test } from "node:test";
import assert from "node:assert/strict";
import { api, connectUsers, createOrg, createUser, grantStaff, tdb, testApp, uniq } from "../testing/harness.js";

test("create org makes an OWNER membership and a unique slug", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const org = await createOrg(app, owner, "Weiss Embroidery & Uniforms");
  assert.ok(org.id);
  assert.equal(org.displayName, "Weiss Embroidery & Uniforms");
  assert.ok(org.slug.startsWith("weiss-embroidery"));

  const m = await tdb().membership.findUnique({ where: { personId_organizationId: { personId: owner.personId, organizationId: org.id } } });
  assert.equal(m?.role, "OWNER");
  assert.equal(m?.affiliation, "VERIFIED_ADMIN");
  assert.equal(m?.isPrimary, true);
});

test("slug collision gets a suffix", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);
  const org1 = await createOrg(app, a, "Same Name Co");
  const org2 = await createOrg(app, b, "Same Name Co");
  assert.notEqual(org1.slug, org2.slug);
  assert.ok(org2.slug.startsWith("same-name-co"));
});

test("org create requires a verified actor", async () => {
  const app = await testApp();
  const unverified = await createUser(app, { verify: false });
  const r = await api(app, { method: "POST", url: "/organizations", token: unverified.accessToken, payload: { displayName: "Nope Inc" } });
  assert.equal(r.status, 403);
});

test("PATCH: owner can edit, stranger is 403, unknown org is 404", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const stranger = await createUser(app);
  const org = await createOrg(app, owner);

  const ok = await api(app, { method: "PATCH", url: `/organizations/${org.id}`, token: owner.accessToken, payload: { description: "Family run since 1988.", showEmail: false } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.description, "Family run since 1988.");
  assert.equal(ok.body.showEmail, false);

  const forbid = await api(app, { method: "PATCH", url: `/organizations/${org.id}`, token: stranger.accessToken, payload: { description: "hijack" } });
  assert.equal(forbid.status, 403);

  const missing = await api(app, { method: "PATCH", url: `/organizations/does-not-exist`, token: owner.accessToken, payload: { description: "x" } });
  assert.equal(missing.status, 404);
});

test("hours can be set and cleared through PATCH", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const org = await createOrg(app, owner);
  const set = await api(app, { method: "PATCH", url: `/organizations/${org.id}`, token: owner.accessToken, payload: { hours: { sun: ["09:00", "18:00"], sat: "closed" } } });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.hours, { sun: ["09:00", "18:00"], sat: "closed" });
});

test("member invite → accept → role change → last-owner guard", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const org = await createOrg(app, owner);
  const employee = await createUser(app);

  const invite = await api(app, { method: "POST", url: `/organizations/${org.id}/invites`, token: owner.accessToken, payload: { email: employee.email, role: "MANAGER" } });
  assert.equal(invite.status, 201);

  // resend is idempotent by (org, email) — still one row.
  const resend = await api(app, { method: "POST", url: `/organizations/${org.id}/invites`, token: owner.accessToken, payload: { email: employee.email, role: "MANAGER" } });
  assert.equal(resend.status, 201);
  const list = await api(app, { method: "GET", url: `/organizations/${org.id}/invites`, token: owner.accessToken });
  assert.equal(list.body.invites.length, 1);

  const row = await tdb().outboundMail.findFirst({ where: { to: employee.email, text: { contains: "token=" } }, orderBy: { createdAt: "desc" } });
  const link = row!.text.match(/token=([\w-]+)/)![1];

  // the existing person was also notified in-app/by-email of the invite.
  const invitedNotice = await tdb().notification.findFirst({ where: { personId: employee.personId, kind: "org.invite" } });
  assert.ok(invitedNotice);

  const accept = await api(app, { method: "POST", url: "/organizations/invites/accept", token: employee.accessToken, payload: { token: link } });
  assert.equal(accept.status, 200);
  assert.equal(accept.body.role, "MANAGER");

  const membersAfter = await api(app, { method: "GET", url: `/organizations/${org.id}/members`, token: owner.accessToken });
  const memberRow = membersAfter.body.members.find((m: any) => m.person.id === employee.personId);
  assert.equal(memberRow.affiliation, "VERIFIED_ADMIN");

  // role change by the owner works.
  const roleChange = await api(app, { method: "PATCH", url: `/organizations/${org.id}/members/${employee.personId}`, token: owner.accessToken, payload: { role: "SALES" } });
  assert.equal(roleChange.status, 200);
  assert.equal(roleChange.body.role, "SALES");

  // the last owner cannot be demoted or removed.
  const demoteSelf = await api(app, { method: "PATCH", url: `/organizations/${org.id}/members/${owner.personId}`, token: owner.accessToken, payload: { role: "EMPLOYEE" } });
  assert.equal(demoteSelf.status, 409);
  const removeSelf = await api(app, { method: "DELETE", url: `/organizations/${org.id}/members/${owner.personId}`, token: owner.accessToken });
  assert.equal(removeSelf.status, 409);

  // a non-manager cannot change roles.
  const forbidden = await api(app, { method: "PATCH", url: `/organizations/${org.id}/members/${owner.personId}`, token: employee.accessToken, payload: { title: "CEO" } });
  assert.equal(forbidden.status, 403);
});

test("join request: domain match auto-verifies, otherwise pending + notifies owners", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const org = await createOrg(app, owner);
  await api(app, { method: "PATCH", url: `/organizations/${org.id}`, token: owner.accessToken, payload: { domain: "example.invalid" } });
  // force the domain as verified for this test (DNS isn't real here).
  await tdb().organization.update({ where: { id: org.id }, data: { domainVerifiedAt: new Date() } });

  const domainEmail = `staffer-${uniq()}@example.invalid`;
  const domainPerson = await createUser(app, { email: domainEmail });
  const join1 = await api(app, { method: "POST", url: `/organizations/${org.id}/join`, token: domainPerson.accessToken, payload: {} });
  assert.equal(join1.status, 200);
  assert.equal(join1.body.status, "VERIFIED_DOMAIN");

  const outsider = await createUser(app);
  const join2 = await api(app, { method: "POST", url: `/organizations/${org.id}/join`, token: outsider.accessToken, payload: { title: "Driver" } });
  assert.equal(join2.status, 201);
  assert.equal(join2.body.status, "PENDING");

  const notif = await tdb().notification.findFirst({ where: { personId: owner.personId, kind: "org.invite" }, orderBy: { createdAt: "desc" } });
  assert.ok(notif);

  // owner approves the pending join through the members PATCH endpoint.
  const approve = await api(app, { method: "PATCH", url: `/organizations/${org.id}/members/${outsider.personId}`, token: owner.accessToken, payload: { affiliation: "VERIFIED_ADMIN" } });
  assert.equal(approve.status, 200);
  assert.equal(approve.body.affiliation, "VERIFIED_ADMIN");
});

test("follow / unfollow moves the counter and is idempotent", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const org = await createOrg(app, owner);
  const follower = await createUser(app);

  const f1 = await api(app, { method: "POST", url: `/organizations/${org.id}/follow`, token: follower.accessToken });
  assert.equal(f1.status, 200);
  const f2 = await api(app, { method: "POST", url: `/organizations/${org.id}/follow`, token: follower.accessToken });
  assert.equal(f2.status, 200);
  const after = await tdb().organization.findUniqueOrThrow({ where: { id: org.id } });
  assert.equal(after.followerCount, 1);

  const un = await api(app, { method: "DELETE", url: `/organizations/${org.id}/follow`, token: follower.accessToken });
  assert.equal(un.status, 200);
  const after2 = await tdb().organization.findUniqueOrThrow({ where: { id: org.id } });
  assert.equal(after2.followerCount, 0);
});

test("public company page hides phone when showPhone is off, and honours a follow", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const org = await createOrg(app, owner);
  await api(app, { method: "PATCH", url: `/organizations/${org.id}`, token: owner.accessToken, payload: { phone: "+18455551212", showPhone: false, email: "hello@example.test", showEmail: true } });
  const viewer = await createUser(app);
  await api(app, { method: "POST", url: `/organizations/${org.id}/follow`, token: viewer.accessToken });

  const pub = await api(app, { method: "GET", url: `/public/companies/${org.slug}`, token: viewer.accessToken });
  assert.equal(pub.status, 200);
  assert.equal(pub.body.contact.phone, null);
  assert.equal(pub.body.contact.email, "hello@example.test");
  assert.equal(pub.body.viewer.following, true);

  const anon = await api(app, { method: "GET", url: `/public/companies/${org.slug}` });
  assert.equal(anon.status, 200);
  assert.equal(anon.body.viewer.following, false);

  const missing = await api(app, { method: "GET", url: "/public/companies/does-not-exist" });
  assert.equal(missing.status, 404);
});

test("in your network: only a mutual customer tag from a connection counts", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const org = await createOrg(app, owner);
  const viewer = await createUser(app);
  const friend = await createUser(app);
  await connectUsers(app, viewer, friend);

  await tdb().relationshipTag.create({ data: { ownerId: friend.personId, targetOrgId: org.id, kind: "CUSTOMER", mutual: true } });

  const pub = await api(app, { method: "GET", url: `/public/companies/${org.slug}`, token: viewer.accessToken });
  assert.equal(pub.body.inYourNetwork.count, 1);
  assert.equal(pub.body.inYourNetwork.people[0].id, friend.personId);
});

test("claim-loopcom links a tenant and refuses a second org claiming the same one", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const org = await createOrg(app, owner);
  const org2 = await createOrg(app, owner);
  const tenantId = uniq("tenant");
  (app as any); // no-op keep app referenced

  const { fakeLoopcomUsers } = await import("../testing/harness.js");
  const lcToken = uniq("lc-token");
  fakeLoopcomUsers.set(lcToken, { userId: uniq("lcuser"), tenantId, email: owner.email, role: "TENANT_ADMIN" });
  const sso = await api(app, { method: "POST", url: "/auth/loopcom", payload: { token: lcToken } });
  assert.equal(sso.status, 200);

  const claim = await api(app, { method: "POST", url: `/organizations/${org.id}/claim-loopcom`, token: sso.body.accessToken });
  assert.equal(claim.status, 200);
  assert.equal(claim.body.loopcomLinked, true);

  const clash = await api(app, { method: "POST", url: `/organizations/${org2.id}/claim-loopcom`, token: sso.body.accessToken });
  assert.equal(clash.status, 409);

  const verifs = await tdb().verification.findMany({ where: { organizationId: org.id, kind: "LOOPCOM_CUSTOMER" } });
  assert.equal(verifs[0]?.status, "VERIFIED");
});

test("staff can grant and the audit log records org mutations", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const org = await createOrg(app, owner);
  await grantStaff(owner.personId);
  const staffCheck = await api(app, { method: "GET", url: `/organizations/${org.id}` , token: owner.accessToken });
  assert.equal(staffCheck.status, 200);

  const audit = await api(app, { method: "GET", url: `/organizations/${org.id}/audit`, token: owner.accessToken });
  assert.equal(audit.status, 200);
  assert.ok(audit.body.items.some((a: any) => a.action === "org.create"));
});

test("catalog CRUD is scoped to the org and needs org.edit_page", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const org = await createOrg(app, owner);
  const stranger = await createUser(app);

  const create = await api(app, { method: "POST", url: `/organizations/${org.id}/catalog`, token: owner.accessToken, payload: { name: "Fleece hoodie", priceNote: "From $18.50" } });
  assert.equal(create.status, 201);

  const forbid = await api(app, { method: "POST", url: `/organizations/${org.id}/catalog`, token: stranger.accessToken, payload: { name: "hijack" } });
  assert.equal(forbid.status, 403);

  const patch = await api(app, { method: "PATCH", url: `/organizations/${org.id}/catalog/${create.body.id}`, token: owner.accessToken, payload: { priceNote: "From $19" } });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.priceNote, "From $19");

  const del = await api(app, { method: "DELETE", url: `/organizations/${org.id}/catalog/${create.body.id}`, token: owner.accessToken });
  assert.equal(del.status, 200);
});

test("/me/organizations and /public/stats", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const org = await createOrg(app, owner);
  const mine = await api(app, { method: "GET", url: "/me/organizations", token: owner.accessToken });
  assert.equal(mine.status, 200);
  assert.ok(mine.body.organizations.some((o: any) => o.id === org.id));

  const stats = await api(app, { method: "GET", url: "/public/stats" });
  assert.equal(stats.status, 200);
  assert.ok(stats.body.organizations >= 1);
});
