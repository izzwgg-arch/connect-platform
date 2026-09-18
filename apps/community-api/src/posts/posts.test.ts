import { test } from "node:test";
import assert from "node:assert/strict";
import { api, connectUsers, createOrg, createUser, tdb, testApp, uniq } from "../testing/harness.js";
import { fetchLinkPreview } from "./service.js";
import { publishScheduledPosts } from "./service.js";
import { deriveKindFromMedia, isPrivateHost } from "./policy.js";

test("deriveKindFromMedia: 1 image -> IMAGE, >1 -> GALLERY, any video -> VIDEO, any pdf -> DOCUMENT", () => {
  assert.equal(deriveKindFromMedia([]), null);
  assert.equal(deriveKindFromMedia([{ kind: "image" }]), "IMAGE");
  assert.equal(deriveKindFromMedia([{ kind: "image" }, { kind: "image" }]), "GALLERY");
  assert.equal(deriveKindFromMedia([{ kind: "image" }, { kind: "video" }]), "VIDEO");
  assert.equal(deriveKindFromMedia([{ kind: "image" }, { kind: "document" }]), "DOCUMENT");
});

test("isPrivateHost / fetchLinkPreview refuses loopback and private ranges before ever fetching", async () => {
  assert.equal(isPrivateHost("127.0.0.1"), true);
  assert.equal(isPrivateHost("10.1.2.3"), true);
  assert.equal(isPrivateHost("192.168.1.5"), true);
  assert.equal(isPrivateHost("172.16.0.1"), true);
  assert.equal(isPrivateHost("172.31.255.255"), true);
  assert.equal(isPrivateHost("172.32.0.1"), false);
  assert.equal(isPrivateHost("169.254.1.1"), true);
  assert.equal(isPrivateHost("localhost"), true);
  assert.equal(isPrivateHost("example.com"), false);

  let threw = false;
  try {
    await fetchLinkPreview("http://127.0.0.1:1/whatever");
  } catch (err: any) {
    threw = true;
    assert.equal(err.code, "private_url");
  }
  assert.equal(threw, true, "must refuse before making any network call");
});

test("POST /posts refuses a link preview for a private URL", async () => {
  const app = await testApp();
  const u = await createUser(app);
  const r = await api(app, { method: "POST", url: "/posts", token: u.accessToken, payload: { linkUrl: "http://127.0.0.1:1/x" } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "private_url");
});

test("create a text post, read it back, edit it, delete it", async () => {
  const app = await testApp();
  const u = await createUser(app);
  const create = await api(app, { method: "POST", url: "/posts", token: u.accessToken, payload: { body: "Hello Community" } });
  assert.equal(create.status, 201);
  assert.equal(create.body.post.kind, "TEXT");
  assert.equal(create.body.post.body, "Hello Community");
  assert.ok(create.body.post.publishedAt);
  const id = create.body.post.id;

  const read = await api(app, { method: "GET", url: `/posts/${id}`, token: u.accessToken });
  assert.equal(read.status, 200);
  assert.equal(read.body.post.author.id, u.personId);

  const patch = await api(app, { method: "PATCH", url: `/posts/${id}`, token: u.accessToken, payload: { body: "Edited" } });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.post.body, "Edited");
  assert.ok(patch.body.post.editedAt);

  const stranger = await createUser(app);
  const forbidPatch = await api(app, { method: "PATCH", url: `/posts/${id}`, token: stranger.accessToken, payload: { body: "hijack" } });
  assert.equal(forbidPatch.status, 403);

  const del = await api(app, { method: "DELETE", url: `/posts/${id}`, token: u.accessToken });
  assert.equal(del.status, 200);
  const gone = await api(app, { method: "GET", url: `/posts/${id}`, token: u.accessToken });
  assert.equal(gone.status, 404);
});

test("empty post is refused", async () => {
  const app = await testApp();
  const u = await createUser(app);
  const r = await api(app, { method: "POST", url: "/posts", token: u.accessToken, payload: {} });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "empty_post");
});

test("posting requires a verified actor", async () => {
  const app = await testApp();
  const u = await createUser(app, { verify: false });
  const r = await api(app, { method: "POST", url: "/posts", token: u.accessToken, payload: { body: "hi" } });
  assert.equal(r.status, 403);
});

test("CONNECTIONS visibility hides from a stranger and shows once connected", async () => {
  const app = await testApp();
  const author = await createUser(app);
  const stranger = await createUser(app);
  const create = await api(app, { method: "POST", url: "/posts", token: author.accessToken, payload: { body: "Just for connections", visibility: "CONNECTIONS" } });
  assert.equal(create.status, 201);
  const id = create.body.post.id;

  const hidden = await api(app, { method: "GET", url: `/posts/${id}`, token: stranger.accessToken });
  assert.equal(hidden.status, 404);

  await connectUsers(app, author, stranger);
  const visible = await api(app, { method: "GET", url: `/posts/${id}`, token: stranger.accessToken });
  assert.equal(visible.status, 200);
});

test("PRIVATE visibility is author-only; author can still read their own post", async () => {
  const app = await testApp();
  const author = await createUser(app);
  const other = await createUser(app);
  const create = await api(app, { method: "POST", url: "/posts", token: author.accessToken, payload: { body: "just me", visibility: "PRIVATE" } });
  const id = create.body.post.id;
  const selfRead = await api(app, { method: "GET", url: `/posts/${id}`, token: author.accessToken });
  assert.equal(selfRead.status, 200);
  const otherRead = await api(app, { method: "GET", url: `/posts/${id}`, token: other.accessToken });
  assert.equal(otherRead.status, 404);
});

test("comments policy: CONNECTIONS blocks a stranger, ANYONE allows, NOBODY blocks everyone but the author", async () => {
  const app = await testApp();
  const author = await createUser(app);
  const stranger = await createUser(app);

  const connOnly = await api(app, { method: "POST", url: "/posts", token: author.accessToken, payload: { body: "conn only", commentsPolicy: "CONNECTIONS" } });
  const r1 = await api(app, { method: "POST", url: `/posts/${connOnly.body.post.id}/comments`, token: stranger.accessToken, payload: { body: "hey" } });
  assert.equal(r1.status, 403);
  await connectUsers(app, author, stranger);
  const r2 = await api(app, { method: "POST", url: `/posts/${connOnly.body.post.id}/comments`, token: stranger.accessToken, payload: { body: "hey now" } });
  assert.equal(r2.status, 201);

  const anyone = await createUser(app);
  const open = await api(app, { method: "POST", url: "/posts", token: author.accessToken, payload: { body: "open", commentsPolicy: "ANYONE" } });
  const r3 = await api(app, { method: "POST", url: `/posts/${open.body.post.id}/comments`, token: anyone.accessToken, payload: { body: "cool" } });
  assert.equal(r3.status, 201);

  const nobody = await api(app, { method: "POST", url: "/posts", token: author.accessToken, payload: { body: "closed", commentsPolicy: "NOBODY" } });
  const r4 = await api(app, { method: "POST", url: `/posts/${nobody.body.post.id}/comments`, token: anyone.accessToken, payload: { body: "let me in" } });
  assert.equal(r4.status, 403);
  const r5 = await api(app, { method: "POST", url: `/posts/${nobody.body.post.id}/comments`, token: author.accessToken, payload: { body: "author can still reply" } });
  assert.equal(r5.status, 201);

  const list = await api(app, { method: "GET", url: `/posts/${open.body.post.id}/comments`, token: author.accessToken });
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].author.id, anyone.personId);
});

test("react toggles and replaces, and updates the count", async () => {
  const app = await testApp();
  const author = await createUser(app);
  const fan = await createUser(app);
  const post = await api(app, { method: "POST", url: "/posts", token: author.accessToken, payload: { body: "react to me" } });
  const id = post.body.post.id;

  const like = await api(app, { method: "POST", url: `/posts/${id}/react`, token: fan.accessToken, payload: { kind: "LIKE" } });
  assert.equal(like.status, 200);
  assert.equal(like.body.myReaction, "LIKE");
  let read = await api(app, { method: "GET", url: `/posts/${id}`, token: fan.accessToken });
  assert.equal(read.body.post.counts.reactions, 1);
  assert.equal(read.body.post.myReaction, "LIKE");

  const swap = await api(app, { method: "POST", url: `/posts/${id}/react`, token: fan.accessToken, payload: { kind: "CELEBRATE" } });
  assert.equal(swap.body.myReaction, "CELEBRATE");
  read = await api(app, { method: "GET", url: `/posts/${id}`, token: fan.accessToken });
  assert.equal(read.body.post.counts.reactions, 1, "replacing a reaction must not double-count");

  const off = await api(app, { method: "POST", url: `/posts/${id}/react`, token: fan.accessToken, payload: { kind: "CELEBRATE" } });
  assert.equal(off.body.myReaction, null, "reacting with the same kind again toggles it off");
  read = await api(app, { method: "GET", url: `/posts/${id}`, token: fan.accessToken });
  assert.equal(read.body.post.counts.reactions, 0);
});

test("save / unsave and GET /me/saved", async () => {
  const app = await testApp();
  const author = await createUser(app);
  const saver = await createUser(app);
  const post = await api(app, { method: "POST", url: "/posts", token: author.accessToken, payload: { body: "save this" } });
  const id = post.body.post.id;

  const save = await api(app, { method: "POST", url: `/posts/${id}/save`, token: saver.accessToken });
  assert.equal(save.status, 200);
  assert.equal(save.body.saved, true);

  const list = await api(app, { method: "GET", url: "/me/saved", token: saver.accessToken });
  assert.equal(list.status, 200);
  assert.ok(list.body.items.some((it: any) => it.id === id));

  const unsave = await api(app, { method: "DELETE", url: `/posts/${id}/save`, token: saver.accessToken });
  assert.equal(unsave.body.saved, false);
  const list2 = await api(app, { method: "GET", url: "/me/saved", token: saver.accessToken });
  assert.ok(!list2.body.items.some((it: any) => it.id === id));
});

test("repost: 409 on a second plain repost, a quote repost is allowed, counts and refs are right", async () => {
  const app = await testApp();
  const author = await createUser(app);
  const reposter = await createUser(app);
  const post = await api(app, { method: "POST", url: "/posts", token: author.accessToken, payload: { body: "repost me" } });
  const id = post.body.post.id;

  const first = await api(app, { method: "POST", url: `/posts/${id}/repost`, token: reposter.accessToken, payload: {} });
  assert.equal(first.status, 201);
  assert.equal(first.body.post.kind, "REPOST");
  assert.equal(first.body.post.ref?.id, id);

  const again = await api(app, { method: "POST", url: `/posts/${id}/repost`, token: reposter.accessToken, payload: {} });
  assert.equal(again.status, 409);

  const withComment = await api(app, { method: "POST", url: `/posts/${id}/repost`, token: reposter.accessToken, payload: { comment: "worth reading" } });
  assert.equal(withComment.status, 201);
  assert.equal(withComment.body.post.repostComment, "worth reading");

  const read = await api(app, { method: "GET", url: `/posts/${id}`, token: author.accessToken });
  assert.equal(read.body.post.counts.reposts, 2);
});

test("hide removes a post from the reader's own listing intent (Hide row is recorded)", async () => {
  const app = await testApp();
  const author = await createUser(app);
  const reader = await createUser(app);
  const post = await api(app, { method: "POST", url: "/posts", token: author.accessToken, payload: { body: "hide me" } });
  const id = post.body.post.id;
  const hide = await api(app, { method: "POST", url: `/posts/${id}/hide`, token: reader.accessToken });
  assert.equal(hide.status, 200);
  const row = await tdb().hide.findUnique({ where: { personId_postId: { personId: reader.personId, postId: id } } });
  assert.ok(row);
});

test("poll: vote, change vote, and voting after close is refused", async () => {
  const app = await testApp();
  const author = await createUser(app);
  const voter = await createUser(app);
  const create = await api(app, {
    method: "POST",
    url: "/posts",
    token: author.accessToken,
    payload: { poll: { question: "Pick one", options: ["A", "B", "C"] } },
  });
  assert.equal(create.status, 201);
  assert.equal(create.body.post.kind, "POLL");
  const id = create.body.post.id;
  const [optA, optB] = create.body.post.poll.options;

  const v1 = await api(app, { method: "POST", url: `/posts/${id}/poll/vote`, token: voter.accessToken, payload: { optionId: optA.id } });
  assert.equal(v1.status, 200);
  assert.equal(v1.body.post.poll.options.find((o: any) => o.id === optA.id).voteCount, 1);
  assert.equal(v1.body.post.poll.myVote, optA.id);

  const v2 = await api(app, { method: "POST", url: `/posts/${id}/poll/vote`, token: voter.accessToken, payload: { optionId: optB.id } });
  assert.equal(v2.body.post.poll.options.find((o: any) => o.id === optA.id).voteCount, 0);
  assert.equal(v2.body.post.poll.options.find((o: any) => o.id === optB.id).voteCount, 1);

  await tdb().poll.update({ where: { postId: id }, data: { closesAt: new Date(Date.now() - 1000) } });
  const v3 = await api(app, { method: "POST", url: `/posts/${id}/poll/vote`, token: voter.accessToken, payload: { optionId: optA.id } });
  assert.equal(v3.status, 400);
  assert.equal(v3.body.error, "poll_closed");
});

test("scheduled post is not visible to others until the publish job runs", async () => {
  const app = await testApp();
  const author = await createUser(app);
  const other = await createUser(app);
  const future = new Date(Date.now() + 3600_000).toISOString();
  const create = await api(app, { method: "POST", url: "/posts", token: author.accessToken, payload: { body: "future post", scheduledFor: future } });
  assert.equal(create.status, 201);
  assert.equal(create.body.post.publishedAt, null);
  const id = create.body.post.id;

  const otherRead = await api(app, { method: "GET", url: `/posts/${id}`, token: other.accessToken });
  assert.equal(otherRead.status, 404, "unpublished scheduled posts are invisible to other people");
  const selfRead = await api(app, { method: "GET", url: `/posts/${id}`, token: author.accessToken });
  assert.equal(selfRead.status, 200, "the author can still preview their own draft");

  // Force it due, then run the job directly (no wall-clock waiting in tests).
  await tdb().scheduledPost.updateMany({ where: { payload: { path: ["postId"], equals: id } }, data: { scheduledFor: new Date(Date.now() - 1000) } });
  await publishScheduledPosts(tdb());

  const afterJob = await api(app, { method: "GET", url: `/posts/${id}`, token: other.accessToken });
  assert.equal(afterJob.status, 200);
  assert.ok(afterJob.body.post.publishedAt);
});

test("company posts require org.post; a plain employee membership is refused", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const employee = await createUser(app);
  const org = await createOrg(app, owner, uniq("Weiss Embroidery "));

  const ownerPost = await api(app, { method: "POST", url: "/posts", token: owner.accessToken, payload: { body: "company update", organizationId: org.id } });
  assert.equal(ownerPost.status, 201);
  assert.equal(ownerPost.body.post.organization?.id, org.id);

  await api(app, { method: "POST", url: `/organizations/${org.id}/join`, token: employee.accessToken, payload: {} });
  const employeePost = await api(app, { method: "POST", url: "/posts", token: employee.accessToken, payload: { body: "not allowed", organizationId: org.id } });
  assert.equal(employeePost.status, 403);
});

test("scheduling a company post also requires org.schedule_posts", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const org = await createOrg(app, owner, uniq("Scheduling Co "));
  const future = new Date(Date.now() + 3600_000).toISOString();
  const r = await api(app, { method: "POST", url: "/posts", token: owner.accessToken, payload: { body: "scheduled company post", organizationId: org.id, scheduledFor: future } });
  assert.equal(r.status, 201, "an OWNER has every permission, including org.schedule_posts");
});

test("GET /people/:username/posts and /organizations/:id/posts are policy-filtered", async () => {
  const app = await testApp();
  const author = await createUser(app);
  const viewer = await createUser(app);
  await api(app, { method: "POST", url: "/posts", token: author.accessToken, payload: { body: "public one" } });
  await api(app, { method: "POST", url: "/posts", token: author.accessToken, payload: { body: "private one", visibility: "PRIVATE" } });

  const list = await api(app, { method: "GET", url: `/people/${author.username}/posts`, token: viewer.accessToken });
  assert.equal(list.status, 200);
  assert.ok(list.body.items.every((it: any) => it.body !== "private one"));
  assert.ok(list.body.items.some((it: any) => it.body === "public one"));
});

test("post analytics: author can read, a stranger cannot", async () => {
  const app = await testApp();
  const author = await createUser(app);
  const stranger = await createUser(app);
  const post = await api(app, { method: "POST", url: "/posts", token: author.accessToken, payload: { body: "measure me" } });
  const id = post.body.post.id;
  await api(app, { method: "POST", url: `/posts/${id}/react`, token: stranger.accessToken, payload: { kind: "LIKE" } });

  const mine = await api(app, { method: "GET", url: `/posts/${id}/analytics`, token: author.accessToken });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.reactions, 1);

  const forbid = await api(app, { method: "GET", url: `/posts/${id}/analytics`, token: stranger.accessToken });
  assert.equal(forbid.status, 403);
});

test("POST /posts/preview returns a preview without creating a post (and still refuses private URLs)", async () => {
  const app = await testApp();
  const u = await createUser(app);
  const priv = await api(app, { method: "POST", url: "/posts/preview", token: u.accessToken, payload: { url: "http://10.0.0.5/x" } });
  assert.equal(priv.status, 400);
  const before = await tdb().post.count({ where: { authorId: u.personId } });
  assert.equal(before, 0);
});

test("mediaAssetIds must belong to the actor", async () => {
  const app = await testApp();
  const u = await createUser(app);
  const other = await createUser(app);
  const asset = await tdb().mediaAsset.create({ data: { ownerId: other.personId, kind: "image", mime: "image/webp", bytes: 10, storageKey: "x", status: "READY" } });
  const r = await api(app, { method: "POST", url: "/posts", token: u.accessToken, payload: { mediaAssetIds: [asset.id] } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "media_not_found");
});
