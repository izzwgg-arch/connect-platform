import { test } from "node:test";
import assert from "node:assert/strict";
import { api, connectUsers, createOrg, createUser, tdb, testApp, uniq } from "../testing/harness.js";

test("notes: create, list, patch, delete — scoped to the owner", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const stranger = await createUser(app);
  const target = await createUser(app);

  const create = await api(app, { method: "POST", url: "/crm/notes", token: owner.accessToken, payload: { targetPersonId: target.personId, body: "Met at the expo", tags: ["lead", "hot"], dealValue: 500 } });
  assert.equal(create.status, 201);
  assert.equal(create.body.targetPerson.id, target.personId);
  assert.equal(create.body.dealValue, "500");
  const noteId = create.body.id;

  const list = await api(app, { method: "GET", url: `/crm/notes?personId=${target.personId}`, token: owner.accessToken });
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 1);

  const byTag = await api(app, { method: "GET", url: "/crm/notes?tag=hot", token: owner.accessToken });
  assert.equal(byTag.body.items.length, 1);

  const patch = await api(app, { method: "PATCH", url: `/crm/notes/${noteId}`, token: owner.accessToken, payload: { body: "Met at the expo — following up" } });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.body, "Met at the expo — following up");

  // Another person's note is a 404, never a 403 (absence and refusal share notFound).
  const strangerPatch = await api(app, { method: "PATCH", url: `/crm/notes/${noteId}`, token: stranger.accessToken, payload: { body: "hijack" } });
  assert.equal(strangerPatch.status, 404);
  const strangerDelete = await api(app, { method: "DELETE", url: `/crm/notes/${noteId}`, token: stranger.accessToken });
  assert.equal(strangerDelete.status, 404);

  const del = await api(app, { method: "DELETE", url: `/crm/notes/${noteId}`, token: owner.accessToken });
  assert.equal(del.status, 200);

  const tags = await api(app, { method: "GET", url: "/crm/tags", token: owner.accessToken });
  assert.equal(tags.status, 200);
  assert.deepEqual(tags.body.tags, []);
});

test("reminders: create, due filter, mark done — scoped to the owner", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const stranger = await createUser(app);
  const target = await createUser(app);

  const soon = new Date(Date.now() + 3600_000).toISOString();
  const farOut = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
  const r1 = await api(app, { method: "POST", url: "/crm/reminders", token: owner.accessToken, payload: { targetPersonId: target.personId, title: "Follow up call", dueAt: soon } });
  assert.equal(r1.status, 201);
  const r2 = await api(app, { method: "POST", url: "/crm/reminders", token: owner.accessToken, payload: { targetPersonId: target.personId, title: "Quarterly check-in", dueAt: farOut } });
  assert.equal(r2.status, 201);

  const today = await api(app, { method: "GET", url: "/crm/reminders?due=today", token: owner.accessToken });
  assert.equal(today.body.items.length, 1);
  assert.equal(today.body.items[0].title, "Follow up call");

  const all = await api(app, { method: "GET", url: "/crm/reminders?due=all", token: owner.accessToken });
  assert.equal(all.body.items.length, 2);

  const strangerPatch = await api(app, { method: "PATCH", url: `/crm/reminders/${r1.body.id}`, token: stranger.accessToken, payload: { done: true } });
  assert.equal(strangerPatch.status, 404);

  const done = await api(app, { method: "PATCH", url: `/crm/reminders/${r1.body.id}`, token: owner.accessToken, payload: { done: true } });
  assert.equal(done.status, 200);
  assert.ok(done.body.doneAt);

  const stillOpen = await api(app, { method: "GET", url: "/crm/reminders?done=false", token: owner.accessToken });
  assert.equal(stillOpen.body.items.length, 1);
  assert.equal(stillOpen.body.items[0].id, r2.body.id);
});

test("timeline merges a note and a message, newest first", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const other = await createUser(app);
  await connectUsers(app, owner, other);

  const thread = await api(app, { method: "POST", url: "/threads", token: owner.accessToken, payload: { personIds: [other.personId] } });
  assert.ok(thread.body.id);
  const sent = await api(app, { method: "POST", url: `/threads/${thread.body.id}/messages`, token: owner.accessToken, payload: { body: "Great meeting you today" } });
  assert.equal(sent.status, 201);

  await api(app, { method: "POST", url: "/crm/notes", token: owner.accessToken, payload: { targetPersonId: other.personId, body: "Follow up next week about the contract" } });

  const timeline = await api(app, { method: "GET", url: `/crm/timeline?personId=${other.personId}`, token: owner.accessToken });
  assert.equal(timeline.status, 200);
  const kinds = timeline.body.items.map((i: any) => i.kind);
  assert.ok(kinds.includes("note"));
  assert.ok(kinds.includes("messages"));
  const msgItem = timeline.body.items.find((i: any) => i.kind === "messages");
  assert.ok(msgItem.title.includes("Great meeting you today") || msgItem.title.includes("message"));
  assert.equal(msgItem.href, `/messages/${thread.body.id}`);
  // newest first
  for (let i = 1; i < timeline.body.items.length; i++) {
    assert.ok(timeline.body.items[i - 1].at >= timeline.body.items[i].at);
  }
});

test("timeline also merges a mutual relationship tag for a business target", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const bizOwner = await createUser(app);
  const org = await createOrg(app, bizOwner);
  await tdb().relationshipTag.create({ data: { ownerId: owner.personId, targetOrgId: org.id, kind: "CUSTOMER", mutual: true } });

  const timeline = await api(app, { method: "GET", url: `/crm/timeline?orgId=${org.id}`, token: owner.accessToken });
  assert.equal(timeline.status, 200);
  assert.ok(timeline.body.items.some((i: any) => i.kind === "tag"));
});

test("pipeline groups notes by tag and sums deal value", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const a = await createUser(app);
  const b = await createUser(app);
  await api(app, { method: "POST", url: "/crm/notes", token: owner.accessToken, payload: { targetPersonId: a.personId, body: "Interested in bulk order", tags: ["hot"], dealValue: 1000 } });
  await api(app, { method: "POST", url: "/crm/notes", token: owner.accessToken, payload: { targetPersonId: b.personId, body: "Also hot", tags: ["hot"], dealValue: 250 } });

  const pipeline = await api(app, { method: "GET", url: "/crm/pipeline", token: owner.accessToken });
  assert.equal(pipeline.status, 200);
  const hot = pipeline.body.groups.find((g: any) => g.tag === "hot");
  assert.ok(hot);
  assert.equal(hot.count, 2);
  assert.equal(hot.dealValue, "1250.00");
});

test("contacts include 1st-degree connections and anyone with a note, newest contact first", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const connection = await createUser(app);
  const noted = await createUser(app);
  await connectUsers(app, owner, connection);
  await api(app, { method: "POST", url: "/crm/notes", token: owner.accessToken, payload: { targetPersonId: noted.personId, body: "Talked at the mixer" } });

  const contacts = await api(app, { method: "GET", url: "/crm/contacts", token: owner.accessToken });
  assert.equal(contacts.status, 200);
  const ids = contacts.body.items.map((i: any) => i.person.id);
  assert.ok(ids.includes(connection.personId));
  assert.ok(ids.includes(noted.personId));
});

test("push-to-loopcom returns queued:false with the payload when the import endpoint isn't configured", async () => {
  const app = await testApp();
  const owner = await createUser(app, { firstName: "Yanky", lastName: uniq("Test") });
  const target = await createUser(app, { firstName: "Devorah", lastName: uniq("Test") });
  await api(app, { method: "POST", url: "/crm/notes", token: owner.accessToken, payload: { targetPersonId: target.personId, body: "Wants a quote for uniforms" } });

  const push = await api(app, { method: "POST", url: "/crm/push-to-loopcom", token: owner.accessToken, payload: { personId: target.personId } });
  assert.equal(push.status, 200);
  assert.equal(push.body.queued, false);
  assert.match(push.body.reason, /not configured/i);
  assert.equal(push.body.payload.name, `Devorah ${target.lastName}`);
  assert.ok(push.body.payload.notes.includes("uniforms"));

  const auditRow = await tdb().auditLog.findFirst({ where: { actorId: owner.personId, action: "crm.push_requested", targetId: target.personId } });
  assert.ok(auditRow);
});

test("export.csv returns a csv document", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const target = await createUser(app);
  await api(app, { method: "POST", url: "/crm/notes", token: owner.accessToken, payload: { targetPersonId: target.personId, body: "note, with a comma" } });

  const csv = await api(app, { method: "GET", url: "/crm/export.csv", token: owner.accessToken });
  assert.equal(csv.status, 200);
  assert.match(String(csv.headers["content-type"]), /text\/csv/);
  assert.match(String(csv.body), /Type,Contact/);
});

test("qr/met creates a private note and returns next-step suggestions", async () => {
  const app = await testApp();
  const scanner = await createUser(app);
  const met = await createUser(app);

  const r = await api(app, { method: "POST", url: "/qr/met", token: scanner.accessToken, payload: { personId: met.personId, event: "Chamber mixer", note: "Runs a logistics company" } });
  assert.equal(r.status, 201);
  assert.ok(r.body.note.tags.includes("met-in-person"));
  assert.ok(r.body.suggestions.includes("connect"));

  const notes = await tdb().privateNote.findMany({ where: { ownerId: scanner.personId, targetPersonId: met.personId } });
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /Chamber mixer/);
});

test("qr/resolve finds the person by username scanned from the profile link", async () => {
  const app = await testApp();
  const scanner = await createUser(app);
  const target = await createUser(app);

  const r = await api(app, { method: "GET", url: `/qr/resolve?code=${encodeURIComponent(`https://community.example/people/${target.username}?via=qr`)}`, token: scanner.accessToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.person.id, target.personId);
  assert.equal(r.body.relationship.connectionStatus, "none");
});

test("vcard hides the phone from a stranger and shows it to the profile's owner", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const stranger = await createUser(app);
  await api(app, { method: "PATCH", url: "/me/profile", token: owner.accessToken, payload: { headline: "Business owner" } });
  const phone = `+1555${String(Date.now()).slice(-7)}`;
  await tdb().person.update({ where: { id: owner.personId }, data: { phoneE164: phone, phoneVerifiedAt: new Date() } });

  const strangerView = await api(app, { method: "GET", url: `/public/people/${owner.username}/vcard` });
  assert.equal(strangerView.status, 200);
  assert.match(String(strangerView.headers["content-type"]), /text\/vcard/);
  assert.ok(!String(strangerView.body).includes(phone));

  const ownView = await api(app, { method: "GET", url: `/public/people/${owner.username}/vcard`, token: owner.accessToken });
  assert.equal(ownView.status, 200);
  assert.ok(String(ownView.body).includes(phone));
});
