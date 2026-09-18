import { test } from "node:test";
import assert from "node:assert/strict";
import { api, connectUsers, createUser, testApp } from "../testing/harness.js";

async function post(app: any, token: string, body: string, extra: Record<string, unknown> = {}) {
  const r = await api(app, { method: "POST", url: "/posts", token, payload: { body, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.post as { id: string };
}

test("following mode shows a connection's post, chronologically", async () => {
  const app = await testApp();
  const me = await createUser(app);
  const friend = await createUser(app);
  const stranger = await createUser(app);
  await connectUsers(app, me, friend);
  const p1 = await post(app, friend.accessToken, "friend post one");
  await new Promise((r) => setTimeout(r, 5));
  const p2 = await post(app, friend.accessToken, "friend post two");
  await post(app, stranger.accessToken, "stranger post - should not appear");

  const feed = await api(app, { method: "GET", url: "/feed?mode=following", token: me.accessToken });
  assert.equal(feed.status, 200);
  const ids = feed.body.items.map((it: any) => it.post.id);
  assert.ok(ids.includes(p1.id));
  assert.ok(ids.includes(p2.id));
  const idxP1 = ids.indexOf(p1.id);
  const idxP2 = ids.indexOf(p2.id);
  assert.ok(idxP2 < idxP1, "newest first");
});

test("latest mode is public and chronological", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);
  const p1 = await post(app, a.accessToken, "latest one", { visibility: "PUBLIC" });
  await new Promise((r) => setTimeout(r, 5));
  const p2 = await post(app, b.accessToken, "latest two", { visibility: "PUBLIC" });
  const priv = await post(app, a.accessToken, "not latest", { visibility: "PRIVATE" });

  const feed = await api(app, { method: "GET", url: "/feed?mode=latest", token: a.accessToken });
  assert.equal(feed.status, 200);
  const ids = feed.body.items.map((it: any) => it.post.id);
  assert.ok(ids.includes(p1.id));
  assert.ok(ids.includes(p2.id));
  assert.ok(!ids.includes(priv.id));
  assert.ok(ids.indexOf(p2.id) < ids.indexOf(p1.id));
});

test("every feed item carries a recommendationId", async () => {
  const app = await testApp();
  const a = await createUser(app);
  await post(app, a.accessToken, "self post for_you");
  const feed = await api(app, { method: "GET", url: "/feed?mode=for_you", token: a.accessToken });
  assert.equal(feed.status, 200);
  assert.ok(feed.body.items.length > 0);
  for (const it of feed.body.items) {
    assert.ok(it.recommendationId, "every item must carry a recommendationId");
  }
});

test("diversity: no more than 2 consecutive posts by the same author in for_you", async () => {
  const app = await testApp();
  const me = await createUser(app);
  const chatty = await createUser(app);
  await connectUsers(app, me, chatty);
  for (let i = 0; i < 3; i++) {
    await post(app, chatty.accessToken, `chatty post ${i}`);
    await new Promise((r) => setTimeout(r, 3));
  }
  const feed = await api(app, { method: "GET", url: "/feed?mode=for_you&limit=50", token: me.accessToken });
  assert.equal(feed.status, 200);
  const authorIds = feed.body.items.map((it: any) => it.post.author.id);
  let run = 0;
  let maxRun = 0;
  for (let i = 0; i < authorIds.length; i++) {
    if (i > 0 && authorIds[i] === authorIds[i - 1]) run++;
    else run = 1;
    maxRun = Math.max(maxRun, run);
  }
  assert.ok(maxRun <= 2, `expected at most 2 consecutive posts from one author, got a run of ${maxRun}`);
});

test("hidden posts never reappear in the feed", async () => {
  const app = await testApp();
  const me = await createUser(app);
  const author = await createUser(app);
  await connectUsers(app, me, author);
  const target = await post(app, author.accessToken, "hide this one from my feed");
  await api(app, { method: "POST", url: `/posts/${target.id}/hide`, token: me.accessToken });
  const feed = await api(app, { method: "GET", url: "/feed?mode=following", token: me.accessToken });
  const ids = feed.body.items.map((it: any) => it.post.id);
  assert.ok(!ids.includes(target.id));
});

test("a blocked author's posts are absent from the feed", async () => {
  const app = await testApp();
  const me = await createUser(app);
  const jerk = await createUser(app);
  await connectUsers(app, me, jerk);
  const p = await post(app, jerk.accessToken, "you will not see this");
  const block = await api(app, { method: "POST", url: `/people/${jerk.personId}/block`, token: me.accessToken });
  assert.equal(block.status, 200);
  const feed = await api(app, { method: "GET", url: "/feed?mode=following", token: me.accessToken });
  const ids = feed.body.items.map((it: any) => it.post.id);
  assert.ok(!ids.includes(p.id));
});

test("feed requires sign-in", async () => {
  const app = await testApp();
  const r = await api(app, { method: "GET", url: "/feed?mode=latest" });
  assert.equal(r.status, 401);
});

test("an invalid mode is refused", async () => {
  const app = await testApp();
  const u = await createUser(app);
  const r = await api(app, { method: "GET", url: "/feed?mode=nonsense", token: u.accessToken });
  assert.equal(r.status, 400);
});

test("GET /feed/rail tolerates an empty platform and always returns the three lists", async () => {
  const app = await testApp();
  const u = await createUser(app);
  const rail = await api(app, { method: "GET", url: "/feed/rail", token: u.accessToken });
  assert.equal(rail.status, 200);
  assert.ok(Array.isArray(rail.body.businesses));
  assert.ok(Array.isArray(rail.body.rfqs));
  assert.ok(Array.isArray(rail.body.events));
});

test("jobs and opportunities modes only return their kind (empty when none exist)", async () => {
  const app = await testApp();
  const u = await createUser(app);
  const jobs = await api(app, { method: "GET", url: "/feed?mode=jobs", token: u.accessToken });
  assert.equal(jobs.status, 200);
  assert.equal(jobs.body.items.length, 0);
  const opp = await api(app, { method: "GET", url: "/feed?mode=opportunities", token: u.accessToken });
  assert.equal(opp.status, 200);
  assert.equal(opp.body.items.length, 0);
});
