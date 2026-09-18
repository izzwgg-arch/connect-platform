import { test } from "node:test";
import assert from "node:assert/strict";
import { createUser, tdb, testApp, api } from "../testing/harness.js";
import { notify } from "./notify.js";
import { deliverPush } from "./push.js";

test("push.deliver sends one Expo message per device token, stamps pushedAt, prunes dead tokens", async () => {
  const app = await testApp();
  const u = await createUser(app);
  await api(app, { method: "POST", url: "/me/devices", token: u.accessToken, payload: { platform: "ios", token: "ExponentPushToken[live-1]" } });
  await api(app, { method: "POST", url: "/me/devices", token: u.accessToken, payload: { platform: "android", token: "ExponentPushToken[dead-2]" } });
  const row = await notify(tdb(), { personId: u.personId, kind: "connection.request", title: "Someone wants to connect", href: "/network" });
  assert.ok(row && row.pushedAt === null);
  const sent: any[] = [];
  await deliverPush(tdb(), async (messages) => {
    sent.push(...messages);
    return messages.map((m) => (m.to.includes("dead") ? { status: "error" as const, details: { error: "DeviceNotRegistered" } } : { status: "ok" as const }));
  });
  const mine = sent.filter((m) => m.data?.id === row!.id);
  assert.equal(mine.length, 2);
  assert.equal(mine[0].title, "Someone wants to connect");
  const after = await tdb().notification.findUnique({ where: { id: row!.id } });
  assert.ok(after?.pushedAt);
  const tokens = await tdb().deviceToken.findMany({ where: { personId: u.personId } });
  assert.deepEqual(tokens.map((t) => t.token), ["ExponentPushToken[live-1]"]);
});

test("a class muted for push is stamped immediately and never queued", async () => {
  const app = await testApp();
  const u = await createUser(app);
  await tdb().notificationPref.create({ data: { personId: u.personId, kind: "post.reaction", inApp: true, push: false, email: false, sms: false } });
  const row = await notify(tdb(), { personId: u.personId, kind: "post.reaction", title: "Liked", groupKey: `t:${u.personId}` });
  assert.ok(row?.pushedAt);
});
