import { test } from "node:test";
import assert from "node:assert/strict";
import { api, connectUsers, createUser, testApp } from "../testing/harness.js";

function multipart(fields: Record<string, string>, file?: { field: string; filename: string; contentType: string; buffer: Buffer }) {
  const boundary = `----commTest${Date.now()}${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`));
    parts.push(file.buffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  } else {
    parts.push(Buffer.from(`--${boundary}--\r\n`));
  }
  return { boundary, body: Buffer.concat(parts) };
}

test("creating a group makes the creator OWNER and stands up a chat thread", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const res = await api(app, { method: "POST", url: "/groups", token: owner.accessToken, payload: { name: "Wholesale & Distribution", isPrivate: false, requiresApproval: false } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.group.name, "Wholesale & Distribution");
  assert.ok(res.body.group.chatThreadId);

  const chat = await api(app, { method: "GET", url: `/groups/${res.body.group.id}/chat`, token: owner.accessToken });
  assert.equal(chat.status, 200);
  assert.equal(chat.body.threadId, res.body.group.chatThreadId);

  const members = await api(app, { method: "GET", url: `/groups/${res.body.group.id}/members`, token: owner.accessToken });
  assert.equal(members.status, 200);
  assert.equal(members.body.items.length, 1);
  assert.equal(members.body.items[0].role, "OWNER");
});

test("joining a public no-approval group is immediate and adds the person to group chat", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const joiner = await createUser(app);
  const g = await api(app, { method: "POST", url: "/groups", token: owner.accessToken, payload: { name: "Apparel Makers", isPrivate: false, requiresApproval: false } });

  const join = await api(app, { method: "POST", url: `/groups/${g.body.group.id}/join`, token: joiner.accessToken });
  assert.equal(join.status, 200);
  assert.equal(join.body.membership.state, "ACTIVE");

  const mine = await api(app, { method: "GET", url: "/me/groups", token: joiner.accessToken });
  assert.ok(mine.body.items.some((i: any) => i.id === g.body.group.id));

  const group = await api(app, { method: "GET", url: `/groups/${g.body.group.id}/chat`, token: joiner.accessToken });
  assert.equal(group.status, 200);
});

test("approval-required group queues PENDING and notifies admins; approving activates and notifies the joiner", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const joiner = await createUser(app);
  const g = await api(app, { method: "POST", url: "/groups", token: owner.accessToken, payload: { name: "Monroe Business Owners", isPrivate: false, requiresApproval: true } });

  const join = await api(app, { method: "POST", url: `/groups/${g.body.group.id}/join`, token: joiner.accessToken });
  assert.equal(join.status, 200);
  assert.equal(join.body.membership.state, "PENDING");

  const ownerNotifs = await api(app, { method: "GET", url: "/notifications", token: owner.accessToken });
  assert.ok(ownerNotifs.body.items.some((n: any) => n.kind === "group.request"));

  const approve = await api(app, { method: "PATCH", url: `/groups/${g.body.group.id}/members/${joiner.personId}`, token: owner.accessToken, payload: { state: "ACTIVE" } });
  assert.equal(approve.status, 200);

  const joinerNotifs = await api(app, { method: "GET", url: "/notifications", token: joiner.accessToken });
  assert.ok(joinerNotifs.body.items.some((n: any) => n.kind === "group.approved"));

  const members = await api(app, { method: "GET", url: `/groups/${g.body.group.id}/members`, token: owner.accessToken });
  assert.equal(members.body.items.filter((m: any) => m.state === "ACTIVE").length, 2);
});

test("a private group is invisible to strangers (join 404s) but its name is visible to anyone on the public page", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const stranger = await createUser(app);
  const g = await api(app, { method: "POST", url: "/groups", token: owner.accessToken, payload: { name: "Loopcom Customers", isPrivate: true } });

  const join = await api(app, { method: "POST", url: `/groups/${g.body.group.id}/join`, token: stranger.accessToken });
  assert.equal(join.status, 404);

  const pub = await api(app, { method: "GET", url: `/public/groups/${g.body.group.slug}`, token: stranger.accessToken });
  assert.equal(pub.status, 200);
  assert.equal(pub.body.preview, true);
  assert.equal(pub.body.group.name, "Loopcom Customers");
  assert.equal(pub.body.group.isPrivate, true);
  assert.equal(pub.body.group.rules, undefined);
});

test("a group post is visible to a member but hidden from a non-member of a private group", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const stranger = await createUser(app);
  const g = await api(app, { method: "POST", url: "/groups", token: owner.accessToken, payload: { name: "Private Chat Group", isPrivate: true } });
  const groupId = g.body.group.id;

  const post = await api(app, { method: "POST", url: `/groups/${groupId}/posts`, token: owner.accessToken, payload: { body: "Roll call for the meetup" } });
  assert.equal(post.status, 201, JSON.stringify(post.body));

  const asOwner = await api(app, { method: "GET", url: `/groups/${groupId}/posts`, token: owner.accessToken });
  assert.equal(asOwner.status, 200);
  assert.equal(asOwner.body.items.length, 1);

  const asStranger = await api(app, { method: "GET", url: `/groups/${groupId}/posts`, token: stranger.accessToken });
  assert.equal(asStranger.status, 403);
});

test("a public group's posts are visible to a signed-in non-member", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const other = await createUser(app);
  const g = await api(app, { method: "POST", url: "/groups", token: owner.accessToken, payload: { name: "Public Feed Group", isPrivate: false } });
  await api(app, { method: "POST", url: `/groups/${g.body.group.id}/posts`, token: owner.accessToken, payload: { body: "Welcome!" } });

  const seen = await api(app, { method: "GET", url: `/groups/${g.body.group.id}/posts`, token: other.accessToken });
  assert.equal(seen.status, 200);
  assert.equal(seen.body.items.length, 1);
});

test("pinning a post toggles Group.pinnedPostIds and requires admin", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const member = await createUser(app);
  const g = await api(app, { method: "POST", url: "/groups", token: owner.accessToken, payload: { name: "Pin Test Group", isPrivate: false } });
  await api(app, { method: "POST", url: `/groups/${g.body.group.id}/join`, token: member.accessToken });
  const post = await api(app, { method: "POST", url: `/groups/${g.body.group.id}/posts`, token: owner.accessToken, payload: { body: "Group rules: read before posting" } });

  const deniedPin = await api(app, { method: "POST", url: `/groups/${g.body.group.id}/posts/${post.body.post.id}/pin`, token: member.accessToken });
  assert.equal(deniedPin.status, 403);

  const pin = await api(app, { method: "POST", url: `/groups/${g.body.group.id}/posts/${post.body.post.id}/pin`, token: owner.accessToken });
  assert.equal(pin.status, 200);
  assert.equal(pin.body.pinned, true);
  assert.deepEqual(pin.body.pinnedPostIds, [post.body.post.id]);

  const unpin = await api(app, { method: "POST", url: `/groups/${g.body.group.id}/posts/${post.body.post.id}/pin`, token: owner.accessToken });
  assert.equal(unpin.status, 200);
  assert.equal(unpin.body.pinned, false);
});

test("uploading a file to a group's Files tab", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const g = await api(app, { method: "POST", url: "/groups", token: owner.accessToken, payload: { name: "Files Group", isPrivate: false } });
  const { boundary, body } = multipart({ title: "Freight rate sheet" }, { field: "file", filename: "rates.pdf", contentType: "application/pdf", buffer: Buffer.from("%PDF-1.4 test document body padded out past twelve bytes") });
  const up = await api(app, { method: "POST", url: `/groups/${g.body.group.id}/files`, token: owner.accessToken, headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.file.title, "Freight rate sheet");

  const list = await api(app, { method: "GET", url: `/groups/${g.body.group.id}/files`, token: owner.accessToken });
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 1);

  const del = await api(app, { method: "DELETE", url: `/groups/${g.body.group.id}/files/${up.body.file.id}`, token: owner.accessToken });
  assert.equal(del.status, 200);
});

test("inviting a 1st-degree connection creates a PENDING membership and a notification; joining then activates it", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const friend = await createUser(app);
  await connectUsers(app, owner, friend);
  const g = await api(app, { method: "POST", url: "/groups", token: owner.accessToken, payload: { name: "Invite Test Group", isPrivate: true } });

  const invite = await api(app, { method: "POST", url: `/groups/${g.body.group.id}/invites`, token: owner.accessToken, payload: { personIds: [friend.personId] } });
  assert.equal(invite.status, 200);
  assert.deepEqual(invite.body.invited, [friend.personId]);

  const notifs = await api(app, { method: "GET", url: "/notifications", token: friend.accessToken });
  assert.ok(notifs.body.items.some((n: any) => n.kind === "group.request"));

  const join = await api(app, { method: "POST", url: `/groups/${g.body.group.id}/join`, token: friend.accessToken });
  assert.equal(join.status, 200);
  assert.equal(join.body.membership.state, "ACTIVE");
});

test("categories endpoint lists distinct categories with counts", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  await api(app, { method: "POST", url: "/groups", token: owner.accessToken, payload: { name: "Real Estate NY", category: "Real Estate", isPrivate: false } });
  await api(app, { method: "POST", url: "/groups", token: owner.accessToken, payload: { name: "Real Estate NJ", category: "Real Estate", isPrivate: false } });
  const cats = await api(app, { method: "GET", url: "/groups/categories", token: owner.accessToken });
  assert.equal(cats.status, 200);
  const row = cats.body.categories.find((c: any) => c.category === "Real Estate");
  assert.ok(row);
  assert.ok(row.count >= 2);
});
