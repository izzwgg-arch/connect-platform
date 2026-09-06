import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import {
  canonicalSmsPhone,
  canonicalSmsSender,
  buildSmsDedupeKey,
  normalizeSmsInboxAssignmentMode,
  resolveSmsInboxScope,
  smsInboxScopeForAssignedUser,
} from "@connect/shared";
import { upsertSmsThreadParticipants } from "./smsInboxParticipants";
import { crmInboundSmsHook } from "./crmInboundSmsHook";
import { fetchVoipMsMmsToChatFile, mediaKindFromMime } from "../../../packages/shared/src/voipMsInboundMms";

export type SmsPushInput = {
  tenantId: string;
  userId: string;
  conversationId: string;
  messageId: string;
  phoneNumber: string;
  preview: string;
  timestamp: string;
};

/** Called once per non-muted participant after a new inbound SMS is stored. */
export type SmsPushFn = (input: SmsPushInput) => Promise<void>;

type VoipMsStoredCreds = { username: string; password: string; apiBaseUrl?: string };

type InboundRow = {
  providerMessageId: string;
  from: string;
  to: string;
  body: string;
  mediaUrls: string[];
  createdAt?: Date;
};
type SmsAssignedUser = { userId: string; inboxMode?: string | null };

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

/**
 * ⛔ NOT a product cap — a pathological bound only (carriers reject an MMS long
 * before 50 attachments). Izzy, 2026-08-30: "There is no cap, and there
 * shouldn't be a cap." A hardcoded 1..3 scan here is how two of a customer's
 * five photos silently vanished (FixUp Group, voipms:10166591 carried
 * col_media1..col_media5 and Connect stored three).
 */
export const MAX_INBOUND_MMS_MEDIA = 50;

export function parseMediaUrls(row: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    const s = String(v ?? "").trim();
    if (s) out.push(s);
  };
  const direct = row.media ?? row.mms ?? row.media_urls ?? row.mediaUrls;
  if (Array.isArray(direct)) direct.forEach(push);
  else if (typeof direct === "string") direct.split(/[,\s]+/).forEach(push);
  // Numbered keys — media1..N and col_media1..N in any case. VoIP.ms getMMS
  // emits as many col_mediaN keys as the message has attachments; scan them
  // ALL, in numeric order, never a hardcoded 1..3.
  const numbered = Object.keys(row)
    .map((k) => {
      const m = /^(?:col_)?media(\d+)$/i.exec(k);
      return m ? { k, n: Number(m[1]) } : null;
    })
    .filter((x): x is { k: string; n: number } => x !== null)
    .sort((a, b) => a.n - b.n);
  for (const { k } of numbered) push(row[k]);
  // The array form and the numbered keys usually carry the SAME urls — dedupe
  // preserving order (the old code returned early on the array form instead).
  return [...new Set(out)].slice(0, MAX_INBOUND_MMS_MEDIA);
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
  // ⛔ The sender is NOT always a phone number — verification codes arrive from
  // numeric short codes (WhatsApp uses 29283). Running it through the strict
  // `canonicalSmsPhone` and returning null here silently discarded every one of
  // them. The destination stays strict: it must be our own DID.
  const from = canonicalSmsSender(fromRaw);
  const to = canonicalSmsPhone(toRaw || tenantDidE164);
  if (!to.ok) return null;
  if (to.e164 !== tenantDidE164) return null;
  if (!from.ok) {
    // Never silent: a dropped inbound message must leave a trace to grep for.
    console.warn(
      `[voipms-inbound] dropped inbound message: unusable sender ${JSON.stringify(fromRaw)} on ${tenantDidE164} (${from.error})`,
    );
    return null;
  }

  if (from.sender === tenantDidE164) return null;

  const body = firstString(row, ["message", "body", "msg", "text"]);
  const mediaUrls = parseMediaUrls(row);
  const rawDirection = firstString(row, ["direction", "type", "message_type", "sms_type"]).toLowerCase();
  if (rawDirection === "0" || rawDirection === "sent" || rawDirection === "outbound" || rawDirection === "outgoing" || rawDirection === "tx") {
    return null;
  }
  if (rawDirection && rawDirection !== "1" && !["received", "inbound", "incoming", "rx", "both"].includes(rawDirection)) return null;

  const providerId =
    firstString(row, ["id", "sms", "sms_id", "message_id", "mms", "mms_id"]) ||
    `${tenantDidE164}:${from.sender}:${firstString(row, ["date", "timestamp", "created_at"])}:${body}:${mediaUrls.join(",")}`;

  return {
    providerMessageId: `voipms:${providerId}`,
    from: from.sender,
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

function messageArrayFromVoipMsJson(json: any): any[] {
  return asArray(json.sms).length ? asArray(json.sms)
    : asArray(json.mms).length ? asArray(json.mms)
    : asArray(json.messages).length ? asArray(json.messages)
    : asArray(json.data).length ? asArray(json.data)
    : asArray(json.response);
}

function rowMessageId(row: Record<string, unknown>): string {
  return firstString(row, ["id", "sms", "sms_id", "message_id", "mms", "mms_id"]);
}

/** Last 2 days (UTC date) — same window for getSMS + getMMS. */
function voipMsDateFromParam(): string {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${twoDaysAgo.getUTCFullYear()}-${pad(twoDaysAgo.getUTCMonth() + 1)}-${pad(twoDaysAgo.getUTCDate())}`;
}

/**
 * Account-wide getSMS page size. VoIP.ms answers ~7–11 s per API call
 * (measured 2026-09-06: getSMS 7.4 s, getMMS 10.9 s), so the old per-number
 * loop — getSMS+getMMS for each of 16 numbers — took ~3–3.5 min per cycle
 * and a text sat unread for up to that long ("incoming messages take too
 * long", Fixup Group). One account-wide getSMS + one getMMS per cycle costs
 * ~11 s. If a page comes back FULL the cycle falls back to the per-number
 * fetch, so a burst can never be silently truncated.
 */
export const ACCOUNT_WIDE_SMS_LIMIT = 500;

async function fetchVoipMsMethod(
  creds: VoipMsStoredCreds,
  didE164: string,
  method: "getSMS" | "getMMS",
  opts?: { accountWide?: boolean },
): Promise<Record<string, unknown>[]> {
  const base = creds.apiBaseUrl || DEFAULT_VOIPMS_API;
  const url = new URL(base);
  url.searchParams.set("api_username", creds.username);
  url.searchParams.set("api_password", creds.password);
  url.searchParams.set("method", method);
  const dateFrom = voipMsDateFromParam();
  if (method === "getMMS") {
    // getMMS uses `from` (VoIP.ms docs); did/limit are not in the published example — filter rows client-side.
    url.searchParams.set("from", dateFrom);
  } else if (opts?.accountWide) {
    // No `did`: every DID on the account in one call; rows carry their own `did`.
    url.searchParams.set("limit", String(ACCOUNT_WIDE_SMS_LIMIT));
    url.searchParams.set("date_from", dateFrom);
  } else {
    url.searchParams.set("did", digits(didE164));
    url.searchParams.set("limit", "50");
    url.searchParams.set("date_from", dateFrom);
  }

  const res = await fetch(url);
  const json: any = await res.json().catch(() => ({}));
  const status = String(json?.status || "").toLowerCase();
  const emptyOk = method === "getMMS" ? ["no_mms", "no_sms"] : ["no_sms"];
  if (!res.ok || (status && status !== "success" && !emptyOk.includes(status))) {
    throw new Error(`VoIP.ms ${method} rejected for ${didE164}: ${json?.status || res.status}`);
  }
  if (emptyOk.includes(status)) return [];
  return messageArrayFromVoipMsJson(json) as Record<string, unknown>[];
}

/**
 * Merge getSMS + getMMS: SMS poll often omits MMS URLs; getMMS includes col_media1..3.
 */
async function fetchRecentSmsForDid(creds: VoipMsStoredCreds, didE164: string): Promise<InboundRow[]> {
  const [smsRaw, mmsRaw] = await Promise.all([
    fetchVoipMsMethod(creds, didE164, "getSMS").catch((err: any) => {
      console.warn("[voipms-inbound] getSMS failed", didE164, err?.message || err);
      return [] as Record<string, unknown>[];
    }),
    fetchVoipMsMethod(creds, didE164, "getMMS").catch((err: any) => {
      console.warn("[voipms-inbound] getMMS failed", didE164, err?.message || err);
      return [] as Record<string, unknown>[];
    }),
  ]);
  return mergeInboundRowsForDid(didE164, smsRaw, mmsRaw);
}

export type AccountWideBatch = {
  smsRaw: Record<string, unknown>[];
  mmsRaw: Record<string, unknown>[];
  /** false when the getSMS page came back full — a burst may be truncated, so callers must fall back to per-DID. */
  complete: boolean;
};

/**
 * ONE getSMS + ONE getMMS for the whole account. Throws when getSMS fails
 * (the caller then falls back to the per-number path); a failed getMMS only
 * costs the MMS URLs, exactly as it did per number.
 */
async function fetchAccountWideRecent(creds: VoipMsStoredCreds): Promise<AccountWideBatch> {
  const [smsRaw, mmsRaw] = await Promise.all([
    fetchVoipMsMethod(creds, "", "getSMS", { accountWide: true }),
    fetchVoipMsMethod(creds, "", "getMMS").catch((err: any) => {
      console.warn("[voipms-inbound] account-wide getMMS failed", err?.message || err);
      return [] as Record<string, unknown>[];
    }),
  ]);
  return { smsRaw, mmsRaw, complete: smsRaw.length < ACCOUNT_WIDE_SMS_LIMIT };
}

/**
 * Pick out and merge the rows that belong to ONE of our DIDs. Rows for other
 * DIDs are dropped by the `did` check here and again by
 * normalizeInboundRow's `to === tenantDidE164` rule, so the same batch can
 * be handed to every number in the cycle.
 */
export function mergeInboundRowsForDid(
  didE164: string,
  smsRaw: Record<string, unknown>[],
  mmsRaw: Record<string, unknown>[],
): InboundRow[] {
  const mergeMap = new Map<string, InboundRow>();

  function ingest(raw: Record<string, unknown>) {
    const rowDid = firstString(raw, ["did", "recipient", "to", "dst"]);
    if (rowDid) {
      const d = canonicalSmsPhone(rowDid);
      if (d.ok && d.e164 !== didE164) return;
    }
    const n = normalizeInboundRow(raw, didE164);
    if (!n) return;
    const idKey = rowMessageId(raw);
    if (!idKey) {
      mergeMap.set(`${n.providerMessageId}:${mergeMap.size}`, n);
      return;
    }
    const prev = mergeMap.get(idKey);
    if (!prev) {
      mergeMap.set(idKey, n);
      return;
    }
    prev.mediaUrls = [...new Set([...prev.mediaUrls, ...n.mediaUrls])].slice(0, 10);
    if (!String(prev.body || "").trim() && String(n.body || "").trim()) prev.body = n.body;
    const pt = prev.createdAt?.getTime() ?? 0;
    const nt = n.createdAt?.getTime() ?? 0;
    if (nt && (!prev.createdAt || nt < pt)) prev.createdAt = n.createdAt;
  }

  for (const raw of smsRaw) ingest(raw);
  for (const raw of mmsRaw) ingest(raw);

  return [...mergeMap.values()];
}

async function resolveInboxOwnerUserId(input: { tenantId: string; assignedUserId?: string | null; assignedExtensionId?: string | null }): Promise<string> {
  if (input.assignedUserId) return input.assignedUserId;
  let extensionOwnerUserId: string | null = null;
  if (input.assignedExtensionId) {
    const ext = await db.extension.findFirst({
      where: { id: input.assignedExtensionId, tenantId: input.tenantId },
      select: { ownerUserId: true },
    });
    extensionOwnerUserId = ext?.ownerUserId ?? null;
  }
  return resolveSmsInboxScope({ assignedUserId: input.assignedUserId, extensionOwnerUserId });
}

async function upsertParticipants(input: {
  threadId: string;
  tenantId: string;
  inboxOwnerUserId: string;
  assignedExtensionId?: string | null;
  multiAssignedUserIds?: string[];
}) {
  await upsertSmsThreadParticipants(input);
}

/**
 * Download one VoIP.ms MMS URL with a couple of quick retries. The carrier's
 * media endpoint is occasionally flaky; a transient miss here is what later
 * leaves a message stranded on an expiring VoIP.ms URL, so we retry before
 * giving up on this cycle.
 */
async function fetchVoipMsMmsWithRetry(
  input: { tenantId: string; threadId: string; sourceUrl: string; isSmsThread: boolean },
  attempts = 3,
): Promise<Awaited<ReturnType<typeof fetchVoipMsMmsToChatFile>>> {
  for (let i = 0; i < attempts; i++) {
    const written = await fetchVoipMsMmsToChatFile(input).catch(() => null);
    if (written) return written;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
  }
  return null;
}

async function mirrorInboundMmsToAttachments(input: {
  tenantId: string;
  threadId: string;
  messageId: string;
  externalUrls: string[];
}) {
  const urls = input.externalUrls.filter((u) => /^https?:\/\//i.test(String(u || "").trim())).slice(0, MAX_INBOUND_MMS_MEDIA);
  if (!urls.length) return;
  // Idempotency by COUNT, not by "any attachment exists": attachments are
  // created in url order, so a message that already mirrored its first N urls
  // resumes at N. The old `existing > 0 → return` froze a message at however
  // many attachments the first pass stored — which, combined with the old
  // 3-url parse cap, is exactly how extra photos stayed lost forever even
  // after the metadata gained the full url list.
  const existing = await db.connectChatMessageAttachment.count({ where: { messageId: input.messageId } });
  if (existing >= urls.length) return;
  for (const url of urls.slice(existing)) {
    const written = await fetchVoipMsMmsWithRetry({
      tenantId: input.tenantId,
      threadId: input.threadId,
      sourceUrl: url,
      isSmsThread: true,
    });
    if (!written) {
      console.warn(
        JSON.stringify({
          event: "voipms_inbound_mms_mirror_failed",
          messageId: input.messageId,
          urlPrefix: url.slice(0, 96),
        }),
      );
      continue;
    }
    await db.connectChatMessageAttachment.create({
      data: {
        messageId: input.messageId,
        tenantId: input.tenantId,
        fileName: written.fileName,
        mimeType: written.mimeType,
        sizeBytes: written.sizeBytes,
        storageKey: written.storageKey,
        scanStatus: "pending",
        mediaKind: mediaKindFromMime(written.mimeType),
      },
    });
  }
}

function smsPushPreview(body: string, hasMedia: boolean): string {
  if (hasMedia && !body.trim()) return "Sent an attachment";
  const text = (body || "New SMS message").trim();
  return text.length > 100 ? `${text.slice(0, 97)}…` : text;
}

async function importInboundMessage(input: {
  tenantId: string;
  tenantDidE164: string;
  assignedUserId?: string | null;
  assignedExtensionId?: string | null;
  /** Users explicitly assigned via TenantSmsNumberUser join table. */
  multiAssignedUsers?: SmsAssignedUser[];
  row: InboundRow;
  sendSmsPush?: SmsPushFn;
}) {
  const existingMsg = await db.connectChatMessage.findFirst({
    where: { smsProviderMessageId: input.row.providerMessageId, direction: "INBOUND" },
    select: { id: true, metadata: true, type: true },
  });
  if (existingMsg) {
    // Earlier polls only used getSMS — MMS often had no URLs until getMMS merge; backfill metadata.
    const row = await db.connectChatMessage.findFirst({
      where: { id: existingMsg.id },
      select: { id: true, threadId: true, tenantId: true, metadata: true },
    });
    if (row) {
      let meta = (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as {
        mms?: { urls?: string[] };
        source?: string;
      };
      const cur = Array.isArray(meta.mms?.urls) ? meta.mms!.urls! : [];
      // Also grows an EXISTING url list: a message first seen through getSMS
      // (or through the old 3-url cap) picks up the rest of its media on the
      // next poll while the row is still inside the 2-day window.
      if (input.row.mediaUrls.length > cur.length) {
        meta = { ...meta, mms: { urls: input.row.mediaUrls }, source: "voipms_getSMS_getMMS" };
        await db.connectChatMessage.update({
          where: { id: existingMsg.id },
          data: {
            type: "IMAGE",
            metadata: meta as object,
            updatedAt: new Date(),
          },
        });
      }
      const urls = Array.isArray(meta.mms?.urls) ? meta.mms!.urls! : [];
      await mirrorInboundMmsToAttachments({
        tenantId: row.tenantId,
        threadId: row.threadId,
        messageId: row.id,
        externalUrls: urls,
      });
    }
    return;
  }

  const assignedUsers = input.multiAssignedUsers ?? [];
  const sharedAssignedUserIds = assignedUsers
    .filter((u) => normalizeSmsInboxAssignmentMode(u.inboxMode) === "SHARED")
    .map((u) => u.userId);
  const personalAssignedUserIds = assignedUsers
    .filter((u) => normalizeSmsInboxAssignmentMode(u.inboxMode) === "PERSONAL")
    .map((u) => u.userId);

  let inboxScope = await resolveInboxOwnerUserId(input);
  let sharedParticipantUserIds = sharedAssignedUserIds;
  if (!input.assignedUserId && !input.assignedExtensionId && personalAssignedUserIds.length > 0) {
    const existingPersonalThreads = await db.connectChatThread.findMany({
      where: {
        tenantId: input.tenantId,
        tenantSmsE164: input.tenantDidE164,
        externalSmsE164: input.row.from,
        type: "SMS",
        active: true,
        smsInboxOwnerUserId: { in: personalAssignedUserIds },
      },
      orderBy: { lastMessageAt: "desc" },
      take: 2,
      select: { id: true, smsInboxOwnerUserId: true },
    });
    if (existingPersonalThreads.length === 1) {
      inboxScope = existingPersonalThreads[0]?.smsInboxOwnerUserId || "";
    } else if (existingPersonalThreads.length === 0 && personalAssignedUserIds.length === 1 && sharedAssignedUserIds.length === 0) {
      inboxScope = smsInboxScopeForAssignedUser({ userId: personalAssignedUserIds[0]!, inboxMode: "PERSONAL" });
    } else {
      // Ambiguous inbound replies to the same DID/contact cannot identify one private mailbox.
      // Route to a shared assigned-users thread rather than guessing the wrong owner.
      inboxScope = "";
      sharedParticipantUserIds = [...new Set([...sharedAssignedUserIds, ...personalAssignedUserIds])];
    }
  }
  const dedupeKey = buildSmsDedupeKey(input.tenantId, input.tenantDidE164, input.row.from, inboxScope);

  let thread = await db.connectChatThread.findUnique({ where: { dedupeKey } });
  if (!thread) {
    thread = await db.connectChatThread.findFirst({
      where: {
        tenantId: input.tenantId,
        tenantSmsE164: input.tenantDidE164,
        externalSmsE164: input.row.from,
        type: "SMS",
        smsInboxOwnerUserId: inboxScope,
      },
      orderBy: { createdAt: "asc" },
    });
  }

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
  }
  await upsertParticipants({
    threadId: thread.id,
    tenantId: input.tenantId,
    inboxOwnerUserId: inboxScope,
    assignedExtensionId: input.assignedExtensionId || null,
    multiAssignedUserIds: sharedParticipantUserIds,
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
      metadata: input.row.mediaUrls.length
        ? { mms: { urls: input.row.mediaUrls }, source: "voipms_getSMS_getMMS" }
        : { source: "voipms_getSMS_getMMS" },
      ...(input.row.createdAt ? { createdAt: input.row.createdAt } : {}),
    },
  } as any);
  await mirrorInboundMmsToAttachments({
    tenantId: input.tenantId,
    threadId: thread.id,
    messageId: msg.id,
    externalUrls: input.row.mediaUrls,
  });
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

  // Push notification fan-out — must not roll back the message save on failure.
  if (input.sendSmsPush) {
    const preview = smsPushPreview(input.row.body, input.row.mediaUrls.length > 0);
    const timestamp = new Date().toISOString();
    const recipients = await db.connectChatParticipant.findMany({
      where: { threadId: thread.id, leftAt: null, muted: false, userId: { not: null } },
      select: { userId: true },
    });
    let attempted = 0;
    await Promise.all(
      recipients.map(async (r) => {
        if (!r.userId) return;
        attempted++;
        await input.sendSmsPush!({
          tenantId: input.tenantId,
          userId: r.userId,
          conversationId: thread.id,
          messageId: msg.id,
          phoneNumber: input.row.from,
          preview,
          timestamp,
        }).catch((err: any) => {
          console.warn(
            JSON.stringify({
              event: "voipms_inbound_sms_push_error",
              threadId: thread.id,
              messageId: msg.id,
              userId: r.userId,
              err: err?.message || String(err),
            }),
          );
        });
      }),
    );
    console.info(
      JSON.stringify({
        event: "voipms_inbound_sms_push_sent",
        threadId: thread.id,
        messageId: msg.id,
        recipientCount: recipients.length,
        attempted,
      }),
    );
  }
  // CRM Phase 11B — non-blocking inbound SMS timeline hook.
  // Must not throw or delay message persistence / push fan-out.
  crmInboundSmsHook({
    tenantId: input.tenantId,
    fromE164: input.row.from,
    toE164: input.tenantDidE164,
    body: input.row.body,
    messageId: msg.id,
    smsProviderMessageId: (msg as any).smsProviderMessageId ?? null,
  }).catch(() => {});
}

/**
 * Re-mirror recent inbound SMS/MMS that is still stranded on VoIP.ms-hosted
 * media URLs into permanent local storage.
 *
 * Why this exists: the live sync only re-tries mirroring for messages inside
 * its ~2-day getSMS/getMMS poll window, but VoIP.ms keeps the underlying media
 * reachable for roughly a week. A transient mirror failure during those first
 * two days would otherwise never be retried, and the carrier URL then expires
 * ~7 days later — making the photo/video/file "disappear after a week". This
 * sweep keeps retrying every un-mirrored inbound MMS for the whole window the
 * source is alive, so once it succeeds the media is stored forever.
 */
export async function runVoipMsMmsMirrorBackfill(opts?: { lookbackDays?: number; maxMessages?: number }): Promise<void> {
  const lookbackDays = Math.max(1, opts?.lookbackDays ?? Number(process.env.VOIPMS_MMS_MIRROR_LOOKBACK_DAYS || 6));
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  let candidates: Array<{ id: string; tenantId: string; threadId: string; metadata: unknown }>;
  try {
    candidates = await db.connectChatMessage.findMany({
      where: {
        direction: "INBOUND",
        createdAt: { gte: since },
        attachments: { none: {} },
        thread: { type: "SMS" },
      },
      select: { id: true, tenantId: true, threadId: true, metadata: true },
      orderBy: { createdAt: "desc" },
      take: Math.max(1, opts?.maxMessages ?? 300),
    });
  } catch (err: any) {
    console.warn("[voipms-mirror-backfill] query failed", err?.message || err);
    return;
  }

  let attempted = 0;
  let mirrored = 0;
  for (const m of candidates) {
    const meta = (m.metadata && typeof m.metadata === "object" ? m.metadata : {}) as { mms?: { urls?: string[] } };
    const urls = Array.isArray(meta.mms?.urls)
      ? meta.mms!.urls!.filter((u) => /^https?:\/\//i.test(String(u || "").trim()))
      : [];
    if (!urls.length) continue;
    attempted++;
    const before = await db.connectChatMessageAttachment.count({ where: { messageId: m.id } });
    await mirrorInboundMmsToAttachments({
      tenantId: m.tenantId,
      threadId: m.threadId,
      messageId: m.id,
      externalUrls: urls,
    }).catch((err: any) => console.warn("[voipms-mirror-backfill] mirror failed", m.id, err?.message || err));
    const after = await db.connectChatMessageAttachment.count({ where: { messageId: m.id } });
    if (after > before) mirrored++;
  }

  if (attempted) {
    console.info(
      JSON.stringify({ event: "voipms_mms_mirror_backfill", scanned: candidates.length, attempted, mirrored, lookbackDays }),
    );
  }
}

let running = false;

export async function runVoipMsInboundSyncCycle(opts?: { sendSmsPush?: SmsPushFn }): Promise<void> {
  if (running) return;
  running = true;
  try {
    const creds = await loadVoipMsCreds();
    if (!creds?.username || !creds.password) {
      console.warn("[voipms-inbound] no credentials found — skipping sync");
      return;
    }
    const numbers = await (db as any).tenantSmsNumber.findMany({
      // ⛔ `provider: "VOIPMS"` is load-bearing: this job polls VoIP.ms getSMS,
      // so a SIGNALWIRE number here would burn a carrier query per cycle that
      // can only ever answer no_sms (SignalWire inbound arrives by WEBHOOK —
      // /webhooks/signalwire/sms — not by poll). The column is NOT NULL with
      // default VOIPMS, so every pre-SignalWire row still matches.
      where: { tenantId: { not: null }, active: true, smsCapable: true, provider: "VOIPMS" },
      select: {
        tenantId: true,
        phoneE164: true,
        assignedUserId: true,
        assignedExtensionId: true,
        assignedUsers: { select: { userId: true, inboxMode: true }, orderBy: { createdAt: "asc" } },
      },
      orderBy: { updatedAt: "desc" },
      take: 500,
    });
    if (numbers.length === 0) {
      console.log("[voipms-inbound] no tenant SMS numbers to poll");
      return;
    }
    // One account-wide fetch per cycle (see ACCOUNT_WIDE_SMS_LIMIT). A failed
    // or FULL page falls back to the exact per-number path used before.
    const cycleStartedAt = Date.now();
    let batch: AccountWideBatch | null = null;
    try {
      const b = await fetchAccountWideRecent(creds);
      if (b.complete) batch = b;
      else console.warn(`[voipms-inbound] account-wide getSMS page full (${b.smsRaw.length}) — falling back to per-number fetch`);
    } catch (err: any) {
      console.warn("[voipms-inbound] account-wide getSMS failed — falling back to per-number fetch", err?.message || err);
    }
    const mode = batch ? "account" : "per_did";
    let totalFetched = 0;
    for (const n of numbers) {
      if (!n.tenantId) continue;
      try {
        const rows = batch
          ? mergeInboundRowsForDid(n.phoneE164, batch.smsRaw, batch.mmsRaw)
          : await fetchRecentSmsForDid(creds, n.phoneE164);
        totalFetched += rows.length;
        for (const row of rows) {
          await importInboundMessage({
            tenantId: n.tenantId,
            tenantDidE164: n.phoneE164,
            assignedUserId: n.assignedUserId,
            assignedExtensionId: n.assignedExtensionId,
            multiAssignedUsers: ((n as any).assignedUsers ?? []).map((u: any) => ({
              userId: u.userId,
              inboxMode: u.inboxMode,
            })),
            row,
            sendSmsPush: opts?.sendSmsPush,
          });
        }
        console.log(`[voipms-inbound] ${n.phoneE164}: fetched=${rows.length}`);
      } catch (err: any) {
        console.warn("[voipms-inbound] sync failed", n.phoneE164, err?.message || err);
      }
    }
    console.log(`[voipms-inbound] cycle done: numbers=${numbers.length} fetched=${totalFetched} mode=${mode} ms=${Date.now() - cycleStartedAt}`);
  } finally {
    running = false;
  }
}
