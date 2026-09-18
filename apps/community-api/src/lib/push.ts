import type { Db } from "../db.js";

/**
 * Push delivery. Device tokens registered through POST /me/devices are Expo
 * push tokens (the Community mobile app) — delivered through Expo's push
 * service, which fans out to APNs/FCM with the app's credentials. Web gets
 * its realtime signal over SSE, so no web push transport is needed.
 *
 * Runs as the "push.deliver" scheduler job: every notification row with
 * pushedAt = null and a person holding device tokens is sent once, then
 * stamped. Quiet hours (Person.preferences.quietHours) defer, never drop.
 */
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export type PushSender = (messages: Array<{ to: string; title: string; body?: string; data?: Record<string, unknown>; badge?: number }>) => Promise<Array<{ status: "ok" | "error"; message?: string; details?: { error?: string } }>>;

export const expoPushSender: PushSender = async (messages) => {
  if (!messages.length) return [];
  const res = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(messages),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`expo push ${res.status}`);
  const body = (await res.json()) as { data: Array<{ status: "ok" | "error"; message?: string; details?: { error?: string } }> };
  return body.data;
};

function inQuietHours(prefs: any, now = new Date()): boolean {
  const q = prefs?.quietHours;
  if (!q?.enabled) return false;
  const day = now.getDay();
  if (Array.isArray(q.days) && q.days.length && !q.days.includes(day)) return false;
  const [fh, fm] = String(q.from || "00:00").split(":").map(Number);
  const [th, tm] = String(q.to || "00:00").split(":").map(Number);
  const mins = now.getHours() * 60 + now.getMinutes();
  const from = fh * 60 + fm;
  const to = th * 60 + tm;
  return from <= to ? mins >= from && mins < to : mins >= from || mins < to;
}

export async function deliverPush(db: Db, send: PushSender = expoPushSender) {
  const pending = await db.notification.findMany({
    where: { pushedAt: null, createdAt: { gt: new Date(Date.now() - 24 * 3600_000) } },
    orderBy: { createdAt: "asc" },
    take: 200,
    include: { person: { select: { id: true, preferences: true, deviceTokens: { select: { token: true, platform: true } } } } },
  });
  if (!pending.length) return;
  const messages: Array<{ to: string; title: string; body?: string; data?: Record<string, unknown> }> = [];
  const sentIds: string[] = [];
  const skippedIds: string[] = [];
  for (const n of pending) {
    const tokens = n.person.deviceTokens.map((t) => t.token).filter((t) => /^ExponentPushToken\[/.test(t) || /^ExpoPushToken\[/.test(t));
    if (!tokens.length) {
      skippedIds.push(n.id);
      continue;
    }
    if (inQuietHours(n.person.preferences)) continue; // deferred to the next run
    const unread = await db.notification.count({ where: { personId: n.personId, readAt: null } });
    for (const to of tokens) messages.push({ to, title: n.title, body: n.body ?? undefined, data: { href: n.href, kind: n.kind, id: n.id, badge: unread } });
    sentIds.push(n.id);
  }
  if (skippedIds.length) await db.notification.updateMany({ where: { id: { in: skippedIds } }, data: { pushedAt: new Date() } });
  if (!messages.length) return;
  try {
    const results = await send(messages);
    // Prune tokens Expo reports as gone.
    const dead = messages.filter((_, i) => results[i]?.details?.error === "DeviceNotRegistered").map((m) => m.to);
    if (dead.length) await db.deviceToken.deleteMany({ where: { token: { in: dead } } });
  } finally {
    await db.notification.updateMany({ where: { id: { in: sentIds } }, data: { pushedAt: new Date() } });
  }
}
