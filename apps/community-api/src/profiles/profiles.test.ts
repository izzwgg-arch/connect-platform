import { test } from "node:test";
import assert from "node:assert/strict";
import { api, createUser, tdb, testApp, uniq } from "../testing/harness.js";
import { canonicalPair } from "../policy/graph.js";

/**
 * The graph domain may not be built yet, so we create ACTIVE Connection rows
 * directly (per the profiles brief) instead of going through /connections/request.
 */
async function connectDirect(aId: string, bId: string) {
  const pair = canonicalPair(aId, bId);
  await tdb().connection.create({ data: { aId: pair.aId, bId: pair.bId, requesterId: aId, status: "ACTIVE", acceptedAt: new Date() } });
}

function multipartPng(fieldName = "file", filename = "dot.png") {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  const boundary = `----profiletest${uniq()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

test("PATCH /me/profile updates fields and rebuilds searchText", async () => {
  const app = await testApp();
  const u = await createUser(app);
  const r = await api(app, {
    method: "PATCH",
    url: "/me/profile",
    token: u.accessToken,
    payload: { headline: "Owner, Weiss Embroidery", industry: "Apparel & uniforms", skills: ["Embroidery", "Screen printing"], links: [{ label: "Website", url: "https://example.test" }] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.profile.headline, "Owner, Weiss Embroidery");
  assert.deepEqual(r.body.profile.skills, ["Embroidery", "Screen printing"]);
  assert.equal(r.body.profile.links[0].url, "https://example.test");

  const row = await tdb().profile.findUnique({ where: { personId: u.personId } });
  assert.ok(row?.searchText?.includes("embroidery"));
  assert.ok(row?.searchText?.includes("apparel & uniforms"));
});

test("PATCH /me/profile rejects an empty body and bad links", async () => {
  const app = await testApp();
  const u = await createUser(app);
  const empty = await api(app, { method: "PATCH", url: "/me/profile", token: u.accessToken, payload: {} });
  assert.equal(empty.status, 400);
  const bad = await api(app, { method: "PATCH", url: "/me/profile", token: u.accessToken, payload: { links: [{ label: "x", url: "not-a-url" }] } });
  assert.equal(bad.status, 400);
});

test("experience CRUD is owner-scoped", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const stranger = await createUser(app);
  const created = await api(app, {
    method: "POST",
    url: "/me/profile/experiences",
    token: owner.accessToken,
    payload: { companyName: "Gold Textiles Inc.", title: "Production manager", startDate: "2019-01-01", isCurrent: true },
  });
  assert.equal(created.status, 201);
  const id = created.body.experience.id;

  const strangerPatch = await api(app, { method: "PATCH", url: `/me/profile/experiences/${id}`, token: stranger.accessToken, payload: { title: "Hacked" } });
  assert.equal(strangerPatch.status, 404);

  const patched = await api(app, { method: "PATCH", url: `/me/profile/experiences/${id}`, token: owner.accessToken, payload: { title: "Plant manager" } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.experience.title, "Plant manager");

  const del = await api(app, { method: "DELETE", url: `/me/profile/experiences/${id}`, token: owner.accessToken });
  assert.equal(del.status, 200);
  const gone = await api(app, { method: "PATCH", url: `/me/profile/experiences/${id}`, token: owner.accessToken, payload: { title: "x" } });
  assert.equal(gone.status, 404);
});

test("GET /me/profile/preferences defaults and PUT merges", async () => {
  const app = await testApp();
  const u = await createUser(app);
  const got = await api(app, { method: "GET", url: "/me/profile/preferences", token: u.accessToken });
  assert.equal(got.status, 200);
  assert.equal(got.body.prefs.showOnline, false);
  assert.equal(got.body.prefs.messageRequests, true);

  const put = await api(app, { method: "PUT", url: "/me/profile/preferences", token: u.accessToken, payload: { prefs: { showOnline: true, messageRequests: false } } });
  assert.equal(put.status, 200);
  assert.equal(put.body.prefs.showOnline, true);
  assert.equal(put.body.prefs.messageRequests, false);
  assert.equal(put.body.prefs.readReceipts, true); // untouched key kept

  const audit = await tdb().auditLog.findFirst({ where: { actorId: u.personId, action: "person.preferences_changed" }, orderBy: { createdAt: "desc" } });
  assert.ok(audit);
});

test("PATCH /me/username: invalid, conflict, success + audit", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);

  const invalid = await api(app, { method: "PATCH", url: "/me/username", token: a.accessToken, payload: { username: "Not Valid!" } });
  assert.equal(invalid.status, 400);

  const takenTarget = b.username;
  const conflictRes = await api(app, { method: "PATCH", url: "/me/username", token: a.accessToken, payload: { username: takenTarget } });
  assert.equal(conflictRes.status, 409);
  assert.match(conflictRes.body.message, /taken/i);

  const fresh = uniq("wembro-").toLowerCase();
  const ok = await api(app, { method: "PATCH", url: "/me/username", token: a.accessToken, payload: { username: fresh } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.username, fresh);

  const audit = await tdb().auditLog.findFirst({ where: { actorId: a.personId, action: "person.username_changed" } });
  assert.ok(audit);
});

test("POST /me/avatar stores an image and sets avatarAssetId", async () => {
  const app = await testApp();
  const u = await createUser(app);
  const { body, contentType } = multipartPng();
  const res = await api(app, { method: "POST", url: "/me/avatar", token: u.accessToken, payload: body, headers: { "content-type": contentType } });
  assert.equal(res.status, 200);
  assert.equal(res.body.asset.kind, "image");
  const profile = await tdb().profile.findUnique({ where: { personId: u.personId } });
  assert.equal(profile?.avatarAssetId, res.body.asset.id);
});

test("public profile: PRIVATE phone hidden from a stranger, visible to self, CONNECTIONS section opens after connecting", async () => {
  const app = await testApp();
  const owner = await createUser(app, { firstName: "Shloimy", lastName: uniq("Weiss") });
  const stranger = await createUser(app);
  const friend = await createUser(app);

  await api(app, { method: "PATCH", url: "/me/profile", token: owner.accessToken, payload: { about: "Second-generation embroidery shop." } });
  // phone defaults to CONNECTIONS in DEFAULT_VISIBILITY; set explicitly to PRIVATE too, and about to CONNECTIONS.
  await api(app, { method: "PUT", url: "/me/privacy", token: owner.accessToken, payload: { phone: "PRIVATE", about: "CONNECTIONS" } });

  const asStranger = await api(app, { method: "GET", url: `/public/people/${owner.username}` });
  assert.equal(asStranger.status, 200);
  assert.equal(asStranger.body.profile.phone, null);
  assert.equal(asStranger.body.profile.about, null);
  assert.equal(asStranger.body.sections.about, false);
  assert.equal(asStranger.body.relationship.degree, 3);

  const asSelf = await api(app, { method: "GET", url: `/public/people/${owner.username}`, token: owner.accessToken });
  assert.equal(asSelf.status, 200);
  assert.equal(asSelf.body.profile.about, "Second-generation embroidery shop.");
  assert.equal(asSelf.body.relationship.degree, 0);
  assert.ok(asSelf.body.visibility);

  await connectDirect(owner.personId, friend.personId);
  const asFriend = await api(app, { method: "GET", url: `/public/people/${owner.username}`, token: friend.accessToken });
  assert.equal(asFriend.status, 200);
  assert.equal(asFriend.body.profile.about, "Second-generation embroidery shop.");
  assert.equal(asFriend.body.relationship.degree, 1);
  assert.equal(asFriend.body.relationship.connectionStatus, "connected");
});

test("public profile: a blocked pair gets 404, never reveals the block", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const blocker = await createUser(app);
  await tdb().block.create({ data: { blockerId: blocker.personId, blockedId: owner.personId } });
  const res = await api(app, { method: "GET", url: `/public/people/${owner.username}`, token: blocker.accessToken });
  assert.equal(res.status, 404);
});

test("username 409 message and public profile 404 for unknown username", async () => {
  const app = await testApp();
  const res = await api(app, { method: "GET", url: `/public/people/no-such-person-${uniq()}` });
  assert.equal(res.status, 404);
});

test("recommendation must be 1st-degree, accept flow shows it, author can delete", async () => {
  const app = await testApp();
  const author = await createUser(app);
  const subject = await createUser(app);
  const stranger = await createUser(app);

  const tooFar = await api(app, { method: "POST", url: `/people/${subject.personId}/recommendations`, token: author.accessToken, payload: { relationship: "Customer", body: "Great work." } });
  assert.equal(tooFar.status, 403);

  await connectDirect(author.personId, subject.personId);
  const created = await api(app, { method: "POST", url: `/people/${subject.personId}/recommendations`, token: author.accessToken, payload: { relationship: "Customer", body: "Delivered on time, every time." } });
  assert.equal(created.status, 201);
  const id = created.body.recommendation.id;

  const dupe = await api(app, { method: "POST", url: `/people/${subject.personId}/recommendations`, token: author.accessToken, payload: { relationship: "Customer", body: "again" } });
  assert.equal(dupe.status, 409);

  const beforeAccept = await api(app, { method: "GET", url: `/people/${subject.username}/recommendations`, token: stranger.accessToken });
  assert.equal(beforeAccept.status, 200);
  assert.equal(beforeAccept.body.items.length, 0);

  const ownPending = await api(app, { method: "GET", url: `/people/${subject.username}/recommendations`, token: subject.accessToken });
  assert.equal(ownPending.body.items.length, 1);
  assert.equal(ownPending.body.items[0].status, "pending");

  const wrongAcceptor = await api(app, { method: "POST", url: `/me/recommendations/${id}/accept`, token: author.accessToken });
  assert.equal(wrongAcceptor.status, 404);

  const accept = await api(app, { method: "POST", url: `/me/recommendations/${id}/accept`, token: subject.accessToken });
  assert.equal(accept.status, 200);

  const afterAccept = await api(app, { method: "GET", url: `/people/${subject.username}/recommendations`, token: stranger.accessToken });
  assert.equal(afterAccept.body.items.length, 1);
  assert.equal(afterAccept.body.items[0].author.id, author.personId);

  const del = await api(app, { method: "DELETE", url: `/me/recommendations/${id}`, token: author.accessToken });
  assert.equal(del.status, 200);
  const afterDelete = await api(app, { method: "GET", url: `/people/${subject.username}/recommendations`, token: stranger.accessToken });
  assert.equal(afterDelete.body.items.length, 0);
});

test("endorsement: 1st-degree only, skill must be listed, count + endorsedByMe show on the public profile", async () => {
  const app = await testApp();
  const endorser = await createUser(app);
  const target = await createUser(app);
  const other = await createUser(app);

  await api(app, { method: "PATCH", url: "/me/profile", token: target.accessToken, payload: { skills: ["Embroidery"] } });

  const notConnected = await api(app, { method: "POST", url: `/people/${target.personId}/endorse`, token: endorser.accessToken, payload: { skill: "Embroidery" } });
  assert.equal(notConnected.status, 403);

  await connectDirect(endorser.personId, target.personId);
  const notListed = await api(app, { method: "POST", url: `/people/${target.personId}/endorse`, token: endorser.accessToken, payload: { skill: "Not a skill" } });
  assert.equal(notListed.status, 400);

  const ok = await api(app, { method: "POST", url: `/people/${target.personId}/endorse`, token: endorser.accessToken, payload: { skill: "Embroidery" } });
  assert.equal(ok.status, 201);

  const profileAsEndorser = await api(app, { method: "GET", url: `/public/people/${target.username}`, token: endorser.accessToken });
  const skill = profileAsEndorser.body.profile.skills.find((s: any) => s.skill === "Embroidery");
  assert.equal(skill.count, 1);
  assert.equal(skill.endorsedByMe, true);

  const profileAsOther = await api(app, { method: "GET", url: `/public/people/${target.username}`, token: other.accessToken });
  const skillOther = profileAsOther.body.profile.skills.find((s: any) => s.skill === "Embroidery");
  assert.equal(skillOther.count, 1);
  assert.equal(skillOther.endorsedByMe, false);

  const removed = await api(app, { method: "DELETE", url: `/people/${target.personId}/endorse`, token: endorser.accessToken, payload: { skill: "Embroidery" } });
  assert.equal(removed.status, 200);
  const afterRemove = await api(app, { method: "GET", url: `/public/people/${target.username}` });
  const skillAfter = afterRemove.body.profile.skills.find((s: any) => s.skill === "Embroidery");
  assert.equal(skillAfter.count, 0);
});

test("/people/:username/activity requires sign-in and returns only public, non-deleted posts", async () => {
  const app = await testApp();
  const author = await createUser(app);
  const viewer = await createUser(app);

  const anon = await api(app, { method: "GET", url: `/people/${author.username}/activity` });
  assert.equal(anon.status, 401);

  await tdb().post.create({ data: { authorId: author.personId, kind: "TEXT", body: "public post", visibility: "PUBLIC" } });
  await tdb().post.create({ data: { authorId: author.personId, kind: "TEXT", body: "private post", visibility: "PRIVATE" } });
  await tdb().post.create({ data: { authorId: author.personId, kind: "TEXT", body: "deleted post", visibility: "PUBLIC", deletedAt: new Date() } });

  const res = await api(app, { method: "GET", url: `/people/${author.username}/activity`, token: viewer.accessToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].body, "public post");
});

test("/people/:username/also-viewed excludes self and blocked, matches by industry", async () => {
  const app = await testApp();
  const me = await createUser(app);
  const similar = await createUser(app);
  const blocked = await createUser(app);
  const viewer = await createUser(app);

  await api(app, { method: "PATCH", url: "/me/profile", token: me.accessToken, payload: { industry: "Apparel & uniforms" } });
  await api(app, { method: "PATCH", url: "/me/profile", token: similar.accessToken, payload: { industry: "Apparel & uniforms" } });
  await api(app, { method: "PATCH", url: "/me/profile", token: blocked.accessToken, payload: { industry: "Apparel & uniforms" } });
  await tdb().block.create({ data: { blockerId: viewer.personId, blockedId: blocked.personId } });

  const res = await api(app, { method: "GET", url: `/people/${me.username}/also-viewed`, token: viewer.accessToken });
  assert.equal(res.status, 200);
  const ids = res.body.items.map((c: any) => c.id);
  assert.ok(ids.includes(similar.personId));
  assert.ok(!ids.includes(blocked.personId));
  assert.ok(!ids.includes(me.personId));
});
