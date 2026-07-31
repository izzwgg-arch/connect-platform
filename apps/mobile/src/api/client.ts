import { Platform } from "react-native";
import * as ExpoNotifications from "expo-notifications";
import type {
  AuthResponse,
  CallRecord,
  ChatDirectoryUser,
  ChatMessage,
  ChatMessageType,
  ChatLocation,
  PendingChatAttachment,
  ChatThread,
  ContactsResponse,
  TeamDirectoryMember,
  VoiceExtension,
  OutboundDialRoute,
  Voicemail,
  VoicemailFolder,
  VoicemailResponse,
} from "../types";
import {
  shouldFetchAnotherVoicemailPage,
  VOICEMAIL_API_PAGE_SIZE,
  VOICEMAIL_MAX_PAGES_PER_FOLDER,
} from "./voicemailPagination";
import { decodeJwtPayloadLoose } from "../voicemail/vmGreetingInviteUtils";
import { applyServerFeatureFlags } from "../config/featureFlags";
import {
  distinctExtensionsFromVoicemails,
  filterVoicemailsToScopedMailboxes,
  mergeVoicemailScopeMeta,
  voicemailIdsSample,
  voicemailTokenSessionKey,
  type VoicemailApiScopeMeta,
} from "./voicemailClientScope";

export const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL || "https://app.connectcomunications.com/api";

async function parseJson(res: Response) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const json = await parseJson(res);
  if (!res.ok || !json?.token) throw new Error(json?.error || "LOGIN_FAILED");
  return json as AuthResponse;
}

export async function getVoiceExtension(token: string): Promise<VoiceExtension> {
  const res = await fetch(`${API_BASE}/voice/me/extension`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "VOICE_EXTENSION_FAILED");
  return json as VoiceExtension;
}

export async function getOutboundRoutes(token: string): Promise<OutboundDialRoute[]> {
  const res = await fetch(`${API_BASE}/me/outbound-routes`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "OUTBOUND_ROUTES_FAILED");
  return Array.isArray(json?.routes) ? (json.routes as OutboundDialRoute[]) : [];
}

export async function resolveOutboundDial(
  token: string,
  input: { number: string; outboundRouteId?: string | null },
): Promise<{ finalNumber: string; originalNumber: string; normalizedNumber: string; outboundRouteId: string | null }> {
  const res = await fetch(`${API_BASE}/me/outbound-routes/resolve-dial`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "OUTBOUND_DIAL_RESOLVE_FAILED");
  return json;
}

/** Extra SIP account (an extension from another tenant) attached to this user. */
export type UserSipAccount = {
  id: string;
  tenantId: string;
  tenantName: string | null;
  label: string;
  extensionNumber: string | null;
  ready: boolean;
  routes: OutboundDialRoute[];
};

export async function getSipAccounts(token: string): Promise<UserSipAccount[]> {
  const res = await fetch(`${API_BASE}/voice/me/sip-accounts`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "SIP_ACCOUNTS_FAILED");
  return Array.isArray(json?.accounts) ? (json.accounts as UserSipAccount[]) : [];
}

export async function resolveSipAccountDial(
  token: string,
  input: { number: string; accountId: string; outboundRouteId?: string | null },
): Promise<{ finalNumber: string; originalNumber: string; normalizedNumber: string; accountId: string; outboundRouteId: string | null }> {
  const res = await fetch(`${API_BASE}/voice/me/sip-accounts/resolve-dial`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "SIP_ACCOUNT_DIAL_RESOLVE_FAILED");
  return json;
}

export async function getSipAccountProvisioning(
  token: string,
  accountId: string,
): Promise<{ sipPassword: string; provisioning: any }> {
  const res = await fetch(`${API_BASE}/voice/me/sip-accounts/${encodeURIComponent(accountId)}/reset-sip-password`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({})
  });
  const json = await parseJson(res);
  if (!res.ok || !json?.sipPassword) throw new Error(json?.error || "SIP_ACCOUNT_PROVISION_FAILED");
  return json;
}

/**
 * Fresh ICE servers (STUN + TURN with freshly-minted, time-limited relay
 * credentials). The provisioning bundle cached in SecureStore goes relay-dead
 * within 24h (TURN creds expire) — overlay this at every SIP configure.
 * Short timeout: this must never delay startup when offline.
 */
export async function getFreshIceServers(
  token: string,
): Promise<Array<{ urls: string | string[]; username?: string; credential?: string }> | null> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${API_BASE}/voice/ice-servers`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    clearTimeout(t);
    const json = await parseJson(res);
    if (!res.ok || !Array.isArray(json?.iceServers) || json.iceServers.length === 0) return null;
    return json.iceServers;
  } catch {
    return null;
  }
}

export async function resetSipPassword(token: string): Promise<{ sipPassword: string; provisioning: any }> {
  const res = await fetch(`${API_BASE}/voice/me/reset-sip-password`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({})
  });
  const json = await parseJson(res);
  if (!res.ok || !json?.sipPassword) throw new Error(json?.error || "SIP_RESET_FAILED");
  return json;
}

export async function getCallHistory(token: string): Promise<CallRecord[]> {
  const res = await fetch(`${API_BASE}/voice/me/calls`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "VOICE_CALLS_FAILED");
  return Array.isArray(json) ? (json as CallRecord[]) : [];
}

/**
 * Partition React Query cache per JWT identity — never reuse voicemail rows across
 * logins (same queryKey as another user would show stale cached voicemails).
 */
export function voicemailQueryUserScope(token: string | null | undefined): string {
  if (!token) return "_";
  const sess = voicemailTokenSessionKey(token);
  const p = decodeJwtPayloadLoose(token);
  if (!p) return `opaque:${sess}`;
  const sub = String(p.sub ?? "");
  const tid = String(p.tenantId ?? p["tid"] ?? "");
  if (sub && tid) return `${sub}:${tid}:${sess}`;
  if (sub) return `${sub}::${sess}`;
  return `opaque:${sess}`;
}

export const mobileQueryKeys = {
  callHistory: ["mobile", "callHistory"] as const,
  voicemails: (folder: VoicemailFolder | "all" = "all", token: string | null | undefined = null) =>
    ["mobile", "voicemails", folder, voicemailQueryUserScope(token)] as const,
  teamDirectory: (scope: string) => ["mobile", "teamDirectory", scope] as const,
  contacts: (query = "") => ["mobile", "contacts", query] as const,
  chatThreads: ["mobile", "chatThreads"] as const,
  chatMessages: (threadId: string) => ["mobile", "chatMessages", threadId] as const,
};

/** Fresh stream URL for current token — never reuse a cached `streamUrl` from an older session. */
export function buildVoicemailStreamUri(token: string, vmId: string): string {
  return `${API_BASE}/voice/voicemail/${encodeURIComponent(vmId)}/stream?token=${encodeURIComponent(token)}`;
}

/**
 * Preload URL — same as stream but with `raw=1` so the API skips the ffmpeg
 * transcode step and returns the original audio file (WAV/PCM) directly.
 * Android MediaPlayer (expo-av) handles WAV natively; this saves 500ms–2s of
 * server-side processing per preload request. Only use for local file caching;
 * do not pass to Audio.Sound directly without the cache fallback guard.
 */
export function buildVoicemailPreloadUri(token: string, vmId: string): string {
  return `${API_BASE}/voice/voicemail/${encodeURIComponent(vmId)}/stream?token=${encodeURIComponent(token)}&raw=1`;
}

/** Lightweight probe to distinguish 403 (forbidden) from transport/audio errors. */
export async function probeVoicemailStreamStatus(token: string, vmId: string): Promise<number> {
  const url = buildVoicemailStreamUri(token, vmId);
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Range: "bytes=0-0" },
  });
  return res.status;
}

/**
 * Fetches API pages per folder (100 rows/page, capped) so mobile lists match
 * portal for large mailboxes.
 *
 * Speed (2026-07-28): page 1 of each folder reveals the folder's `total`, so
 * pages 2..N are fetched in PARALLEL instead of the previous serial loop —
 * a large mailbox reload went from (pages × RTT) to ~2 RTTs per folder.
 * `maxPagesPerFolder` caps the depth; VoicemailTab's 15s background poll
 * passes 1 to keep the poll to a single request per folder (the param was
 * previously accepted silently and IGNORED, so every poll did a full resync).
 */
export async function getVoicemails(
  token: string,
  input: { folders?: VoicemailFolder[]; page?: number; maxPagesPerFolder?: number } = {},
): Promise<{ voicemails: Voicemail[]; totals: Record<VoicemailFolder, number>; unreadTotals: Record<VoicemailFolder, number>; scopeMeta?: VoicemailApiScopeMeta }> {
  const folders = input.folders ?? ["inbox", "urgent", "old"];
  const maxPages = Math.max(
    1,
    Math.min(input.maxPagesPerFolder ?? VOICEMAIL_MAX_PAGES_PER_FOLDER, VOICEMAIL_MAX_PAGES_PER_FOLDER),
  );
  let mergedScopeMeta: VoicemailApiScopeMeta | undefined;
  const responses = await Promise.all(
    folders.map(async (folder) => {
      const fetchPage = async (page: number): Promise<{ batch: Voicemail[]; total: number; unread: number }> => {
        const params = new URLSearchParams({ folder, page: String(page) });
        const url = `${API_BASE}/voice/voicemail?${params.toString()}`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const json = await parseJson(res);
        if (!res.ok) throw new Error(json?.error || "VOICEMAIL_FAILED");
        const headerV = res.headers.get("X-Voicemail-Scope-Version");
        const headerM = res.headers.get("X-Scoped-Mailboxes");
        const data = json as VoicemailResponse & VoicemailApiScopeMeta;
        const pageMeta = mergeVoicemailScopeMeta(data, headerV, headerM);
        if (pageMeta.voicemailScopeVersion != null || pageMeta.scopedMailboxesForUser != null) {
          mergedScopeMeta = pageMeta;
        }
        if (typeof __DEV__ !== "undefined" && __DEV__) {
          const batchPrev = data.voicemails ?? [];
          console.log("[VM_LIST]", url, {
            scopeVersion: pageMeta.voicemailScopeVersion ?? headerV,
            scopedMailboxes: pageMeta.scopedMailboxesForUser ?? headerM,
            distinctExt: distinctExtensionsFromVoicemails(batchPrev),
            idsSample: voicemailIdsSample(batchPrev, 5),
          });
        }
        return { batch: data.voicemails ?? [], total: data.total ?? 0, unread: data.unreadTotal ?? 0 };
      };

      const first = await fetchPage(1);
      const merged: Voicemail[] = [...first.batch];
      let total = first.total;
      // unreadTotal is a whole-folder count from the server, identical on every
      // page — take it from page 1 and never accumulate it across pages.
      const unread = first.unread;
      if (
        shouldFetchAnotherVoicemailPage(
          first.batch.length,
          1,
          total,
          maxPages,
          VOICEMAIL_API_PAGE_SIZE,
        )
      ) {
        const totalPages = Math.min(
          maxPages,
          Math.max(1, Math.ceil(total / VOICEMAIL_API_PAGE_SIZE)),
        );
        const rest = await Promise.all(
          Array.from({ length: totalPages - 1 }, (_, i) => fetchPage(i + 2)),
        );
        for (const r of rest) {
          merged.push(...r.batch);
          if (r.total) total = r.total;
        }
      }
      return { folder, data: { voicemails: merged, total, unreadTotal: unread } as VoicemailResponse };
    }),
  );
  const totals = { inbox: 0, urgent: 0, old: 0 } as Record<VoicemailFolder, number>;
  const unreadTotals = { inbox: 0, urgent: 0, old: 0 } as Record<VoicemailFolder, number>;
  const seen = new Set<string>();
  const voicemails: Voicemail[] = [];
  for (const { folder, data } of responses) {
    totals[folder] = data.total ?? 0;
    unreadTotals[folder] = data.unreadTotal ?? 0;
    for (const vm of data.voicemails ?? []) {
      if (seen.has(vm.id)) continue;
      seen.add(vm.id);
      voicemails.push({
        ...vm,
        streamUrl: undefined,
      });
    }
  }
  voicemails.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
  const before = voicemails.length;
  const filtered = filterVoicemailsToScopedMailboxes(voicemails, mergedScopeMeta);
  if (typeof __DEV__ !== "undefined" && __DEV__ && filtered.length < before) {
    console.warn("[VM_SCOPE_FILTER]", {
      stripped: before - filtered.length,
      distinctExtBefore: distinctExtensionsFromVoicemails(voicemails),
      allow: mergedScopeMeta?.scopedMailboxesForUser,
    });
  }
  return { voicemails: filtered, totals, unreadTotals, scopeMeta: mergedScopeMeta };
}

/**
 * Best-effort report of the mobile app's DND state (see sip/dndStore.ts).
 * Consumed by the PBX-side connect-wake DND short-circuit. Callers treat this
 * as fire-and-forget through reportDndWithBoundedRetry — a thrown error here
 * only ends that retry loop, it never reaches call handling.
 */
export async function reportDndStatus(token: string, dnd: boolean): Promise<void> {
  const res = await fetch(`${API_BASE}/mobile/dnd-status`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ dnd }),
  });
  if (!res.ok) throw new Error("DND_STATUS_REPORT_FAILED");
}

export async function markVoicemailListened(token: string, id: string, listened: boolean) {
  const res = await fetch(`${API_BASE}/voice/voicemail/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ listened }),
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "VOICEMAIL_UPDATE_FAILED");
  return json;
}

export async function getTeamDirectory(token: string): Promise<TeamDirectoryMember[]> {
  // IMPORTANT — tenant isolation:
  // We intentionally do NOT send `?global=1`. The Connect API
  // (/voice/pbx/resources/extensions) hard-scopes this response to the JWT's
  // tenantId for every non-SUPER_ADMIN role; the `global=1` flag is only
  // honored when the authenticated user is a SUPER_ADMIN. Omitting it makes
  // the mobile client's intent explicit: ask for the caller's tenant.
  const res = await fetch(`${API_BASE}/voice/pbx/resources/extensions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "TEAM_DIRECTORY_FAILED");
  const rows = Array.isArray(json?.rows) ? json.rows : [];
  return rows
    .map((row: any): TeamDirectoryMember | null => {
      const extension = String(row.extension ?? row.extNumber ?? row.ext_number ?? row.number ?? row.sipExtension ?? "").trim();
      if (!/^\d{2,6}$/.test(extension)) return null;
      const name = String(row.displayName ?? row.display_name ?? row.name ?? row.callerid ?? row.callerId ?? `Extension ${extension}`).trim();
      const lower = name.toLowerCase();
      if (
        lower === "pbx user" ||
        /^pbx user\s+\d+$/.test(lower) ||
        lower.includes("invite lifecycle") ||
        lower.includes("provisioning") ||
        lower.includes("smoke") ||
        lower.includes("system") ||
        lower === "voice user" ||
        /^voice user\s+\d+$/.test(lower)
      ) {
        return null;
      }
      return {
        id: String(row.connectExtensionId ?? row.id ?? extension),
        name,
        extension,
        email: row.email ?? row.assignedUser ?? row.pbxUserEmail ?? null,
        department: row.department ?? row.team ?? null,
        title: row.title ?? row.role ?? null,
        tenantId: row.tenantId ?? row.tenant_id ?? null,
        tenantName: row.tenantName ?? row.tenant_name ?? null,
        presence: "offline",
      };
    })
    .filter(Boolean)
    .sort((a: TeamDirectoryMember, b: TeamDirectoryMember) =>
      a.extension.localeCompare(b.extension, undefined, { numeric: true }),
    ) as TeamDirectoryMember[];
}

export async function getContacts(token: string, query = ""): Promise<ContactsResponse> {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  const qs = params.toString();
  const res = await fetch(`${API_BASE}/contacts${qs ? `?${qs}` : ""}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CONTACTS_FAILED");
  return json as ContactsResponse;
}

export type CreateContactInput = {
  firstName?: string;
  lastName?: string;
  displayName?: string;
  company?: string;
  phones?: Array<{ type?: "mobile" | "office" | "home" | "other"; numberRaw: string; isPrimary?: boolean }>;
  emails?: Array<{ type?: "work" | "personal" | "other"; email: string; isPrimary?: boolean }>;
  notes?: string;
  favorite?: boolean;
};

const CONTACT_CREATE_TIMEOUT_MS = 45_000;

export async function createContact(token: string, input: CreateContactInput): Promise<{ contact: any }> {
  const body = {
    type: "external" as const,
    firstName: input.firstName?.trim() || undefined,
    lastName: input.lastName?.trim() || undefined,
    displayName: input.displayName?.trim() || undefined,
    company: input.company?.trim() || undefined,
    notes: input.notes?.trim() || undefined,
    favorite: input.favorite ?? false,
    active: true,
    phones: (input.phones || [])
      .map((p) => ({
        type: p.type || "mobile",
        numberRaw: String(p.numberRaw ?? "").trim(),
        isPrimary: p.isPrimary,
      }))
      .filter((p) => p.numberRaw.length > 0),
    emails: (input.emails || [])
      .map((e) => ({
        type: e.type || "work",
        email: String(e.email ?? "").trim(),
        isPrimary: e.isPrimary,
      }))
      .filter((e) => e.email.length > 0),
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONTACT_CREATE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/contacts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error("CONTACT_CREATE_TIMEOUT");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const json = await parseJson(res);
  if (!res.ok) {
    const code = typeof json?.error === "string" ? json.error : "CONTACT_CREATE_FAILED";
    throw new Error(code === "CONTACT_CREATE_FAILED" ? `${code}_${res.status}` : code);
  }
  return json as { contact: any };
}

export type ContactImportItemStatus = "created" | "duplicate" | "invalid" | "error";
export type ContactImportBatchResult = {
  summary: { created: number; duplicates: number; invalid: number; failed: number };
  results: Array<{ index: number; status: ContactImportItemStatus; id?: string; error?: string }>;
};

/** Max contacts per POST /contacts/import call (must stay <= server cap of 200). */
export const CONTACT_IMPORT_BATCH_SIZE = 100;
const CONTACT_IMPORT_TIMEOUT_MS = 60_000;

function toContactWriteBody(input: CreateContactInput) {
  return {
    type: "external" as const,
    firstName: input.firstName?.trim() || undefined,
    lastName: input.lastName?.trim() || undefined,
    displayName: input.displayName?.trim() || undefined,
    company: input.company?.trim() || undefined,
    notes: input.notes?.trim() || undefined,
    favorite: input.favorite ?? false,
    active: true,
    phones: (input.phones || [])
      .map((p) => ({ type: p.type || "mobile", numberRaw: String(p.numberRaw ?? "").trim(), isPrimary: p.isPrimary }))
      .filter((p) => p.numberRaw.length > 0),
    emails: (input.emails || [])
      .map((e) => ({ type: e.type || "work", email: String(e.email ?? "").trim(), isPrimary: e.isPrimary }))
      .filter((e) => e.email.length > 0),
  };
}

/**
 * Create up to {@link CONTACT_IMPORT_BATCH_SIZE} contacts in a SINGLE request.
 * The phone-book importer uses this instead of one POST /contacts per contact
 * so a large import is a handful of requests, not thousands — the latter
 * tripped the nginx auto-ban (HTTP 403 storm) mid-import.
 */
export async function importContactsBatch(
  token: string,
  inputs: CreateContactInput[],
): Promise<ContactImportBatchResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONTACT_IMPORT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/contacts/import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ contacts: inputs.map(toContactWriteBody) }),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error("CONTACT_IMPORT_TIMEOUT");
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const json = await parseJson(res);
  if (!res.ok) {
    const code = typeof json?.error === "string" ? json.error : "CONTACT_IMPORT_FAILED";
    throw new Error(code === "CONTACT_IMPORT_FAILED" ? `${code}_${res.status}` : code);
  }
  return json as ContactImportBatchResult;
}

export async function getChatThreads(token: string): Promise<ChatThread[]> {
  const res = await fetch(`${API_BASE}/chat/threads`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CHAT_THREADS_FAILED");
  return Array.isArray(json?.threads) ? (json.threads as ChatThread[]) : [];
}

export async function getMessages(
  token: string,
  threadId: string,
  opts: { before?: string; after?: string; since?: string; limit?: number } = {},
): Promise<ChatMessage[]> {
  const params = new URLSearchParams();
  if (opts.before) params.set("before", opts.before);
  if (opts.after) params.set("after", opts.after);
  if (!opts.after && opts.since) params.set("since", opts.since);
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const res = await fetch(`${API_BASE}/chat/threads/${encodeURIComponent(threadId)}/messages${qs ? `?${qs}` : ""}` , {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CHAT_MESSAGES_FAILED");
  return Array.isArray(json?.messages) ? (json.messages as ChatMessage[]) : [];
}

export async function getChatDirectory(token: string): Promise<ChatDirectoryUser[]> {
  const res = await fetch(`${API_BASE}/chat/directory`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CHAT_DIRECTORY_FAILED");
  return Array.isArray(json?.users) ? (json.users as ChatDirectoryUser[]) : [];
}

export async function getChatDirectoryFull(token: string): Promise<{ users: ChatDirectoryUser[]; extensions?: Array<{ id: string; extNumber: string; displayName: string; ownerUserId?: string | null }> }> {
  const res = await fetch(`${API_BASE}/chat/directory`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CHAT_DIRECTORY_FAILED");
  return {
    users: Array.isArray(json?.users) ? (json.users as ChatDirectoryUser[]) : [],
    extensions: Array.isArray(json?.extensions) ? json.extensions : [],
  };
}

export async function createChatThread(
  token: string,
  input: { type: "dm" | "sms" | "group"; peerUserId?: string; externalPhone?: string; title?: string; peerUserIds?: string[] },
): Promise<{ threadId: string }> {
  const res = await fetch(`${API_BASE}/chat/threads`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CHAT_THREAD_CREATE_FAILED");
  return json as { threadId: string };
}

/** Per-user "delete conversation": hides the thread from this user's list. */
export async function archiveChatThread(token: string, threadId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/chat/threads/${encodeURIComponent(threadId)}/archive`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const json = await parseJson(res);
    throw new Error(json?.error || "CHAT_THREAD_ARCHIVE_FAILED");
  }
}

export type SendChatMessageInput = {
  body?: string;
  type?: Exclude<ChatMessageType, "SYSTEM">;
  replyToMessageId?: string;
  location?: ChatLocation;
  attachments?: PendingChatAttachment[];
};

export async function uploadChatAttachment(
  token: string,
  threadId: string,
  file: { uri: string; name: string; type: string },
): Promise<PendingChatAttachment> {
  const form = new FormData();
  form.append("file", file as any);
  const res = await fetch(`${API_BASE}/chat/threads/${encodeURIComponent(threadId)}/attachments/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.message || json?.error || "CHAT_ATTACHMENT_UPLOAD_FAILED");
  return {
    storageKey: String(json.storageKey),
    mimeType: String(json.mimeType || file.type),
    sizeBytes: Number(json.sizeBytes || 0),
    fileName: String(json.fileName || file.name),
    localUri: file.uri,
    mediaKind: typeof json.mediaKind === "string" ? json.mediaKind : undefined,
    durationMs: typeof json.durationMs === "number" ? json.durationMs : null,
    width: typeof json.width === "number" ? json.width : null,
    height: typeof json.height === "number" ? json.height : null,
  };
}

export async function sendChatMessage(token: string, threadId: string, input: string | SendChatMessageInput): Promise<{ ok: boolean; messageId?: string; deliveryStatus?: string }> {
  const payload = typeof input === "string" ? { body: input } : {
    body: input.body ?? "",
    type: input.type,
    replyToMessageId: input.replyToMessageId,
    location: input.location,
    attachments: input.attachments?.map(({ storageKey, mimeType, sizeBytes, fileName, mediaKind, durationMs, width, height }) => ({
      storageKey,
      mimeType,
      sizeBytes,
      fileName,
      mediaKind,
      durationMs: durationMs ?? undefined,
      width: width ?? undefined,
      height: height ?? undefined,
    })),
  };
  const res = await fetch(`${API_BASE}/chat/threads/${encodeURIComponent(threadId)}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CHAT_SEND_FAILED");
  return json;
}

export async function markChatThreadRead(token: string, threadId: string): Promise<{ ok: boolean; lastReadAt?: string }> {
  const res = await fetch(`${API_BASE}/chat/threads/${encodeURIComponent(threadId)}/read`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CHAT_READ_FAILED");
  return json;
}

export async function setChatTyping(token: string, threadId: string, typing: boolean): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/chat/threads/${encodeURIComponent(threadId)}/typing`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ typing }),
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CHAT_TYPING_FAILED");
  return json;
}

export async function getChatTyping(token: string, threadId: string): Promise<Array<{ userId: string; name: string; typingUntil: string | null }>> {
  const res = await fetch(`${API_BASE}/chat/threads/${encodeURIComponent(threadId)}/typing`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CHAT_TYPING_FETCH_FAILED");
  return Array.isArray(json?.users) ? json.users : [];
}

export async function reactToChatMessage(token: string, threadId: string, messageId: string, emoji: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/chat/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/reactions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ emoji }),
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CHAT_REACTION_FAILED");
  return json;
}

export async function removeChatReaction(token: string, threadId: string, messageId: string, emoji: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/chat/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CHAT_REACTION_DELETE_FAILED");
  return json;
}

export async function deleteChatMessage(token: string, threadId: string, messageId: string, mode: "me" | "everyone"): Promise<{ ok: boolean; mode: string }> {
  const res = await fetch(`${API_BASE}/chat/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}?mode=${encodeURIComponent(mode)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CHAT_DELETE_FAILED");
  return json;
}

export async function registerMobileDevice(token: string, input: {
  platform: "IOS" | "ANDROID";
  expoPushToken: string;
  voipPushToken?: string;
  deviceId?: string;
  appVersion?: string;
  deviceName?: string;
  // Call-wake diagnostics — populated by mobileDeviceRegistrationMetadata so
  // the backend can correlate Samsung S24 vs S25 (or any other device) when
  // triaging "calls don't ring when locked".
  manufacturer?: string;
  model?: string;
  osVersion?: string;
  // Runtime-permission snapshot. Sent on every register so /admin/call-wake-
  // diagnostics can flag devices missing RECORD_AUDIO (answer-then-disconnect
  // bug) or POST_NOTIFICATIONS (no heads-up ringer) without contacting the
  // user.
  permissions?: {
    recordAudio?: boolean;
    notifications?: boolean;
  };
  // Foreground-service keep-alive snapshot from the SipKeepAliveService
  // companion object. Lets the admin diagnostics page tell whether the
  // FGS that holds the WSS socket open is actually running, and (when it
  // is not) which Android FGS rule rejected the start (for the S25 +
  // Android 15 + One UI 7 PHONE_CALL FGS regression).
  keepAlive?: {
    isRunning?: boolean;
    serviceCreatedAtMs?: number;
    serviceDestroyedAtMs?: number;
    lastStartResult?: string;
    lastStartErrorClass?: string;
    lastForegroundResult?: string;
    lastForegroundTypeUsed?: string;
    lastForegroundErrorClass?: string;
    foregroundLandedAtMs?: number;
    process?: string;
    rearmCount?: number;
    batteryOptimizationIgnored?: boolean;
    gateNeeded?: boolean;
    gateReason?: string;
    gateLatchedAtMs?: number;
    gateDropCount?: number;
  };
}) {
  // Android: also report the native FCM registration token so the server can
  // deliver call wakes via direct high-priority FCM (Doze-exempt) instead of
  // the Expo relay. Never blocks or fails registration — falls back to null.
  // iOS: the same call returns the native APNs (alert-environment) device
  // token — reported as apnsAlertToken so the server can deliver user
  // notifications (voicemail / missed call / chat / SMS) via direct APNs,
  // independent of the Expo relay's credential store (2026-07-30). Never
  // blocks registration.
  let nativeFcmToken: string | null = null;
  let apnsAlertToken: string | null = null;
  try {
    // Cap the native-token fetch: on iOS it awaits an APNs registration
    // round-trip that can stall on a bad network — registration itself must
    // never wait on it (the next register call picks the token up).
    const t = await Promise.race([
      ExpoNotifications.getDevicePushTokenAsync(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    const data = typeof (t as { data?: unknown })?.data === "string" ? (t as { data: string }).data : null;
    if (Platform.OS === "android") nativeFcmToken = data;
    if (Platform.OS === "ios") apnsAlertToken = data;
  } catch {
    // fall through with nulls
  }
  const res = await fetch(`${API_BASE}/mobile/devices/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      ...input,
      ...(nativeFcmToken ? { nativeFcmToken } : {}),
      ...(apnsAlertToken ? { apnsAlertToken } : {}),
    })
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "MOBILE_REGISTER_FAILED");
  // Apply per-device remote feature flags from the register response here (the
  // single choke point) so every register call site — push init, retry, wake —
  // mirrors them without needing its own wiring. Fire-and-forget: flag
  // application must never delay or fail device registration.
  void applyServerFeatureFlags((json as { featureFlags?: unknown })?.featureFlags);
  return json;
}

export type MobileDeviceDiagnostics = {
  id: string;
  platform: "IOS" | "ANDROID";
  active: boolean;
  extensionId: string | null;
  deviceId: string | null;
  deviceName: string | null;
  appVersion: string | null;
  manufacturer: string | null;
  model: string | null;
  osVersion: string | null;
  lastSeenAt: string;
  lastPushSentAt: string | null;
  lastPushType: string | null;
  lastPushStatus: string | null;
  lastPushError: string | null;
  permRecordAudio: boolean | null;
  permNotifications: boolean | null;
  permissionsReportedAt: string | null;
  keepAliveSnapshot: {
    isRunning?: boolean;
    serviceCreatedAtMs?: number;
    serviceDestroyedAtMs?: number;
    lastStartResult?: string;
    lastStartErrorClass?: string;
    lastForegroundResult?: string;
    lastForegroundTypeUsed?: string;
    lastForegroundErrorClass?: string;
  } | null;
  keepAliveReportedAt: string | null;
  expoPushTokenTail: string;
  voipPushTokenTail: string | null;
  deactivatedAt: string | null;
};

export async function getMyMobileDevices(token: string): Promise<{ devices: MobileDeviceDiagnostics[] }> {
  const res = await fetch(`${API_BASE}/mobile/devices/me`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` }
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "MOBILE_DEVICES_FETCH_FAILED");
  return json;
}

export async function unregisterMobileDevice(token: string, expoPushToken?: string) {
  const res = await fetch(`${API_BASE}/mobile/devices/unregister`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(expoPushToken ? { expoPushToken } : {})
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "MOBILE_UNREGISTER_FAILED");
  return json;
}

// ─── Push-wake (Option 2) device telemetry ────────────────────────────────
// Each call writes one CallWakeEvent row keyed by pbxCallId on the backend.
// MUST be best-effort: a failure here must NEVER block a real call. The caller
// should `.catch(() => undefined)` every invocation.
export type WakeDeviceStage =
  | "DEVICE_PUSH_RECEIVED"
  | "DEVICE_REGISTER_TRIGGERED"
  | "DEVICE_REGISTER_COMPLETE"
  | "DEVICE_REGISTER_FAILED"
  | "DEVICE_INVITE_RECEIVED"
  | "DEVICE_INVITE_UI_SHOWN"
  | "DEVICE_ANSWER_TAPPED"
  | "DEVICE_DECLINE_TAPPED"
  | "DEVICE_TIMED_OUT";

export async function postWakeEvent(
  token: string,
  body: {
    pbxCallId: string;
    stage: WakeDeviceStage;
    deviceId?: string | null;
    details?: Record<string, unknown> | null;
  },
): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/mobile/wake/event`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Don't throw — wake telemetry must be lossy under failure.
      console.warn(
        "[CALL_WAKE] postWakeEvent non-2xx",
        res.status,
        body.stage,
        body.pbxCallId,
      );
    }
  } catch (err: any) {
    console.warn(
      "[CALL_WAKE] postWakeEvent threw",
      err?.message,
      body.stage,
      body.pbxCallId,
    );
  }
}

export type WakeTimelineEvent = {
  id: string;
  pbxCallId: string;
  stage: string;
  source: string;
  userId: string | null;
  deviceId: string | null;
  extensionId: string | null;
  details: Record<string, unknown> | null;
  latencyMs: number | null;
  occurredAt: string;
};

export async function getWakeTimeline(
  token: string,
  opts: { pbxCallId?: string; limit?: number } = {},
): Promise<{ events: WakeTimelineEvent[] }> {
  const params = new URLSearchParams();
  if (opts.pbxCallId) params.set("pbxCallId", opts.pbxCallId);
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const url = `${API_BASE}/mobile/wake/timeline${qs ? "?" + qs : ""}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "WAKE_TIMELINE_FETCH_FAILED");
  return json;
}

export async function getPendingInvites(token: string) {
  const res = await fetch(`${API_BASE}/mobile/call-invites/pending`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CALL_INVITE_FETCH_FAILED");
  return Array.isArray(json) ? json : [];
}

// ---- Multi-call -----------------------------------------------------------
// Invoked by CallSessionManager. These calls record stack-bookkeeping state
// on the server — the actual SIP hold/unhold happens client-side via JsSIP.

export async function getActiveAndHeldInvites(
  token: string,
): Promise<{ active: any | null; held: any[] }> {
  const res = await fetch(`${API_BASE}/mobile/call-invites/active`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CALL_INVITE_ACTIVE_FAILED");
  return {
    active: json?.active ?? null,
    held: Array.isArray(json?.held) ? json.held : [],
  };
}

export async function holdCallInvite(token: string, inviteId: string) {
  const res = await fetch(`${API_BASE}/mobile/call-invites/${inviteId}/hold`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CALL_INVITE_HOLD_FAILED");
  return json;
}

export async function resumeCallInvite(token: string, inviteId: string) {
  const res = await fetch(`${API_BASE}/mobile/call-invites/${inviteId}/resume`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CALL_INVITE_RESUME_FAILED");
  return json;
}

export async function respondInvite(token: string, inviteId: string, action: "ACCEPT" | "DECLINE", deviceId?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  if (deviceId) headers["x-mobile-device-id"] = deviceId;
  const res = await fetch(`${API_BASE}/mobile/call-invites/${inviteId}/respond`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action })
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CALL_INVITE_RESPOND_FAILED");
  return json;
}

export async function getMobileInviteAnswerStatus(token: string, inviteId: string) {
  const res = await fetch(`${API_BASE}/mobile/call-invites/${inviteId}/answer-status`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CALL_INVITE_ANSWER_STATUS_FAILED");
  return json as {
    inviteId: string;
    linkedId: string | null;
    inviteStatus: string;
    pbxAnswered: boolean;
    answeredAt: string | null;
    // Authoritative "a real extension answered" signal from telephony. Unlike
    // pbxAnswered (true for inbound-trunk early media / ringback the whole time
    // a ring group rings), these are set ONLY when a real PJSIP extension leg
    // picks up. Optional for backward-compat with telephony builds that predate
    // the field. See apps/telephony status route.
    extensionAnswered?: boolean;
    extensionAnsweredAt?: string | null;
    // True when the PBX diverted the call to voicemail.
    reachedVoicemail?: boolean;
    telephonyState: string | null;
    activeChannels: string[];
  };
}



export async function redeemMobileProvisioningToken(token: string, input: { token: string; deviceInfo?: any; apiBaseUrl?: string }) {
  const base = (input.apiBaseUrl || API_BASE).replace(/\/$/, "");
  const res = await fetch(`${base}/voice/mobile-provisioning/redeem`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "MOBILE_PROVISIONING_REDEEM_FAILED");
  return json as { sipPassword: string; provisioning: any };
}

/** Unauthenticated — exchanges a QR-code token for a session JWT + SIP provisioning bundle.
 *  Used by the mobile app on first launch (no existing auth token).
 */
export async function exchangeQrToken(
  qrToken: string,
  deviceInfo?: { platform?: "IOS" | "ANDROID"; deviceName?: string; expoPushToken?: string; voipPushToken?: string },
  apiBaseUrl?: string
): Promise<{ sessionToken: string; sipPassword: string; provisioning: any; deviceId: string | null; user: { id: string; email: string; role: string } }> {
  const base = (apiBaseUrl || API_BASE).replace(/\/$/, "");
  const res = await fetch(`${base}/auth/mobile-qr-exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: qrToken, deviceInfo })
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "QR_EXCHANGE_FAILED");
  if (!json?.sessionToken) throw new Error("QR_EXCHANGE_NO_TOKEN");
  return json;
}

export async function startVoiceDiagSession(token: string, input: {
  sessionId?: string;
  platform: "WEB" | "IOS" | "ANDROID";
  deviceId?: string;
  appVersion?: string;
  sipWsUrl?: string;
  sipDomain?: string;
  iceHasTurn?: boolean;
  lastRegState?: string;
  lastCallState?: string;
  lastErrorCode?: string;
}) {
  const res = await fetch(`${API_BASE}/voice/diag/session/start`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "VOICE_DIAG_SESSION_START_FAILED");
  return json;
}

export async function heartbeatVoiceDiagSession(token: string, input: {
  sessionId: string;
  lastRegState?: string;
  lastCallState?: string;
  lastErrorCode?: string;
  iceHasTurn?: boolean;
  sipWsUrl?: string;
  sipDomain?: string;
}) {
  const res = await fetch(`${API_BASE}/voice/diag/session/heartbeat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "VOICE_DIAG_HEARTBEAT_FAILED");
  return json;
}

export async function postVoiceDiagEvent(token: string, input: {
  sessionId: string;
  type:
    | "SESSION_START"
    | "SESSION_HEARTBEAT"
    | "SIP_REGISTER"
    | "SIP_UNREGISTER"
    | "WS_CONNECTED"
    | "WS_DISCONNECTED"
    | "WS_RECONNECT"
    | "ICE_GATHERING"
    | "ICE_SELECTED_PAIR"
    | "TURN_TEST_RESULT"
    | "INCOMING_INVITE"
    | "ANSWER_TAPPED"
    | "CALL_CONNECTED"
    | "CALL_ENDED"
    | "ERROR"
    | "MEDIA_TEST_RUN"
    | "PUSH_RECEIVED"
    | "UI_SHOWN"
    | "INCOMING_PUSH_RECEIVED"
    | "CALLKEEP_UI_SHOWN"
    | "CALLKEEP_ANSWER_TAPPED"
    | "APP_FOREGROUNDED_FROM_CALL"
    | "INVITE_RESTORED"
    | "INVITE_RESTORE_FAILED"
    | "SIP_ANSWER_REQUESTED"
    | "SIP_ANSWER_SENT"
    | "SIP_ANSWER_CONFIRMED"
    | "SIP_ANSWER_FAILED"
    | "PBX_CALL_ANSWERED"
    | "PBX_STILL_RINGING_AFTER_ANSWER"
    | "ANSWER_DESYNC_DETECTED"
    | "UI_SWITCHED_TO_CONNECTING"
    | "UI_SWITCHED_TO_ACTIVE"
    // Phase 7c cold-start answer-deferral lifecycle
    | "ANSWER_DEFERRED_AWAITING_SIP"
    | "ANSWER_DEFERRED_EXECUTED"
    | "ANSWER_DEFERRED_TIMEOUT"
    | "ANSWER_DEFERRED_STALE_CALL";
  payload?: any;
}) {
  const res = await fetch(`${API_BASE}/voice/diag/event`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "VOICE_DIAG_EVENT_FAILED");
  return json;
}


export async function startMediaTest(token: string, input?: { platform?: "WEB" | "IOS" | "ANDROID" }) {
  const res = await fetch(`${API_BASE}/voice/media-test/start`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input || {})
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "MEDIA_TEST_START_FAILED");
  return json as { ok: boolean; runId: string; token: string; expiresAt: string; platform: "WEB" | "IOS" | "ANDROID" };
}

export async function reportMediaTest(token: string, input: {
  token: string;
  hasRelay: boolean;
  iceSelectedPairType: "host" | "srflx" | "relay" | "unknown";
  wsOk: boolean;
  sipRegisterOk: boolean;
  rtpCandidatePresent?: boolean;
  durationMs?: number;
  platform?: "WEB" | "IOS" | "ANDROID";
  errorCode?: string;
}) {
  const res = await fetch(`${API_BASE}/voice/media-test/report`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "MEDIA_TEST_REPORT_FAILED");
  return json;
}

export async function getMediaTestStatus(token: string) {
  const res = await fetch(`${API_BASE}/voice/media-test/status`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "MEDIA_TEST_STATUS_FAILED");
  return json;
}

export async function postCallQualityReport(token: string, report: Record<string, unknown>) {
  const res = await fetch(`${API_BASE}/voice/diag/call-quality-report`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(report),
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CQR_FAILED");
  return json;
}

export async function postWebrtcCallDebug(token: string, payload: Record<string, unknown>) {
  const res = await fetch(`${API_BASE}/voice/diag/webrtc-sdp-debug`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.ok;
}

export async function postCallQualityPing(token: string, snapshot: Record<string, unknown>) {
  const res = await fetch(`${API_BASE}/voice/diag/call-quality-ping`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(snapshot),
  });
  // Non-fatal — don't throw on error
  return res.ok;
}

export async function clearCallQualityPing(token: string) {
  await fetch(`${API_BASE}/voice/diag/call-quality-ping/clear`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  }).catch(() => {});
}

/**
 * Initiate a voicemail greeting Call-to-Record from the mobile app.
 *
 * Pass `callerSipEndpoint` (e.g. "T21_101_2") so the PBX helper originates to
 * this device's endpoint instead of the stored extension default. The API
 * validates the endpoint against the authenticated user's tenant + extension;
 * an invalid value is silently ignored and the stored default is used instead.
 */
export async function callVoicemailGreetingRecord(
  token: string,
  input: {
    greetingType?: "unavailable" | "busy" | "temporary" | "name";
    /** Mobile's own SIP endpoint (e.g. from provisioning bundle sipUsername). */
    callerSipEndpoint?: string;
  } = {},
): Promise<{ ok: boolean; jobId: string; state: string; [key: string]: unknown }> {
  const res = await fetch(`${API_BASE}/voicemail/greeting/record-call`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      greetingType: input.greetingType ?? "unavailable",
      ...(input.callerSipEndpoint ? { callerSipEndpoint: input.callerSipEndpoint } : {}),
    }),
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "VM_GREETING_RECORD_CALL_FAILED");
  return json;
}

export async function uploadCallFlightSession(token: string, body: {
  session: Record<string, unknown>;
  stats: Record<string, unknown>;
}) {
  const res = await fetch(`${API_BASE}/mobile/flight-recorder/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "FLIGHT_RECORDER_UPLOAD_FAILED");
  return json;
}

