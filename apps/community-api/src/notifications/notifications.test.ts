import { test } from "node:test";
import assert from "node:assert/strict";
import { api, createUser, tdb, testApp } from "../testing/harness.js";
import { notify } from "../lib/notify.js";
import { subscribe } from "../lib/realtime.js";

test("notify() batches reactions by groupKey into one row with a count", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);
  const db = tdb();

  await notify(db, { personId: a.personId, kind: "connection.request", title: `${b.firstName} sent a connection request`, actorId: b.personId, objectType: "Connection", objectId: "conn_1" });
  const groupKey = "post_1:reaction";
  for (let i = 0; i < 3; i++) {
    await notify(db, { personId: a.personId, kind: "post.reaction", title: "New reaction on your post", actorId: b.personId, objectType: "Post", objectId: "post_1", groupKey });
  }

  const list = await api(app, { method: "GET", url: "/notifications", token: a.accessToken });
  assert.equal(list.status, 200);
  const reaction = list.body.items.find((i: any) => i.kind === "post.reaction");
  assert.ok(reaction, "expected a batched reaction row");
  assert.equal(reaction.count, 3);
  const request = list.body.items.find((i: any) => i.kind === "connection.request");
  assert.ok(request);
  assert.equal(request.objectId, "conn_1");
  assert.equal(request.actor.id, b.personId);
  assert.equal(request.group, "today");
});

test("filters narrow the list by class group", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);
  const db = tdb();
  await notify(db, { personId: a.personId, kind: "connection.request", title: "req", actorId: b.personId });
  await notify(db, { personId: a.personId, kind: "rfq.quote", title: "quote", actorId: b.personId });
  await notify(db, { personId: a.personId, kind: "job.match", title: "job", actorId: b.personId });
  await notify(db, { personId: a.personId, kind: "security.alert", title: "sign-in" });

  const decisions = await api(app, { method: "GET", url: "/notifications?filter=decisions", token: a.accessToken });
  assert.ok(decisions.body.items.every((i: any) => i.kind === "connection.request" || i.kind === "rfq.quote"));
  assert.ok(decisions.body.items.some((i: any) => i.kind === "connection.request"));

  const rfq = await api(app, { method: "GET", url: "/notifications?filter=rfq", token: a.accessToken });
  assert.ok(rfq.body.items.every((i: any) => i.kind.startsWith("rfq.")));
  assert.ok(rfq.body.items.length >= 1);

  const security = await api(app, { method: "GET", url: "/notifications?filter=security", token: a.accessToken });
  assert.ok(security.body.items.some((i: any) => i.kind === "security.alert"));

  const network = await api(app, { method: "GET", url: "/notifications?filter=network", token: a.accessToken });
  assert.ok(network.body.items.every((i: any) => /^(connection|follow|intro)\./.test(i.kind)));
});

test("mark all read drops unread to zero", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);
  const db = tdb();
  await notify(db, { personId: a.personId, kind: "connection.request", title: "req", actorId: b.personId });
  await notify(db, { personId: a.personId, kind: "job.match", title: "job", actorId: b.personId });

  const before = await api(app, { method: "GET", url: "/notifications/unread-count", token: a.accessToken });
  assert.ok(before.body.unread >= 2);

  const read = await api(app, { method: "POST", url: "/notifications/read", token: a.accessToken, payload: { all: true } });
  assert.equal(read.status, 200);
  assert.equal(read.body.unread, 0);

  const after = await api(app, { method: "GET", url: "/notifications/unread-count", token: a.accessToken });
  assert.equal(after.body.unread, 0);
});

test("delete removes a single notification", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const db = tdb();
  const row = await notify(db, { personId: a.personId, kind: "job.match", title: "job" });
  assert.ok(row);
  const del = await api(app, { method: "DELETE", url: `/notifications/${row!.id}`, token: a.accessToken });
  assert.equal(del.status, 200);
  const missing = await api(app, { method: "DELETE", url: `/notifications/${row!.id}`, token: a.accessToken });
  assert.equal(missing.status, 404);
});

test("notification prefs: PUT/GET roundtrip, SMS gated to security.alert + verified phone", async () => {
  const app = await testApp();
  const a = await createUser(app);

  const get1 = await api(app, { method: "GET", url: "/me/notification-prefs", token: a.accessToken });
  assert.equal(get1.status, 200);
  const connCls = get1.body.classes.find((c: any) => c.kind === "connection.request");
  assert.ok(connCls);
  assert.equal(connCls.canSms, false);
  const secCls = get1.body.classes.find((c: any) => c.kind === "security.alert");
  assert.equal(secCls.canSms, true);
  assert.equal(get1.body.quietHours.enabled, false);

  const smsOnWrongClass = await api(app, { method: "PUT", url: "/me/notification-prefs", token: a.accessToken, payload: { classes: { "connection.request": { inApp: true, push: true, email: false, sms: true } } } });
  assert.equal(smsOnWrongClass.status, 400);
  assert.equal(smsOnWrongClass.body.error, "sms_not_allowed");

  const smsUnverified = await api(app, { method: "PUT", url: "/me/notification-prefs", token: a.accessToken, payload: { classes: { "security.alert": { inApp: true, push: true, email: true, sms: true } } } });
  assert.equal(smsUnverified.status, 400);
  assert.equal(smsUnverified.body.error, "phone_not_verified");

  const put = await api(app, {
    method: "PUT",
    url: "/me/notification-prefs",
    token: a.accessToken,
    payload: { classes: { "job.match": { inApp: false, push: false, email: false, sms: false } }, quietHours: { enabled: true, from: "16:00", to: "21:00", days: [5, 6] } },
  });
  assert.equal(put.status, 200);

  const get2 = await api(app, { method: "GET", url: "/me/notification-prefs", token: a.accessToken });
  const jobCls = get2.body.classes.find((c: any) => c.kind === "job.match");
  assert.equal(jobCls.inApp, false);
  assert.equal(get2.body.quietHours.enabled, true);
  assert.deepEqual(get2.body.quietHours.days, [5, 6]);
});

test("realtime: notify() publishes a 'notification' event to the person's subscription", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const db = tdb();
  const seen: any[] = [];
  const off = subscribe(a.personId, (e) => seen.push(e));
  try {
    await notify(db, { personId: a.personId, kind: "job.match", title: "A job matches you" });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(seen.some((e) => e.type === "notification"));
  } finally {
    off();
  }
});
