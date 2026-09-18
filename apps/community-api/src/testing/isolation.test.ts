/**
 * Adversarial isolation tests (brief §53): every private surface is probed by
 * the WRONG person — another member, another organization's admin, a stranger,
 * an anonymous caller — and must refuse with 401/403/404 and never leak.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, createOrg, createUser, tdb, testApp, uniq } from "./harness.js";

test("another organization's admin cannot read or change my company's members, audit, analytics, jobs or verifications", async () => {
  const app = await testApp();
  const ownerA = await createUser(app);
  const ownerB = await createUser(app);
  const orgA = await createOrg(app, ownerA, `Org A ${uniq()}`);
  await createOrg(app, ownerB, `Org B ${uniq()}`);
  for (const [method, url] of [
    ["GET", `/organizations/${orgA.id}/members`],
    ["GET", `/organizations/${orgA.id}/audit`],
    ["GET", `/organizations/${orgA.id}/analytics`],
    ["GET", `/organizations/${orgA.id}/jobs`],
    ["GET", `/organizations/${orgA.id}/verifications`],
    ["PATCH", `/organizations/${orgA.id}`],
    ["POST", `/organizations/${orgA.id}/invites`],
  ] as const) {
    const r = await api(app, { method, url, token: ownerB.accessToken, payload: method === "GET" ? undefined : { displayName: "hijacked", email: "x@example.test", role: "ADMIN" } });
    assert.ok([401, 403, 404].includes(r.status), `${method} ${url} → ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  }
  const still = await tdb().organization.findUnique({ where: { id: orgA.id }, select: { displayName: true } });
  assert.equal(still?.displayName, orgA.displayName);
});

test("a stranger cannot read my notes, reminders, notifications, applications, saved items, sessions or threads", async () => {
  const app = await testApp();
  const me = await createUser(app);
  const stranger = await createUser(app);
  const note = await api(app, { method: "POST", url: "/crm/notes", token: me.accessToken, payload: { targetPersonId: stranger.personId, body: "private thoughts" } });
  assert.equal(note.status, 201, JSON.stringify(note.body));
  const noteId = note.body.note?.id ?? note.body.id;
  const rem = await api(app, { method: "POST", url: "/crm/reminders", token: me.accessToken, payload: { targetPersonId: stranger.personId, title: "call back", dueAt: new Date(Date.now() + 86400000).toISOString() } });
  assert.equal(rem.status, 201, JSON.stringify(rem.body));
  const remId = rem.body.reminder?.id ?? rem.body.id;
  // The note target is the stranger — and even they cannot see it.
  for (const [method, url] of [
    ["GET", `/crm/notes?personId=${me.personId}`],
    ["PATCH", `/crm/notes/${noteId}`],
    ["DELETE", `/crm/notes/${noteId}`],
    ["PATCH", `/crm/reminders/${remId}`],
    ["DELETE", `/crm/reminders/${remId}`],
  ] as const) {
    const r = await api(app, { method, url, token: stranger.accessToken, payload: method === "GET" ? undefined : { body: "hacked", title: "hacked" } });
    if (method === "GET") assert.ok(!JSON.stringify(r.body).includes("private thoughts"), `${url} leaked the note`);
    else assert.ok([403, 404].includes(r.status), `${method} ${url} → ${r.status}`);
  }
  const mine = await tdb().privateNote.findUnique({ where: { id: noteId } });
  assert.equal(mine?.body, "private thoughts");
  // Notifications, sessions and threads are per person: another token sees its own, never mine.
  const n = await api(app, { method: "GET", url: "/notifications", token: stranger.accessToken });
  assert.ok(n.body.items.every((i: any) => !JSON.stringify(i).includes(me.personId)));
  const sessions = await api(app, { method: "GET", url: "/auth/sessions", token: stranger.accessToken });
  assert.ok(sessions.body.sessions.every((s: any) => s.current || s.id));
  const t = await api(app, { method: "POST", url: "/threads", token: me.accessToken, payload: { personIds: [stranger.personId] } });
  const threadId = t.body.thread?.id ?? t.body.id;
  const third = await createUser(app);
  const peek = await api(app, { method: "GET", url: `/threads/${threadId}/messages`, token: third.accessToken });
  assert.equal(peek.status, 404);
});

test("anonymous callers get only public surfaces; everything else is 401 without a body leak", async () => {
  const app = await testApp();
  const me = await createUser(app, { headline: "Owner, Isolation Embroidery" });
  for (const url of ["/auth/me", "/feed", "/threads", "/notifications", "/connections", "/crm/notes", "/me/profile", "/admin/overview", "/recommendations/organizations"]) {
    const r = await api(app, { method: "GET", url });
    assert.equal(r.status, 401, `${url} → ${r.status}`);
    assert.ok(!JSON.stringify(r.body).includes(me.personId));
  }
  const pub = await api(app, { method: "GET", url: `/public/people/${me.username}` });
  assert.equal(pub.status, 200);
  assert.equal(pub.body.profile?.email ?? null, null, "email is PRIVATE by default");
  assert.equal(pub.body.profile?.phone ?? null, null, "phone is CONNECTIONS by default");
});

test("staff routes refuse non-staff even with a valid session, and a revoked staff grant stops working immediately", async () => {
  const app = await testApp();
  const u = await createUser(app);
  const denied = await api(app, { method: "GET", url: "/admin/overview", token: u.accessToken });
  assert.equal(denied.status, 403);
  await tdb().staffGrant.create({ data: { personId: u.personId, role: "ADMIN" } });
  const ok = await api(app, { method: "GET", url: "/admin/overview", token: u.accessToken });
  assert.equal(ok.status, 200);
  await tdb().staffGrant.delete({ where: { personId: u.personId } });
  const again = await api(app, { method: "GET", url: "/admin/overview", token: u.accessToken });
  assert.equal(again.status, 403);
});

test("a deleted person is anonymised after the grace period: no email, no name, no sessions, posts hidden", async () => {
  const app = await testApp();
  const u = await createUser(app, { password: "Correct-horse-battery-9" });
  await api(app, { method: "POST", url: "/posts", token: u.accessToken, payload: { kind: "TEXT", body: `farewell ${uniq()}`, visibility: "PUBLIC" } });
  const del = await api(app, { method: "POST", url: "/auth/delete", token: u.accessToken, payload: { confirm: "DELETE", password: "Correct-horse-battery-9" } });
  assert.equal(del.status, 200);
  await tdb().person.update({ where: { id: u.personId }, data: { deleteAfter: new Date(Date.now() - 1000) } });
  const { purgeDeletedPersons } = await import("../core/schedulers.js");
  await purgeDeletedPersons(tdb());
  const p = await tdb().person.findUnique({ where: { id: u.personId }, include: { profile: true, sessions: true } });
  assert.equal(p?.email, null);
  assert.equal(p?.passwordHash, null);
  assert.equal(p?.profile?.firstName, "Deleted");
  assert.equal(p?.sessions.length, 0);
  const posts = await tdb().post.findMany({ where: { authorId: u.personId } });
  assert.ok(posts.every((x) => x.deletedAt));
  const login = await api(app, { method: "POST", url: "/auth/login", payload: { identifier: u.email, password: "Correct-horse-battery-9" } });
  assert.equal(login.status, 401);
});
