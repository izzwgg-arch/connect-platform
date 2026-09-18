/**
 * Yealink's own MAC-removal ticket door — releasing a phone whose RPS record still lists
 * it under ANOTHER organization (round 23, 2026-09-17: automatic release for RPS-held
 * phones; Yealink caps 20 removed MACs and 5 mismatch errors per account per 24 hours).
 *
 * Read live out of Yealink's own ticket app bundle (`ticket.yealink.com`, a Vue SPA):
 *   - `GET  /ticket-common/getMacRemoveInfo`     — usage: how many MACs removed / how many
 *     mismatch errors so far in the rolling 24h window. No captcha anywhere in the bundle.
 *   - `POST /ticket-common/addMacRemoveTicket`   — body `{"toDel":{"<MAC>":"<SN>"}}`. Success
 *     hands back a `ticketId` — Yealink STAFF then process the release over days; this is a
 *     ticket filing, never an instant unlock. `status === 2` (with `lockMacMap`) means "The
 *     submitted MAC address and SN do not match" — Yealink counts that against the 5-error cap,
 *     so a mismatch is NEVER retried automatically (`fileMacRemoval` makes exactly one attempt).
 *   - Auth is a session COOKIE from Yealink's UCenter SSO (`withCredentials`, same-site). Izzy
 *     signs in once at ticket.yealink.com, copies the request Cookie header out of DevTools,
 *     and pastes it into the portal card — the raw header is the only credential this module
 *     ever holds.
 *
 * ⛔⛔ Storage mirrors gdmsCredentials.ts exactly: one encrypted row (AgentSecret, AES-256-GCM
 * under CREDENTIALS_MASTER_KEY), write-only — `describeYealinkTicketSession` returns hints
 * (configured / savedAt) and NEVER the cookie value; nothing here logs it.
 *
 * ⛔⛔ THE ORIGIN IS HARDCODED. `ticket.yealink.com` is a literal, never read from input,
 * config, or a redirect target — `assertYealinkTicketOrigin` exists so a future edit that
 * tries to make the host configurable fails loudly instead of quietly widening what this
 * module is allowed to talk to.
 *
 * ⛔ Local caps sit strictly UNDER Yealink's own ceiling (20 removed / 5 errors): we refuse
 * at 15 removed / 4 errors so our own automation is never the thing that exhausts Izzy's own
 * manual allowance too. A creating write here is sent once, with a 15s timeout, and never
 * retried — the same "a timed-out write may have landed" discipline `gdmsClient.ts` uses.
 */
import { db as defaultDb } from "@connect/db";
import { normalizeMac } from "@connect/shared";

// ⛔ Duplicated in miniature from yealinkRedirectClaim.ts's own `serialTailOf` rather
// than imported: that file is about to import `maybeFileYealinkRelease` FROM this one
// (its conflict branch fires the release), so an import back would be a runtime
// circular value-import — exactly the trap that file's own header comment already
// warns callers away from for `deskPhoneRoutes.ts`.
function serialTailOf(serial: string): string {
  return serial ? `…${serial.slice(-4)}` : "";
}

export type YealinkTicketSession = {
  /** The raw `Cookie:` request header string from a signed-in ticket.yealink.com session. */
  cookie: string;
  note?: string | null;
};

const SECRET_KEY = "yealink_ticket_session";
const HOST = "ticket.yealink.com";
const ORIGIN = `https://${HOST}`;
const CACHE_MS = 60_000;

/** Strictly under Yealink's own 20/5 ceiling — see the header comment. */
const REMOVED_FLOOR = 15;
const ERROR_FLOOR = 4;

let cached: { value: YealinkTicketSession | null; at: number } | null = null;

export function clearYealinkTicketSessionCache(): void {
  cached = null;
}

export function validateYealinkTicketSession(input: {
  cookie?: unknown; note?: unknown;
}): { ok: true; value: YealinkTicketSession } | { ok: false; message: string } {
  const cookie = String(input.cookie ?? "").trim();
  if (!cookie) return { ok: false, message: "Paste the Cookie request header from a signed-in ticket.yealink.com session." };
  if (cookie.length > 8000) return { ok: false, message: "That cookie value is too long — copy just the Cookie request header, not the whole request." };
  if (!/[A-Za-z0-9_.\-]+\s*=/.test(cookie)) return { ok: false, message: "That doesn't look like a cookie header (expected name=value pairs)." };
  const noteRaw = input.note;
  const note = noteRaw === undefined || noteRaw === null ? null : String(noteRaw).trim().slice(0, 300) || null;
  return { ok: true, value: { cookie, note } };
}

export async function resolveYealinkTicketSession(db: any = defaultDb): Promise<YealinkTicketSession | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  let value: YealinkTicketSession | null = null;
  try {
    const sec = await import("@connect/security");
    if (sec.hasCredentialsMasterKey()) {
      const row = await db.agentSecret.findUnique({ where: { key: SECRET_KEY } });
      if (row?.valueEnc) {
        const decrypted = sec.decryptJson<YealinkTicketSession>(row.valueEnc);
        const check = validateYealinkTicketSession(decrypted ?? {});
        if (check.ok) value = check.value;
      }
    }
  } catch {
    // A missing master key, absent row or decrypt failure all mean "not configured".
    value = null;
  }
  cached = { value, at: Date.now() };
  return value;
}

export async function storeYealinkTicketSession(db: any, value: YealinkTicketSession | null, updatedBy: string): Promise<void> {
  const sec = await import("@connect/security");
  if (!sec.hasCredentialsMasterKey()) throw new Error("credentials_master_key_missing");
  if (!value) {
    await db.agentSecret.deleteMany({ where: { key: SECRET_KEY } });
  } else {
    const valueEnc = sec.encryptJson(value);
    await db.agentSecret.upsert({
      where: { key: SECRET_KEY },
      update: { valueEnc, updatedBy },
      create: { key: SECRET_KEY, valueEnc, updatedBy },
    });
  }
  clearYealinkTicketSessionCache();
}

export async function describeYealinkTicketSession(db: any = defaultDb): Promise<{
  configured: boolean;
  savedAt: string | null;
  note: string | null;
}> {
  const value = await resolveYealinkTicketSession(db);
  if (!value) return { configured: false, savedAt: null, note: null };
  let savedAt: string | null = null;
  try {
    const row = await db.agentSecret.findUnique({ where: { key: SECRET_KEY } });
    if (row?.updatedAt) savedAt = new Date(row.updatedAt).toISOString();
  } catch { /* cosmetic label only */ }
  return { configured: true, savedAt, note: value.note ?? null };
}

/* ── the ticket-portal client ─────────────────────────────────────────────── */

export type MacRemovalUsage = { removedCount: number; errorCount: number };

export type MacRemovalFailureCode =
  | "not_configured"
  | "invalid_input"
  | "yealink_cap_reached"
  | "yealink_session_expired"
  | "mac_serial_mismatch"
  | "yealink_unavailable";

export type MacRemovalUsageResult =
  | { ok: true; usage: MacRemovalUsage }
  | { ok: false; code: "yealink_session_expired" | "yealink_unavailable" };

export type MacRemovalResult =
  | { ok: true; ticketId: string }
  | { ok: false; code: MacRemovalFailureCode };

export type MacRemovalFetch = typeof fetch;

/** ⛔⛔ The one host this module will ever contact. Never widened by input or config. */
export function assertYealinkTicketOrigin(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("yealink_ticket_url_invalid");
  }
  if (parsed.protocol !== "https:" || parsed.host !== HOST) {
    throw new Error("yealink_ticket_host_invalid");
  }
}

async function ticketRequest(
  path: string,
  session: YealinkTicketSession,
  request: MacRemovalFetch,
  init: { method: "GET" | "POST"; body?: unknown; timeoutMs?: number },
): Promise<{ status: number; json: any | null; redirected: boolean }> {
  // The path always comes from a literal below — this assertion is defense-in-depth against
  // a future edit that starts building the path from something other than a literal.
  const url = `${ORIGIN}${path}`;
  assertYealinkTicketOrigin(url);
  const res = await request(url, {
    method: init.method,
    headers: {
      Cookie: session.cookie,
      Accept: "application/json",
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    // Yealink's SSO answers an expired session with a redirect to its login page — caught
    // as `redirected`, never silently followed into a page we'd misread as a success.
    redirect: "manual",
    signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
  } as any);
  const status = (res as any).status ?? 0;
  const type = (res as any).type;
  if (type === "opaqueredirect" || (status >= 300 && status < 400)) {
    return { status, json: null, redirected: true };
  }
  let json: any = null;
  try { json = await (res as any).json(); } catch { json = null; }
  return { status, json, redirected: false };
}

/** Read-only: how much of Yealink's own 20/5 allowance this account has used. */
export async function fetchMacRemovalUsage(
  session: YealinkTicketSession,
  request: MacRemovalFetch = fetch,
): Promise<MacRemovalUsageResult> {
  try {
    const { status, json, redirected } = await ticketRequest(
      "/ticket-common/getMacRemoveInfo", session, request, { method: "GET", timeoutMs: 15_000 },
    );
    if (redirected || status === 401 || status === 403) return { ok: false, code: "yealink_session_expired" };
    if (status < 200 || status >= 300 || !json) return { ok: false, code: "yealink_unavailable" };
    const data = json?.data ?? json;
    const removedCount = Number(data?.removedCount ?? data?.removeCount ?? 0);
    const errorCount = Number(data?.errorCount ?? 0);
    return {
      ok: true,
      usage: {
        removedCount: Number.isFinite(removedCount) ? removedCount : 0,
        errorCount: Number.isFinite(errorCount) ? errorCount : 0,
      },
    };
  } catch {
    return { ok: false, code: "yealink_unavailable" };
  }
}

/**
 * File a MAC-removal ticket. ⛔ Exactly one attempt at the write: a mismatch burns one of
 * Yealink's five error slots, so this never retries a `mac_serial_mismatch` (or anything
 * else — a timed-out write may have landed, and the caller is expected to re-check via
 * `fetchMacRemovalUsage` / the dedupe record, never by calling this again blind).
 */
export async function fileMacRemoval(
  input: { mac: string; serial: string },
  deps: { session?: YealinkTicketSession | null; db?: any; request?: MacRemovalFetch } = {},
): Promise<MacRemovalResult> {
  const mac = normalizeMac(input.mac);
  const serial = String(input.serial || "").trim();
  if (!mac || serial.length < 6) return { ok: false, code: "invalid_input" };

  const session = deps.session !== undefined ? deps.session : await resolveYealinkTicketSession(deps.db);
  if (!session) return { ok: false, code: "not_configured" };
  const request = deps.request ?? fetch;

  const usage = await fetchMacRemovalUsage(session, request);
  if (!usage.ok) return usage;
  if (usage.usage.removedCount >= REMOVED_FLOOR || usage.usage.errorCount >= ERROR_FLOOR) {
    return { ok: false, code: "yealink_cap_reached" };
  }

  try {
    const { status, json, redirected } = await ticketRequest(
      "/ticket-common/addMacRemoveTicket", session, request,
      { method: "POST", body: { toDel: { [mac]: serial } }, timeoutMs: 15_000 },
    );
    if (redirected || status === 401 || status === 403) return { ok: false, code: "yealink_session_expired" };
    if (!json) return { ok: false, code: "yealink_unavailable" };
    // status==2 + lockMacMap = "The submitted MAC address and SN do not match." Counted
    // against the 5-error cap at Yealink — never retried here.
    if (json.status === 2 || json.lockMacMap) return { ok: false, code: "mac_serial_mismatch" };
    const ticketId = json?.data?.ticketId ?? json?.ticketId ?? json?.data?.id;
    if (status < 200 || status >= 300 || !ticketId) return { ok: false, code: "yealink_unavailable" };
    return { ok: true, ticketId: String(ticketId) };
  } catch {
    return { ok: false, code: "yealink_unavailable" };
  }
}

/* ── the hook: fired from yealinkRedirectClaim.ts's conflict branch ──────── */

type AuditFn = (p: {
  tenantId: string; action: string; entityType: string; entityId: string;
  actorUserId?: string; metadata?: Record<string, unknown> | null;
}) => Promise<void>;

export type ReleaseTicketRecord = { ticketId: string; filedAt: string; serialTail: string };

/** Guards a single process against firing the same MAC twice while a request is in flight.
 * Cross-process dedupe (a restart, a second api instance) is the durable `options.releaseTicket`
 * check inside `run()` below — this set only stops the "called twice concurrently" race. */
const inFlight = new Set<string>();

/**
 * Best-effort: file Yealink's own MAC-removal ticket for a phone whose office-wizard RPS
 * claim just came back `conflict`. ⛔⛔ NEVER throws into `yealinkRedirectClaim.ts` — that
 * caller's own claim already happened either way, and a bug in here must never undo it.
 */
export async function maybeFileYealinkRelease(
  db: any,
  audit: AuditFn,
  input: { tenantId: string; phoneId: string; mac: string; serial: string },
): Promise<void> {
  try {
    await run(db, audit, input);
  } catch {
    // Defense in depth: `run()` already handles every failure itself.
  }
}

async function run(
  db: any,
  audit: AuditFn,
  input: { tenantId: string; phoneId: string; mac: string; serial: string },
): Promise<void> {
  const mac = normalizeMac(input.mac);
  if (!mac) return;
  if (inFlight.has(mac)) {
    await auditSafe(audit, input, mac, "DESK_PHONE_RPS_RELEASE_SKIPPED", { reason: "in_flight" });
    return;
  }
  inFlight.add(mac);
  try {
    const row = await db.managedDeskPhone?.findUnique?.({ where: { macAddress: mac } });
    if (!row) {
      await auditSafe(audit, input, mac, "DESK_PHONE_RPS_RELEASE_SKIPPED", { reason: "no_managed_row" });
      return;
    }
    // ⛔⛔ Dedupe FIRST, before ever touching the network: once a release ticket has been
    // filed for this MAC — at ANY age — it is never filed again. Filing twice would spend a
    // second slot of Yealink's own 20/day allowance for a ticket already sitting in their
    // queue, and a filing already IN the queue is not made to arrive faster by a second one.
    const options: Record<string, unknown> = row.options && typeof row.options === "object" ? { ...row.options } : {};
    const existing = options.releaseTicket as ReleaseTicketRecord | undefined;
    if (existing?.ticketId) {
      await auditSafe(audit, input, mac, "DESK_PHONE_RPS_RELEASE_SKIPPED", { reason: "already_filed", ticketId: existing.ticketId });
      return;
    }

    const serial = String(input.serial || "").trim();
    if (serial.length < 6) {
      await auditSafe(audit, input, mac, "DESK_PHONE_RPS_RELEASE_SKIPPED", { reason: "no_serial" });
      return;
    }

    const result = await fileMacRemoval({ mac, serial }, { db });
    if (!result.ok) {
      await auditSafe(audit, input, mac, "DESK_PHONE_RPS_RELEASE_FAILED", { code: result.code });
      return;
    }

    const record: ReleaseTicketRecord = {
      ticketId: result.ticketId,
      filedAt: new Date().toISOString(),
      serialTail: serialTailOf(serial),
    };
    try {
      await db.managedDeskPhone.update({ where: { id: row.id }, data: { options: { ...options, releaseTicket: record } } });
    } catch { /* best-effort — the ticket was still filed at Yealink */ }
    await appendReleaseNote(db, input.phoneId, result.ticketId);
    await auditSafe(audit, input, mac, "DESK_PHONE_RPS_RELEASE_FILED", { ticketId: result.ticketId, serialTail: record.serialTail });
  } finally {
    inFlight.delete(mac);
  }
}

async function auditSafe(
  audit: AuditFn, input: { tenantId: string; phoneId: string }, mac: string, action: string, metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await audit({
      tenantId: input.tenantId, action, entityType: "DeskPhoneSetupPhone", entityId: input.phoneId,
      metadata: { mac, ...metadata },
    });
  } catch { /* the filing (or skip) already happened; a lost audit line must not undo it */ }
}

/**
 * ⛔ Same re-read discipline as `writeOutcome` in yealinkRedirectClaim.ts (its round-22b
 * comment): read the row FRESH right before writing, never trust a snapshot taken before
 * the (slow) ticket round trip, and touch ONLY `technicalNote` — `customerNote` is the halt
 * ladder's own field and is never written here.
 */
async function appendReleaseNote(db: any, phoneId: string, ticketId: string): Promise<void> {
  try {
    const fresh = await db.deskPhoneSetupPhone?.findUnique?.({ where: { id: phoneId }, select: { technicalNote: true } });
    if (!fresh) return;
    const suffix = `— release ticket ${ticketId} filed ${new Date().toISOString().slice(0, 10)}`;
    const technicalNote = fresh.technicalNote ? `${fresh.technicalNote} ${suffix}` : suffix;
    await db.deskPhoneSetupPhone.update({ where: { id: phoneId }, data: { technicalNote } });
  } catch { /* best-effort */ }
}
