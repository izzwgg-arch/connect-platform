import { test } from "node:test";
import assert from "node:assert/strict";
import { api, createUser, tdb, testApp, uniq } from "../testing/harness.js";
import { canonicalPair } from "../policy/graph.js";
import { subscribe } from "../lib/realtime.js";
import { canSendGiven, decideThreadStart, previewFor, readReceiptsVisible, sanitizeBody } from "./policy.js";

/** The graph domain (connections/blocks routes) isn't built yet — messaging only
 * needs the underlying rows, so tests write them directly with the real Prisma
 * client rather than going through /connections/request or /people/:id/block. */
async function connectDirect(a: string, b: string) {
  const { aId, bId } = canonicalPair(a, b);
  await tdb().connection.upsert({
    where: { aId_bId: { aId, bId } },
    create: { aId, bId, requesterId: a, status: "ACTIVE", acceptedAt: new Date() },
    update: { status: "ACTIVE", acceptedAt: new Date() },
  });
}
async function blockDirect(blockerId: string, blockedId: string) {
  await tdb().block.create({ data: { blockerId, blockedId } });
}
async function setPrefs(personId: string, prefs: Record<string, unknown>) {
  await tdb().person.update({ where: { id: personId }, data: { preferences: prefs } });
}

/* ── policy unit tests (pure functions) ──────────────────────────────────── */

test("policy: decideThreadStart", () => {
  assert.deepEqual(decideThreadStart({ blocked: true, connected: false, recipientAllowsRequests: true }), { allowed: false });
  assert.deepEqual(decideThreadStart({ blocked: false, connected: true, recipientAllowsRequests: false }), { allowed: true, recipientState: "ACTIVE" });
  assert.deepEqual(decideThreadStart({ blocked: false, connected: false, recipientAllowsRequests: false }), { allowed: false });
  assert.deepEqual(decideThreadStart({ blocked: false, connected: false, recipientAllowsRequests: true }), { allowed: true, recipientState: "REQUESTED" });
});

test("policy: canSendGiven caps REQUESTED/DECLINED at one message, ACTIVE is unlimited, LEFT never", () => {
  assert.equal(canSendGiven("ACTIVE", 0), true);
  assert.equal(canSendGiven("ACTIVE", 50), true);
  assert.equal(canSendGiven("REQUESTED", 0), true);
  assert.equal(canSendGiven("REQUESTED", 1), false);
  assert.equal(canSendGiven("DECLINED", 0), true);
  assert.equal(canSendGiven("DECLINED", 1), false);
  assert.equal(canSendGiven("LEFT", 0), false);
});

test("policy: readReceiptsVisible needs both sides on, sanitizeBody strips control chars, previewFor never leaks a deleted body", () => {
  assert.equal(readReceiptsVisible({ readReceipts: true }, { readReceipts: true }), true);
  assert.equal(readReceiptsVisible({ readReceipts: false }, { readReceipts: true }), false);
  assert.equal(readReceiptsVisible({}, {}), true);
  assert.equal(sanitizeBody("hi\x00\x07there\n"), "hithere"); // control bytes stripped, trailing newline trimmed
  assert.equal(sanitizeBody("hello\x00world"), "helloworld");
  assert.equal(previewFor("IMAGE", null), "📷 Photo");
  assert.equal(previewFor("TEXT", "  spaced   out  "), "spaced out");
});

/* ── integration ──────────────────────────────────────────────────────────── */

test("a stranger's first message is a request; the recipient sees it under Requests; a second message is refused", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);

  const created = await api(app, { method: "POST", url: "/threads", token: a.accessToken, payload: { personIds: [b.personId] } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const threadId = created.body.id;
  assert.equal(created.body.kind, "DIRECT");
  const bParticipant = created.body.participants.find((p: any) => p.person.id === b.personId);
  assert.equal(bParticipant.state, "REQUESTED");

  // idempotent find: posting again with the same pair returns the same thread, 200
  const again = await api(app, { method: "POST", url: "/threads", token: a.accessToken, payload: { personIds: [b.personId] } });
  assert.equal(again.status, 200);
  assert.equal(again.body.id, threadId);

  const send1 = await api(app, { method: "POST", url: `/threads/${threadId}/messages`, token: a.accessToken, payload: { kind: "TEXT", body: "Hi, are you open to a quote?" } });
  assert.equal(send1.status, 201, JSON.stringify(send1.body));

  const send2 = await api(app, { method: "POST", url: `/threads/${threadId}/messages`, token: a.accessToken, payload: { kind: "TEXT", body: "Following up…" } });
  assert.equal(send2.status, 409);
  assert.equal(send2.body.error, "message_request_pending");
  assert.equal(send2.body.message, "Wait for them to accept your request before sending more.");

  const requests = await api(app, { method: "GET", url: "/threads?tab=requests", token: b.accessToken });
  assert.equal(requests.status, 200);
  assert.equal(requests.body.items.length, 1);
  assert.equal(requests.body.items[0].id, threadId);
  assert.equal(requests.body.items[0].title, a.firstName + " " + a.lastName);

  const bInbox = await api(app, { method: "GET", url: "/threads?tab=inbox", token: b.accessToken });
  assert.equal(bInbox.body.items.length, 0);

  const aInbox = await api(app, { method: "GET", url: "/threads?tab=inbox", token: a.accessToken });
  assert.equal(aInbox.body.items.length, 1);
  assert.equal(aInbox.body.items[0].requestFromMe, true);

  // accept → sender can send again, unread/read flow works
  const accept = await api(app, { method: "POST", url: `/threads/${threadId}/accept`, token: b.accessToken });
  assert.equal(accept.status, 200);

  const send3 = await api(app, { method: "POST", url: `/threads/${threadId}/messages`, token: a.accessToken, payload: { kind: "TEXT", body: "Great, sending details." } });
  assert.equal(send3.status, 201, JSON.stringify(send3.body));

  const bThread = await api(app, { method: "GET", url: `/threads/${threadId}`, token: b.accessToken });
  assert.equal(bThread.status, 200);
  assert.equal(bThread.body.myState, "ACTIVE");

  const unread = await api(app, { method: "GET", url: "/threads/unread-count", token: b.accessToken });
  assert.equal(unread.body.count, 2); // the request message + the post-accept message

  const read = await api(app, { method: "POST", url: `/threads/${threadId}/read`, token: b.accessToken });
  assert.equal(read.status, 200);
  const unreadAfter = await api(app, { method: "GET", url: "/threads/unread-count", token: b.accessToken });
  assert.equal(unreadAfter.body.count, 0);
});

test("a declined request is silent: the recipient never appears requested or in the inbox again, and the sender keeps hearing the same refusal", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);
  const created = await api(app, { method: "POST", url: "/threads", token: a.accessToken, payload: { personIds: [b.personId] } });
  const threadId = created.body.id;
  await api(app, { method: "POST", url: `/threads/${threadId}/messages`, token: a.accessToken, payload: { body: "Hello!" } });

  const decline = await api(app, { method: "POST", url: `/threads/${threadId}/decline`, token: b.accessToken });
  assert.equal(decline.status, 200);

  // Invisible to the recipient everywhere.
  const bInbox = await api(app, { method: "GET", url: "/threads?tab=inbox", token: b.accessToken });
  assert.equal(bInbox.body.items.length, 0);
  const bRequests = await api(app, { method: "GET", url: "/threads?tab=requests", token: b.accessToken });
  assert.equal(bRequests.body.items.length, 0);
  const bDetail = await api(app, { method: "GET", url: `/threads/${threadId}`, token: b.accessToken });
  assert.equal(bDetail.status, 404);

  // The sender is refused the exact same way as a still-pending request — no oracle.
  const send2 = await api(app, { method: "POST", url: `/threads/${threadId}/messages`, token: a.accessToken, payload: { body: "You there?" } });
  assert.equal(send2.status, 409);
  assert.equal(send2.body.message, "Wait for them to accept your request before sending more.");
});

test("connected people start ACTIVE immediately with no cap, and get realtime + edit/delete/react", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);
  await connectDirect(a.personId, b.personId);

  const events: any[] = [];
  const off = subscribe(b.personId, (e) => events.push(e));

  const created = await api(app, { method: "POST", url: "/threads", token: a.accessToken, payload: { personIds: [b.personId] } });
  const threadId = created.body.id;
  const bRow = created.body.participants.find((p: any) => p.person.id === b.personId);
  assert.equal(bRow.state, "ACTIVE");

  const send1 = await api(app, { method: "POST", url: `/threads/${threadId}/messages`, token: a.accessToken, payload: { body: "One" } });
  const send2 = await api(app, { method: "POST", url: `/threads/${threadId}/messages`, token: a.accessToken, payload: { body: "Two — no cap when connected" } });
  assert.equal(send2.status, 201, JSON.stringify(send2.body));

  const messageEvent = events.find((e) => e.type === "message" && e.data?.message?.body === "One");
  assert.ok(messageEvent, "recipient should have received a realtime message event");
  assert.equal(messageEvent.data.unreadDelta, 1);
  off();

  const mid = send1.body.message.id;
  const edited = await api(app, { method: "PATCH", url: `/threads/${threadId}/messages/${mid}`, token: a.accessToken, payload: { body: "One (edited)" } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.message.body, "One (edited)");
  assert.ok(edited.body.message.editedAt);

  const editedByOther = await api(app, { method: "PATCH", url: `/threads/${threadId}/messages/${mid}`, token: b.accessToken, payload: { body: "hijack" } });
  assert.equal(editedByOther.status, 403);

  const reacted = await api(app, { method: "POST", url: `/threads/${threadId}/messages/${mid}/react`, token: b.accessToken, payload: { emoji: "👍" } });
  assert.equal(reacted.status, 200);
  assert.equal(reacted.body.message.reactions["👍"], 1);
  const unreacted = await api(app, { method: "POST", url: `/threads/${threadId}/messages/${mid}/react`, token: b.accessToken, payload: { emoji: "👍" } });
  assert.equal(unreacted.body.message.reactions["👍"], undefined);

  const deleted = await api(app, { method: "DELETE", url: `/threads/${threadId}/messages/${mid}`, token: a.accessToken });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.message.body, null);
  assert.ok(deleted.body.message.deletedAt);
});

test("editing is refused after the 24h window", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);
  await connectDirect(a.personId, b.personId);
  const created = await api(app, { method: "POST", url: "/threads", token: a.accessToken, payload: { personIds: [b.personId] } });
  const threadId = created.body.id;
  const sent = await api(app, { method: "POST", url: `/threads/${threadId}/messages`, token: a.accessToken, payload: { body: "old news" } });
  await tdb().message.update({ where: { id: sent.body.message.id }, data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } });
  const edited = await api(app, { method: "PATCH", url: `/threads/${threadId}/messages/${sent.body.message.id}`, token: a.accessToken, payload: { body: "too late" } });
  assert.equal(edited.status, 400);
  assert.equal(edited.body.error, "edit_window_closed");
});

test("blocked people get notFound, never a different message than a stranger", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);
  await blockDirect(b.personId, a.personId);
  const attempt = await api(app, { method: "POST", url: "/threads", token: a.accessToken, payload: { personIds: [b.personId] } });
  assert.equal(attempt.status, 404);
  assert.equal(attempt.body.error, "not_found");
});

test("a recipient with messageRequests off cannot be reached by a stranger (no oracle — same 404 as a block)", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);
  await setPrefs(b.personId, { messageRequests: false });
  const attempt = await api(app, { method: "POST", url: "/threads", token: a.accessToken, payload: { personIds: [b.personId] } });
  assert.equal(attempt.status, 404);
});

test("group threads (2+ personIds) require every member to be a 1st-degree connection of the creator", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);
  const d = await createUser(app);
  const stranger = await createUser(app);
  await connectDirect(a.personId, b.personId);
  await connectDirect(a.personId, d.personId);

  const ok = await api(app, { method: "POST", url: "/threads", token: a.accessToken, payload: { personIds: [b.personId, d.personId], title: "Project chat" } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.kind, "GROUP");
  assert.equal(ok.body.title, "Project chat");

  const refused = await api(app, { method: "POST", url: "/threads", token: a.accessToken, payload: { personIds: [b.personId, stranger.personId], title: "Bigger chat" } });
  assert.equal(refused.status, 403);
});

test("forwarding copies a message into another thread with forwardedFrom set, honouring that thread's own policy", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);
  const c = await createUser(app);
  await connectDirect(a.personId, b.personId);
  await connectDirect(a.personId, c.personId);
  const t1 = (await api(app, { method: "POST", url: "/threads", token: a.accessToken, payload: { personIds: [b.personId] } })).body;
  const t2 = (await api(app, { method: "POST", url: "/threads", token: a.accessToken, payload: { personIds: [c.personId] } })).body;
  const original = await api(app, { method: "POST", url: `/threads/${t1.id}/messages`, token: a.accessToken, payload: { body: "check this out" } });

  const forwarded = await api(app, { method: "POST", url: `/threads/${t1.id}/messages/${original.body.message.id}/forward`, token: a.accessToken, payload: { toThreadIds: [t2.id] } });
  assert.equal(forwarded.status, 200);
  assert.equal(forwarded.body.results[0].ok, true);
  assert.equal(forwarded.body.results[0].message.forwardedFrom, original.body.message.id);
  assert.equal(forwarded.body.results[0].message.body, "check this out");
});

test("read receipts are hidden unless both sides allow them", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);
  await connectDirect(a.personId, b.personId);
  await setPrefs(b.personId, { readReceipts: false });
  const t = (await api(app, { method: "POST", url: "/threads", token: a.accessToken, payload: { personIds: [b.personId] } })).body;
  await api(app, { method: "POST", url: `/threads/${t.id}/messages`, token: a.accessToken, payload: { body: "hi" } });
  await api(app, { method: "POST", url: `/threads/${t.id}/read`, token: b.accessToken });

  const aView = await api(app, { method: "GET", url: `/threads/${t.id}`, token: a.accessToken });
  const bParticipant = aView.body.participants.find((p: any) => p.person.id === b.personId);
  assert.equal(bParticipant.lastReadAt, null, "b turned off read receipts — a must not see when b read it");

  await setPrefs(b.personId, { readReceipts: true });
  await api(app, { method: "POST", url: `/threads/${t.id}/messages`, token: a.accessToken, payload: { body: "hi again" } });
  await api(app, { method: "POST", url: `/threads/${t.id}/read`, token: b.accessToken });
  const aView2 = await api(app, { method: "GET", url: `/threads/${t.id}`, token: a.accessToken });
  const bParticipant2 = aView2.body.participants.find((p: any) => p.person.id === b.personId);
  assert.ok(bParticipant2.lastReadAt, "both sides allow read receipts now — a should see when b read it");
});

test("presence respects showOnline, and requires recent activity", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);
  await tdb().person.update({ where: { id: b.personId }, data: { lastSeenAt: new Date(), preferences: { showOnline: true } } });

  const p1 = await api(app, { method: "GET", url: `/presence?personIds=${b.personId}`, token: a.accessToken });
  assert.equal(p1.body.presence[b.personId], true);

  await tdb().person.update({ where: { id: b.personId }, data: { preferences: { showOnline: false } } });
  const p2 = await api(app, { method: "GET", url: `/presence?personIds=${b.personId}`, token: a.accessToken });
  assert.equal(p2.body.presence[b.personId], false);

  await tdb().person.update({ where: { id: b.personId }, data: { preferences: { showOnline: true }, lastSeenAt: new Date(Date.now() - 10 * 60_000) } });
  const p3 = await api(app, { method: "GET", url: `/presence?personIds=${b.personId}`, token: a.accessToken });
  assert.equal(p3.body.presence[b.personId], false, "10 minutes ago is outside the 3-minute presence window");
});

test("mute, pin and archive round-trip, and a group member can leave", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);
  await connectDirect(a.personId, b.personId);
  const t = (await api(app, { method: "POST", url: "/threads", token: a.accessToken, payload: { personIds: [b.personId] } })).body;

  assert.equal((await api(app, { method: "POST", url: `/threads/${t.id}/pin`, token: a.accessToken })).status, 200);
  assert.equal((await api(app, { method: "GET", url: "/threads?tab=inbox", token: a.accessToken })).body.items[0].pinnedAt !== null, true);
  assert.equal((await api(app, { method: "DELETE", url: `/threads/${t.id}/pin`, token: a.accessToken })).status, 200);

  assert.equal((await api(app, { method: "POST", url: `/threads/${t.id}/mute`, token: a.accessToken, payload: {} })).status, 200);
  assert.equal((await api(app, { method: "DELETE", url: `/threads/${t.id}/mute`, token: a.accessToken })).status, 200);

  assert.equal((await api(app, { method: "POST", url: `/threads/${t.id}/archive`, token: a.accessToken })).status, 200);
  const archived = await api(app, { method: "GET", url: "/threads?tab=archived", token: a.accessToken });
  assert.equal(archived.body.items.length, 1);
  assert.equal((await api(app, { method: "GET", url: "/threads?tab=inbox", token: a.accessToken })).body.items.length, 0);
  assert.equal((await api(app, { method: "DELETE", url: `/threads/${t.id}/archive`, token: a.accessToken })).status, 200);

  const leave = await api(app, { method: "POST", url: `/threads/${t.id}/leave`, token: a.accessToken });
  assert.equal(leave.status, 400); // DIRECT threads can't be left
  const c = await createUser(app);
  await connectDirect(a.personId, c.personId);
  const g = (await api(app, { method: "POST", url: "/threads", token: a.accessToken, payload: { personIds: [b.personId, c.personId], title: "Group" } })).body;
  const leftGroup = await api(app, { method: "POST", url: `/threads/${g.id}/leave`, token: b.accessToken });
  assert.equal(leftGroup.status, 200);
  const bDetail = await api(app, { method: "GET", url: `/threads/${g.id}`, token: b.accessToken });
  assert.equal(bDetail.status, 404, "a member who left no longer sees the group thread");
});

test("thread search finds a message's own body, scoped to threads the searcher is in", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);
  const stranger = await createUser(app);
  await connectDirect(a.personId, b.personId);
  const t = (await api(app, { method: "POST", url: "/threads", token: a.accessToken, payload: { personIds: [b.personId] } })).body;
  await api(app, { method: "POST", url: `/threads/${t.id}/messages`, token: a.accessToken, payload: { body: "the embroidery sample shipped today" } });

  const found = await api(app, { method: "GET", url: "/threads/search?q=embroidery", token: b.accessToken });
  assert.equal(found.body.items.length, 1);

  const foundByStranger = await api(app, { method: "GET", url: "/threads/search?q=embroidery", token: stranger.accessToken });
  assert.equal(foundByStranger.body.items.length, 0);
});
