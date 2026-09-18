import { test } from "node:test";
import assert from "node:assert/strict";
import { api, connectUsers, createOrg, createUser, tdb, testApp, uniq } from "../testing/harness.js";

test("intro paths: a private 1st-degree connection alone yields no path", async () => {
  const app = await testApp();
  const requester = await createUser(app);
  const middle = await createUser(app);
  const target = await createUser(app);
  await connectUsers(app, requester, middle);
  await connectUsers(app, middle, target); // target's connections stay CONNECTIONS-visibility by default — not discoverable

  const r = await api(app, { method: "GET", url: `/intros/paths?targetPersonId=${target.personId}`, token: requester.accessToken });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.paths, []);
});

test("intro paths: target's public connections list makes a path discoverable", async () => {
  const app = await testApp();
  const requester = await createUser(app);
  const middle = await createUser(app);
  const target = await createUser(app);
  await connectUsers(app, requester, middle);
  await connectUsers(app, middle, target);
  const priv = await api(app, { method: "PUT", url: "/me/privacy", token: target.accessToken, payload: { connections: "PUBLIC" } });
  assert.equal(priv.status, 200);

  const r = await api(app, { method: "GET", url: `/intros/paths?targetPersonId=${target.personId}`, token: requester.accessToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.paths.length, 1);
  assert.equal(r.body.paths[0].middle.id, middle.personId);
  assert.equal(r.body.paths[0].how, "connected to");
});

test("intro paths: a mutual relationship tag to a business yields a path", async () => {
  const app = await testApp();
  const requester = await createUser(app);
  const middle = await createUser(app);
  const owner = await createUser(app);
  const org = await createOrg(app, owner);
  await connectUsers(app, requester, middle);

  await tdb().relationshipTag.create({ data: { ownerId: middle.personId, targetOrgId: org.id, kind: "CUSTOMER", mutual: true } });

  const r = await api(app, { method: "GET", url: `/intros/paths?targetOrgId=${org.id}`, token: requester.accessToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.paths.length, 1);
  assert.equal(r.body.paths[0].middle.id, middle.personId);
  assert.equal(r.body.paths[0].how, "verified customer of");
  assert.equal(r.body.paths[0].strength, 3);
});

test("intro paths: an unowned (non-mutual) relationship tag alone yields no path", async () => {
  const app = await testApp();
  const requester = await createUser(app);
  const middle = await createUser(app);
  const owner = await createUser(app);
  const org = await createOrg(app, owner);
  await connectUsers(app, requester, middle);
  await tdb().relationshipTag.create({ data: { ownerId: middle.personId, targetOrgId: org.id, kind: "CUSTOMER", mutual: false } });

  const r = await api(app, { method: "GET", url: `/intros/paths?targetOrgId=${org.id}`, token: requester.accessToken });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.paths, []);
});

test("intro paths: owning the business (verified OWNER membership) reads as 'knows the owner'", async () => {
  const app = await testApp();
  const requester = await createUser(app);
  const middle = await createUser(app);
  await connectUsers(app, requester, middle);
  const org = await createOrg(app, middle); // middle is the OWNER, VERIFIED_ADMIN affiliation

  const r = await api(app, { method: "GET", url: `/intros/paths?targetOrgId=${org.id}`, token: requester.accessToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.paths.length, 1);
  assert.equal(r.body.paths[0].how, "knows the owner");
  assert.equal(r.body.paths[0].strength, 3);
});

test("a request can only be created against a middle the path search actually returned", async () => {
  const app = await testApp();
  const requester = await createUser(app);
  const stranger = await createUser(app);
  const target = await createUser(app);

  const r = await api(app, { method: "POST", url: "/intros", token: requester.accessToken, payload: { middleId: stranger.personId, targetPersonId: target.personId } });
  assert.equal(r.status, 404);
  assert.equal(r.body.message, "No introduction path found");
});

test("request → middle approves → INTRO thread with 3 ACTIVE participants; target learns nothing until approval", async () => {
  const app = await testApp();
  const requester = await createUser(app);
  const middle = await createUser(app);
  const target = await createUser(app);
  await connectUsers(app, requester, middle);
  await connectUsers(app, middle, target);
  await api(app, { method: "PUT", url: "/me/privacy", token: target.accessToken, payload: { connections: "PUBLIC" } });

  const create = await api(app, {
    method: "POST",
    url: "/intros",
    token: requester.accessToken,
    payload: { middleId: middle.personId, targetPersonId: target.personId, message: "Would love to work together" },
  });
  assert.equal(create.status, 201);
  assert.equal(create.body.status, "REQUESTED");
  const introId = create.body.id;

  // The target has no visibility into this yet — no notification, no thread.
  const targetNotifsBefore = await tdb().notification.findMany({ where: { personId: target.personId, kind: { in: ["intro.request", "intro.decision"] } } });
  assert.equal(targetNotifsBefore.length, 0);

  const asMiddleList = await api(app, { method: "GET", url: "/intros?role=middle", token: middle.accessToken });
  assert.equal(asMiddleList.status, 200);
  assert.equal(asMiddleList.body.items.length, 1);
  assert.equal(asMiddleList.body.items[0].id, introId);

  const approve = await api(app, { method: "POST", url: `/intros/${introId}/approve`, token: middle.accessToken, payload: {} });
  assert.equal(approve.status, 200);
  assert.equal(approve.body.status, "APPROVED");
  const threadId = approve.body.threadId;
  assert.ok(threadId);

  const participants = await tdb().threadParticipant.findMany({ where: { threadId } });
  assert.equal(participants.length, 3);
  const ids = new Set(participants.map((p) => p.personId));
  assert.ok(ids.has(requester.personId) && ids.has(middle.personId) && ids.has(target.personId));
  assert.ok(participants.every((p) => p.state === "ACTIVE"));

  const thread = await tdb().thread.findUnique({ where: { id: threadId } });
  assert.equal(thread?.kind, "INTRO");

  const firstMessage = await tdb().message.findFirst({ where: { threadId } });
  assert.ok(firstMessage?.body?.includes(requester.firstName) || firstMessage?.body);

  // Only NOW does the target learn about it.
  const targetNotifsAfter = await tdb().notification.findMany({ where: { personId: target.personId } });
  assert.ok(targetNotifsAfter.some((n) => n.kind === "intro.request"));

  const requesterNotifs = await tdb().notification.findMany({ where: { personId: requester.personId, kind: "intro.decision" } });
  assert.equal(requesterNotifs.length, 1);

  // Both parties can read the thread through the ordinary messaging api.
  const threadForTarget = await api(app, { method: "GET", url: `/threads/${threadId}/messages`, token: target.accessToken });
  assert.equal(threadForTarget.status, 200);
});

test("decline is silent to the target and closes the request", async () => {
  const app = await testApp();
  const requester = await createUser(app);
  const middle = await createUser(app);
  const target = await createUser(app);
  await connectUsers(app, requester, middle);
  await connectUsers(app, middle, target);
  await api(app, { method: "PUT", url: "/me/privacy", token: target.accessToken, payload: { connections: "PUBLIC" } });

  const create = await api(app, { method: "POST", url: "/intros", token: requester.accessToken, payload: { middleId: middle.personId, targetPersonId: target.personId } });
  assert.equal(create.status, 201);

  const decline = await api(app, { method: "POST", url: `/intros/${create.body.id}/decline`, token: middle.accessToken });
  assert.equal(decline.status, 200);
  assert.equal(decline.body.status, "DECLINED");

  const targetNotifs = await tdb().notification.findMany({ where: { personId: target.personId, kind: { in: ["intro.request", "intro.decision"] } } });
  assert.equal(targetNotifs.length, 0);

  const requesterNotifs = await tdb().notification.findMany({ where: { personId: requester.personId, kind: "intro.decision" } });
  assert.equal(requesterNotifs.length, 1);

  // Nobody else may act on it now.
  const approveAfter = await api(app, { method: "POST", url: `/intros/${create.body.id}/approve`, token: middle.accessToken, payload: {} });
  assert.equal(approveAfter.status, 409);
});

test("duplicate open request to the same (requester, middle, target) is rejected", async () => {
  const app = await testApp();
  const requester = await createUser(app);
  const middle = await createUser(app);
  const target = await createUser(app);
  await connectUsers(app, requester, middle);
  await connectUsers(app, middle, target);
  await api(app, { method: "PUT", url: "/me/privacy", token: target.accessToken, payload: { connections: "PUBLIC" } });

  const first = await api(app, { method: "POST", url: "/intros", token: requester.accessToken, payload: { middleId: middle.personId, targetPersonId: target.personId } });
  assert.equal(first.status, 201);

  const second = await api(app, { method: "POST", url: "/intros", token: requester.accessToken, payload: { middleId: middle.personId, targetPersonId: target.personId } });
  assert.equal(second.status, 409);
});

test("withdraw closes an open request; only the requester may withdraw", async () => {
  const app = await testApp();
  const requester = await createUser(app);
  const middle = await createUser(app);
  const target = await createUser(app);
  await connectUsers(app, requester, middle);
  await connectUsers(app, middle, target);
  await api(app, { method: "PUT", url: "/me/privacy", token: target.accessToken, payload: { connections: "PUBLIC" } });
  const create = await api(app, { method: "POST", url: "/intros", token: requester.accessToken, payload: { middleId: middle.personId, targetPersonId: target.personId } });

  const forbidden = await api(app, { method: "POST", url: `/intros/${create.body.id}/withdraw`, token: middle.accessToken });
  assert.equal(forbidden.status, 403);

  const withdraw = await api(app, { method: "POST", url: `/intros/${create.body.id}/withdraw`, token: requester.accessToken });
  assert.equal(withdraw.status, 200);
  assert.equal(withdraw.body.status, "WITHDRAWN");
});

test("draft suggest returns the deterministic template when no AI key is configured", async () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const app = await testApp();
    const requester = await createUser(app, { headline: "Freight broker" });
    const middle = await createUser(app);
    const target = await createUser(app);
    await connectUsers(app, requester, middle);
    await connectUsers(app, middle, target);
    await api(app, { method: "PUT", url: "/me/privacy", token: target.accessToken, payload: { connections: "PUBLIC" } });
    const create = await api(app, { method: "POST", url: "/intros", token: requester.accessToken, payload: { middleId: middle.personId, targetPersonId: target.personId, message: "let's talk logistics" } });

    const suggest = await api(app, { method: "POST", url: `/intros/${create.body.id}/draft/suggest`, token: middle.accessToken });
    assert.equal(suggest.status, 200);
    assert.equal(suggest.body.source, "template");
    assert.ok(suggest.body.text.includes("let's talk logistics"));
    assert.ok(suggest.body.text.startsWith("Hi "));
  } finally {
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
  }
});

test("only the middle can approve/decline/draft, and only while REQUESTED", async () => {
  const app = await testApp();
  const requester = await createUser(app);
  const middle = await createUser(app);
  const target = await createUser(app);
  await connectUsers(app, requester, middle);
  await connectUsers(app, middle, target);
  await api(app, { method: "PUT", url: "/me/privacy", token: target.accessToken, payload: { connections: "PUBLIC" } });
  const create = await api(app, { method: "POST", url: "/intros", token: requester.accessToken, payload: { middleId: middle.personId, targetPersonId: target.personId } });

  const requesterTriesApprove = await api(app, { method: "POST", url: `/intros/${create.body.id}/approve`, token: requester.accessToken, payload: {} });
  assert.equal(requesterTriesApprove.status, 403);

  const draftEdit = await api(app, { method: "PATCH", url: `/intros/${create.body.id}/draft`, token: middle.accessToken, payload: { draft: "Custom line" } });
  assert.equal(draftEdit.status, 200);
  assert.equal(draftEdit.body.draft, "Custom line");
});

test("complete requires an APPROVED introduction and either party", async () => {
  const app = await testApp();
  const requester = await createUser(app);
  const middle = await createUser(app);
  const target = await createUser(app);
  await connectUsers(app, requester, middle);
  await connectUsers(app, middle, target);
  await api(app, { method: "PUT", url: "/me/privacy", token: target.accessToken, payload: { connections: "PUBLIC" } });
  const create = await api(app, { method: "POST", url: "/intros", token: requester.accessToken, payload: { middleId: middle.personId, targetPersonId: target.personId } });

  const tooEarly = await api(app, { method: "POST", url: `/intros/${create.body.id}/complete`, token: requester.accessToken });
  assert.equal(tooEarly.status, 409);

  await api(app, { method: "POST", url: `/intros/${create.body.id}/approve`, token: middle.accessToken, payload: {} });
  const strangerTries = await api(app, { method: "POST", url: `/intros/${create.body.id}/complete`, token: target.accessToken });
  assert.equal(strangerTries.status, 403);

  const done = await api(app, { method: "POST", url: `/intros/${create.body.id}/complete`, token: requester.accessToken });
  assert.equal(done.status, 200);
  assert.equal(done.body.status, "COMPLETED");
});
