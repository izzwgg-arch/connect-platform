import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import { canonicalSmsPhone } from "@connect/shared";

type VoipMsStoredCreds = { username: string; password: string; apiBaseUrl?: string };

type InboundRow = {
  providerMessageId: string;
  from: string;
  to: string;
  body: string;
  mediaUrls: string[];
  createdAt?: Date;
};

const DEFAULT_VOIPMS_API = "https://voip.ms/api/v1/rest.php";

function digits(value: string): string {
  return String(value || "").replace(/\D/g, "");
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function firstString(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function parseMediaUrls(row: Record<string, unknown>): string[] {
  const direct = row.media ?? row.mms ?? row.media_urls ?? row.mediaUrls;
  if (Array.isArray(direct)) return direct.map((x) => String(x).trim()).filter(Boolean).slice(0, 3);
  const text = String(direct || "").trim();
  const split = text ? text.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean) : [];
  const numbered = [row.media1, row.media2, row.media3].map((x) => String(x || "").trim()).filter(Boolean);
  return [...split, ...numbered].slice(0, 3);
}

/** VoIP.ms returns bare `YYYY-MM-DD HH:MM:SS` in America/New_York wall time (no TZ suffix). */
function parseVoipMsDate(value: string): Date | undefined {
  const raw = String(value || "").trim();
  if (!raw) return undefined;
  const hasTimezone = /[Zz]$/.test(raw) || /[+\-]\d{2}:?\d{2}$/.test(raw);
  if (hasTimezone) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const normalized = raw.replace(" ", "T");
  const m = normalized.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const sec = Number(m[6]);

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const wallKey = (t: number) => {
    const parts = formatter.formatToParts(new Date(t));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const wy = get("year");
    const wmo = get("month");
    const wd = get("day");
    const wh = get("hour");
    const wmi = get("minute");
    const ws = get("second");
    return wy * 1e12 + wmo * 1e10 + wd * 1e8 + wh * 1e6 + wmi * 1e3 + ws;
  };

  const targetKey = y * 1e12 + mo * 1e10 + day * 1e8 + h * 1e6 + mi * 1e3 + sec;
  let lo = Date.UTC(y, mo - 1, day - 1, 0, 0, 0);
  let hi = Date.UTC(y, mo - 1, day + 2, 23, 59, 59);
  for (let i = 0; i < 48; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const wk = wallKey(mid);
    if (wk === targetKey) return new Date(mid);
    if (wk < targetKey) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

function normalizeInboundRow(raw: unknown, tenantDidE164: string): InboundRow | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const fromRaw = firstString(row, ["from", "src", "callerid", "contact", "sender"]);
  const toRaw = firstString(row, ["to", "dst", "did", "recipient"]);
  const from = canonicalSmsPhone(fromRaw);
  const to = canonicalSmsPhone(toRaw || tenantDidE164);
  if (!from.ok || !to.ok) return null;
  if (to.e164 !== tenantDidE164) return null;

  if (from.e164 === tenantDidE164) return null;

  const body = firstString(row, ["message", "body", "msg", "text"]);
  const mediaUrls = parseMediaUrls(row);
  const rawDirection = firstString(row, ["direction", "type", "message_type", "sms_type"]).toLowerCase();
  if (rawDirection === "0" || rawDirection === "sent" || rawDirection === "outbound" || rawDirection === "outgoing" || rawDirection === "tx") {
    return null;
  }
  if (rawDirection && rawDirection !== "1" && !["received", "inbound", "incoming", "rx", "both"].includes(rawDirection)) return null;

  const providerId =
    firstString(row, ["id", "sms", "sms_id", "message_id", "mms", "mms_id"]) ||
    `${tenantDidE164}:${from.e164}:${firstString(row, ["date", "timestamp", "created_at"])}:${body}:${mediaUrls.join(",")}`;

  return {
    providerMessageId: `voipms:${providerId}`,
    from: from.e164,
    to: to.e164,
    body,
    mediaUrls,
    createdAt: parseVoipMsDate(firstString(row, ["date", "timestamp", "created_at"])),
  };
}

async function loadVoipMsCreds(): Promise<VoipMsStoredCreds | null> {
  const row = await db.globalVoipMsConfig.findUnique({ where: { id: "default" } });
  if (!row?.credentialsEncrypted) return null;
  try {
    return decryptJson<VoipMsStoredCreds>(row.credentialsEncrypted);
  } catch {
    return null;
  }
}

async function fetchRecentSmsForDid(creds: VoipMsStoredCreds, didE164: string): Promise<InboundRow[]> {
  const base = creds.apiBaseUrl || DEFAULT_VOIPMS_API;
  const url = new URL(base);
  url.searchParams.set("api_username", creds.username);
  url.searchParams.set("api_password", creds.password);
  url.searchParams.set("method", "getSMS");
  url.searchParams.set("did", digits(didE164));
  url.searchParams.set("limit", "50");

  // Request last 2 days so we never miss messages around midnight UTC.
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateFrom = `${twoDaysAgo.getUTCFullYear()}-${pad(twoDaysAgo.getUTCMonth() + 1)}-${pad(twoDaysAgo.getUTCDate())}`;
  url.searchParams.set("date_from", dateFrom);

  const res = await fetch(url);
  const json: any = await res.json().catch(() => ({}));
  const status = String(json?.status || "").toLowerCase();
  if (!res.ok || (status && status !== "success" && status !== "no_sms")) {
    throw new Error(`VoIP.ms getSMS rejected for ${didE164}: ${json?.status || res.status}`);
  }
  if (status === "no_sms") return [];
  const rows =
    asArray(json.sms).length ? asArray(json.sms)
    : asArray(json.messages).length ? asArray(json.messages)
    : asArray(json.data).length ? asArray(json.data)
    : asArray(json.response);
  return rows.map((row) => normalizeInboundRow(row, didE164)).filter((row): row is InboundRow => !!row);
}

async function resolveInboxOwnerUserId(input: { tenantId: string; assignedUserId?: string | null; assignedExtensionId?: string | null }): Promise<string> {
  if (input.assignedUserId) return input.assignedUserId;
  if (!input.assignedExtensionId) return "";
  const ext = await db.extension.findFirst({
    where: { id: input.assignedExtensionId, tenantId: input.tenantId },
    select: { ownerUserId: true },
  });
  return ext?.ownerUserId || "";
}

async function upsertParticipants(input: { threadId: string; tenantId: string; inboxOwnerUserId: string; assignedExtensionId?: string | null }) {
  const users = input.inboxOwnerUserId
    ? await db.user.findMany({ where: { id: input.inboxOwnerUserId, tenantId: input.tenantId } })
    : await db.user.findMany({ where: { tenantId: input.tenantId } });
  for (const u of users) {
    await db.connectChatParticipant.upsert({
      where: { threadId_participantKey: { threadId: input.threadId, participantKey: `u:${u.id}` } },
      create: { threadId: input.threadId, participantKey: `u:${u.id}`, userId: u.id, role: "MEMBER" },
      update: { leftAt: null },
    });
  }
  if (input.assignedExtensionId) {
    await db.connectChatParticipant.upsert({
      where: { threadId_participantKey: { threadId: input.threadId, participantKey: `e:${input.assignedExtensionId}` } },
      create: {
        threadId: input.threadId,
        participantKey: `e:${input.assignedExtensionId}`,
        extensionId: input.assignedExtensionId,
        role: "MEMBER",
      },
      update: { leftAt: null },
    });
  }
}

async function importInboundMessage(input: {
  tenantId: string;
  tenantDidE164: string;
  assignedUserId?: string | null;
  assignedExtensionId?: string | null;
  row: InboundRow;
}) {
  const exists = await db.connectChatMessage.findFirst({
    where: { smsProviderMessageId: input.row.providerMessageId, direction: "INBOUND" },
    select: { id: true },
  });
  if (exists) return;

  const inboxScope = await resolveInboxOwnerUserId(input);
  const dedupeKey = `sms:${input.tenantId}:${input.tenantDidE164}:${input.row.from}:${inboxScope}`;

  // Search by number pair first (any dedupeKey variant) to avoid creating duplicate threads
  // when the existing thread was created by the webhook with a different suffix.
  let thread = await db.connectChatThread.findFirst({
    where: {
      tenantId: input.tenantId,
      tenantSmsE164: input.tenantDidE164,
      externalSmsE164: input.row.from,
      type: "SMS",
    },
    orderBy: { createdAt: "asc" },
  });

  if (!thread) {
    thread = await db.connectChatThread.create({
      data: {
        tenantId: input.tenantId,
        type: "SMS",
        title: `SMS ${input.row.from}`,
        dedupeKey,
        tenantSmsE164: input.tenantDidE164,
        tenantSmsRaw: input.tenantDidE164,
        externalSmsE164: input.row.from,
        externalSmsRaw: input.row.from,
        smsInboxOwnerUserId: inboxScope,
        lastMessageAt: input.row.createdAt || new Date(),
      },
    });
  } else if (!thread.smsInboxOwnerUserId && inboxScope) {
    // Backfill the inbox owner if the thread was created without one
    await db.connectChatThread.update({
      where: { id: thread.id },
      data: { smsInboxOwnerUserId: inboxScope, updatedAt: new Date() },
    });
  }
  await upsertParticipants({
    threadId: thread.id,
    tenantId: input.tenantId,
    inboxOwnerUserId: inboxScope,
    assignedExtensionId: input.assignedExtensionId || null,
  });

  const msg = await db.connectChatMessage.create({
    data: {
      tenantId: input.tenantId,
      threadId: thread.id,
      direction: "INBOUND",
      type: input.row.mediaUrls.length ? "IMAGE" : "TEXT",
      body: input.row.body,
      deliveryStatus: "delivered",
      smsProviderMessageId: input.row.providerMessageId,
      metadata: input.row.mediaUrls.length ? { mms: { urls: input.row.mediaUrls }, source: "voipms_getSMS" } : { source: "voipms_getSMS" },
      ...(input.row.createdAt ? { createdAt: input.row.createdAt } : {}),
    },
  } as any);
  const newLastAt = input.row.createdAt || msg.createdAt;
  // Only advance lastMessageAt — never regress it for older out-of-order imports.
  if (!thread.lastMessageAt || newLastAt > thread.lastMessageAt) {
    await db.connectChatThread.update({
      where: { id: thread.id },
      data: { lastMessageAt: newLastAt, updatedAt: new Date() },
    });
  }
  await db.smsRoutingLog.create({
    data: {
      rawFrom: input.row.from,
      rawTo: input.tenantDidE164,
      normalizedFrom: input.row.from,
      normalizedTo: input.tenantDidE164,
      direction: "inbound",
      resolvedTenantId: input.tenantId,
      resolvedUserId: inboxScope || null,
      resolvedExtensionId: input.assignedExtensionId || null,
      resolvedThreadId: thread.id,
      status: "routed_poll",
      payload: { providerMessageId: input.row.providerMessageId, mediaUrls: input.row.mediaUrls },
    },
  });
}

let running = false;

export async function runVoipMsInboundSyncCycle(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const creds = await loadVoipMsCreds();
    if (!creds?.username || !creds.password) {
      console.warn("[voipms-inbound] no credentials found — skipping sync");
      return;
    }
    const numbers = await db.tenantSmsNumber.findMany({
      where: { tenantId: { not: null }, active: true, smsCapable: true },
      select: {
        tenantId: true,
        phoneE164: true,
        assignedUserId: true,
        assignedExtensionId: true,
      },
      orderBy: { updatedAt: "desc" },
      take: 500,
    });
    if (numbers.length === 0) {
      console.log("[voipms-inbound] no tenant SMS numbers to poll");
      return;
    }
    let totalFetched = 0;
    for (const n of numbers) {
      if (!n.tenantId) continue;
      try {
        const rows = await fetchRecentSmsForDid(creds, n.phoneE164);
        totalFetched += rows.length;
        for (const row of rows) {
          await importInboundMessage({
            tenantId: n.tenantId,
            tenantDidE164: n.phoneE164,
            assignedUserId: n.assignedUserId,
            assignedExtensionId: n.assignedExtensionId,
            row,
          });
        }
        console.log(`[voipms-inbound] ${n.phoneE164}: fetched=${rows.length}`);
      } catch (err: any) {
        console.warn("[voipms-inbound] sync failed", n.phoneE164, err?.message || err);
      }
    }
    console.log(`[voipms-inbound] cycle done: numbers=${numbers.length} fetched=${totalFetched}`);
  } finally {
    running = false;
  }
}
