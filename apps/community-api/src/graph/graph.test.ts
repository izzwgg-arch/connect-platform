import { test } from "node:test";
import assert from "node:assert/strict";
import { api, connectUsers, createUser, tdb, testApp, uniq } from "../testing/harness.js";

test("connection request → accept, both directions", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);

  const req1 = await api(app, { method: "POST", url: "/connections/request", token: a.accessToken, payload: { personId: b.personId, message: "hi" } });
  assert.equal(req1.status, 201);
  assert.equal(req1.body.status, "PENDING");

  const pendingB = await api(app, { method: "GET", url: "/connections/pending", token: b.accessToken });
  assert.equal(pendingB.body.incoming.length, 1);
  assert.equal(pendingB.body.incoming[0].person.id, a.personId);

  const acc = await api(app, { method: "POST", url: `/connections/${req1.body.id}/accept`, token: b.accessToken });
  assert.equal(acc.status, 200);
  assert.equal(acc.body.status, "ACTIVE");

  const list = await api(app, { method: "GET", url: "/connections", token: a.accessToken });
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].person.id, b.personId);
});

test("cross request auto-accepts instead of creating a second pending row", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);

  const first = await api(app, { method: "POST", url: "/connections/request", token: a.accessToken, payload: { personId: b.personId } });
  assert.equal(first.status, 201);

  // b asks a back before responding — this should auto-accept the existing row.
  const second = await api(app, { method: "POST", url: "/connections/request", token: b.accessToken, payload: { personId: a.personId } });
  assert.equal(second.status, 200);
  assert.equal(second.body.status, "ACTIVE");
  assert.equal(second.body.id, first.body.id);
});

test("duplicate active connection is refused with 409", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);
  await connectUsers(app, a, b);

  const dupe = await api(app, { method: "POST", url: "/connections/request", token: a.accessToken, payload: { personId: b.personId } });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.body.error, "already_connected");
});

test("self connection request is a 400", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const self = await api(app, { method: "POST", url: "/connections/request", token: a.accessToken, payload: { personId: a.personId } });
  assert.equal(self.status, 400);
  assert.equal(self.body.error, "self_connection");
});

test("ignore is silent to the requester — their outgoing tab still reads pending", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);

  const req1 = await api(app, { method: "POST", url: "/connections/request", token: a.accessToken, payload: { personId: b.personId } });
  const ign = await api(app, { method: "POST", url: `/connections/${req1.body.id}/ignore`, token: b.accessToken });
  assert.equal(ign.status, 200);
  assert.equal(ign.body.status, "IGNORED");

  const pendingA = await api(app, { method: "GET", url: "/connections/pending", token: a.accessToken });
  assert.equal(pendingA.body.outgoing.length, 1, "requester still sees it as an outgoing ask");
  assert.equal(pendingA.body.outgoing[0].id, req1.body.id);

  const pendingB = await api(app, { method: "GET", url: "/connections/pending", token: b.accessToken });
  assert.equal(pendingB.body.incoming.length, 0, "recipient already resolved it, it's gone from their incoming list");
});

test("withdraw", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);
  const req1 = await api(app, { method: "POST", url: "/connections/request", token: a.accessToken, payload: { personId: b.personId } });
  const w = await api(app, { method: "POST", url: `/connections/${req1.body.id}/withdraw`, token: a.accessToken });
  assert.equal(w.status, 200);
  assert.equal(w.body.status, "WITHDRAWN");
  // b can never withdraw a's request
  const req2 = await api(app, { method: "POST", url: "/connections/request", token: a.accessToken, payload: { personId: b.personId } });
  const forbiddenTry = await api(app, { method: "POST", url: `/connections/${req2.body.id}/withdraw`, token: b.accessToken });
  assert.equal(forbiddenTry.status, 403);
});

test("remove an active connection, then block prevents a future request", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);
  const conn = await connectUsers(app, a, b);

  const del = await api(app, { method: "DELETE", url: `/connections/${conn.id}`, token: a.accessToken });
  assert.equal(del.status, 200);

  const listA = await api(app, { method: "GET", url: "/connections", token: a.accessToken });
  assert.equal(listA.body.items.length, 0);

  const block = await api(app, { method: "POST", url: `/people/${b.personId}/block`, token: a.accessToken });
  assert.equal(block.status, 200);

  const retry = await api(app, { method: "POST", url: "/connections/request", token: b.accessToken, payload: { personId: a.personId } });
  assert.equal(retry.status, 404, "blocked either way never reveals the block — it just looks like the person doesn't exist");
});

test("block removes an active connection and unblock does not restore it", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);
  await connectUsers(app, a, b);

  const block = await api(app, { method: "POST", url: `/people/${b.personId}/block`, token: a.accessToken });
  assert.equal(block.status, 200);
  const listA = await api(app, { method: "GET", url: "/connections", token: a.accessToken });
  assert.equal(listA.body.items.length, 0, "blocking removed the connection");

  const unblock = await api(app, { method: "DELETE", url: `/people/${b.personId}/block`, token: a.accessToken });
  assert.equal(unblock.status, 200);
  const listA2 = await api(app, { method: "GET", url: "/connections", token: a.accessToken });
  assert.equal(listA2.body.items.length, 0, "unblocking never resurrects a removed connection");
});

test("outreach anti-spam cap refuses the next request with an explainable sentence", async () => {
  process.env.COMMUNITY_TEST_OUTREACH_CAP = "3";
  try {
    const app = await testApp();
    const a = await createUser(app);
    const targets = [await createUser(app), await createUser(app), await createUser(app), await createUser(app)];
    for (let i = 0; i < 3; i++) {
      const r = await api(app, { method: "POST", url: "/connections/request", token: a.accessToken, payload: { personId: targets[i].personId } });
      assert.equal(r.status, 201, `request ${i} should succeed`);
    }
    const fourth = await api(app, { method: "POST", url: "/connections/request", token: a.accessToken, payload: { personId: targets[3].personId } });
    assert.equal(fourth.status, 429);
    assert.match(fourth.body.message, /requests|try again/i);
  } finally {
    delete process.env.COMMUNITY_TEST_OUTREACH_CAP;
  }
});

test("relationship tags: mutual flips true when both sides tag the complementary kind", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);
  await connectUsers(app, a, b);

  const setA = await api(app, { method: "PUT", url: `/people/${b.personId}/relationship`, token: a.accessToken, payload: { kinds: ["CUSTOMER"] } });
  assert.equal(setA.status, 200);
  assert.equal(setA.body.kinds[0].mutual, false, "b hasn't tagged back yet");

  const setB = await api(app, { method: "PUT", url: `/people/${a.personId}/relationship`, token: b.accessToken, payload: { kinds: ["VENDOR"] } });
  assert.equal(setB.status, 200);
  assert.equal(setB.body.kinds[0].mutual, true, "VENDOR complements CUSTOMER — flips true immediately");

  const getA = await api(app, { method: "GET", url: `/people/${b.personId}/relationship`, token: a.accessToken });
  assert.equal(getA.body.kinds[0].mutual, true, "a's own row was recomputed too");

  // b removes the tag — both sides should fall back to non-mutual.
  const clearB = await api(app, { method: "PUT", url: `/people/${a.personId}/relationship`, token: b.accessToken, payload: { kinds: [] } });
  assert.equal(clearB.status, 200);
  const getA2 = await api(app, { method: "GET", url: `/people/${b.personId}/relationship`, token: a.accessToken });
  assert.equal(getA2.body.kinds[0].mutual, false);
});

test("report creates one OPEN case and a second report increments it", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);
  const c = await createUser(app);

  const r1 = await api(app, { method: "POST", url: "/reports", token: a.accessToken, payload: { targetType: "person", targetId: b.personId, reason: "SPAM" } });
  assert.equal(r1.status, 201);
  const caseId = r1.body.caseId;

  const r2 = await api(app, { method: "POST", url: "/reports", token: c.accessToken, payload: { targetType: "person", targetId: b.personId, reason: "SCAM" } });
  assert.equal(r2.status, 201);
  assert.equal(r2.body.caseId, caseId, "same open case, incremented");

  const kase = await tdb().moderationCase.findUnique({ where: { id: caseId } });
  assert.equal(kase?.reportCount, 2);
  assert.equal(kase?.status, "OPEN");

  // duplicate report from the same reporter is a friendly 200, not a new row.
  const r3 = await api(app, { method: "POST", url: "/reports", token: a.accessToken, payload: { targetType: "person", targetId: b.personId, reason: "SPAM" } });
  assert.equal(r3.status, 200);
});

test("suggestions surface a 2nd-degree person with a mutual reason, and dismissal removes it", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);
  const c = await createUser(app); // 2nd degree from a, via b

  await connectUsers(app, a, b);
  await connectUsers(app, b, c);

  const sugg = await api(app, { method: "GET", url: "/network/suggestions", token: a.accessToken });
  assert.equal(sugg.status, 200);
  const found = sugg.body.items.find((i: any) => i.person.id === c.personId);
  assert.ok(found, "c should be suggested as a 2nd-degree connection");
  assert.match(found.reason, /mutual/);

  const dismiss = await api(app, { method: "POST", url: `/network/suggestions/${found.recommendationId}/dismiss`, token: a.accessToken });
  assert.equal(dismiss.status, 200);

  const sugg2 = await api(app, { method: "GET", url: "/network/suggestions", token: a.accessToken });
  const stillThere = sugg2.body.items.find((i: any) => i.person.id === c.personId);
  assert.equal(stillThere, undefined, "dismissed suggestions don't come back");
});

test("contact import match only returns verified people, never reveals non-matches", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const verified = await createUser(app); // createUser verifies email by default

  const unverifiedEmail = `${uniq("nv")}@example.test`;
  const match = await api(app, {
    method: "POST",
    url: "/network/match",
    token: a.accessToken,
    payload: { emails: [verified.email, unverifiedEmail, "nobody-at-all@example.test"] },
  });
  assert.equal(match.status, 200);
  assert.equal(match.body.matches.length, 1);
  assert.equal(match.body.matches[0].id, verified.personId);
});

test("follow / unfollow and mute / unmute", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);

  const follow = await api(app, { method: "POST", url: `/people/${b.personId}/follow`, token: a.accessToken });
  assert.equal(follow.status, 200);
  const following = await api(app, { method: "GET", url: "/me/following", token: a.accessToken });
  assert.equal(following.body.items.length, 1);

  const unfollow = await api(app, { method: "DELETE", url: `/people/${b.personId}/follow`, token: a.accessToken });
  assert.equal(unfollow.status, 200);
  const following2 = await api(app, { method: "GET", url: "/me/following", token: a.accessToken });
  assert.equal(following2.body.items.length, 0);

  const mute = await api(app, { method: "POST", url: `/people/${b.personId}/mute`, token: a.accessToken });
  assert.equal(mute.status, 200);
  const muted = await api(app, { method: "GET", url: "/me/muted", token: a.accessToken });
  assert.equal(muted.body.people.length, 1);
  const unmute = await api(app, { method: "DELETE", url: `/people/${b.personId}/mute`, token: a.accessToken });
  assert.equal(unmute.status, 200);
});
