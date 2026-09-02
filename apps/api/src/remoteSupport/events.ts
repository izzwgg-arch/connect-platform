/**
 * The chronological record of a support session: system events and chat, in one
 * ordering (Phases 21 and 22).
 *
 * ⛔⛔ THE RULE THIS FILE EXISTS TO ENFORCE — WHAT MUST NEVER BE WRITTEN HERE:
 *
 *   - raw keystrokes            (non-negotiable #12)
 *   - clipboard contents        (Phase 22, explicitly)
 *   - screen contents           (Phase 22, explicitly)
 *   - passwords or credentials  (Phase 22, explicitly)
 *
 * Input is recorded as a COUNT and never as content. Clipboard is recorded as
 * "text was shared, N characters" and never as the text. That is not a policy
 * written in a comment somewhere else and hoped for — `recordEvent` cannot
 * express those things, because the only free-text field it accepts is a chat
 * message a human deliberately typed, and every system event's body is composed
 * here from a fixed vocabulary.
 */
import { db } from "@connect/db";

/** Who caused the thing being recorded. */
export type EventActorRole = "ADMIN" | "CLIENT" | "SYSTEM";

/**
 * The complete vocabulary of system events.
 *
 * ⛔ A CLOSED SET, ON PURPOSE. A caller cannot invent an event code, which means
 * a caller cannot smuggle content into one. Adding a code is a deliberate edit
 * here, next to the sentence it renders as.
 */
export const SYSTEM_EVENT_CODES = [
  "requested",
  "consented",
  "declined",
  "connected",
  "capability_requested",
  "capability_granted",
  "capability_refused",
  "control_used",
  "clipboard_shared",
  "file_sent",
  "file_received",
  "screen_changed",
  "diagnostic_started",
  "diagnostic_finished",
  "ai_suggested",
  "quality_degraded",
  "call_started",
  "call_ended",
  "ended",
  "revoked",
  "killed",
  // ── Remote Desktop (2026-09-02) ──────────────────────────────────────────
  // The connecting side reached one of its OWN computers, or a computer whose
  // owner issued a Connect ID password. ⛔ None of these carries the username,
  // the password, or the Connect ID password — a login is recorded as a verdict.
  "desktop_connected",
  "machine_accepted",
  "login_ok",
  "login_failed",
  "login_locked",
  "share_used",
  "sound_routed",
  "sound_stopped",
  "mic_routed",
  "mic_stopped",
] as const;
export type SystemEventCode = (typeof SYSTEM_EVENT_CODES)[number];

export function isSystemEventCode(v: unknown): v is SystemEventCode {
  return typeof v === "string" && (SYSTEM_EVENT_CODES as readonly string[]).includes(v);
}

/** The longest a chat message may be. Generous for a sentence, useless as storage. */
export const MAX_CHAT_CHARS = 2_000;

/**
 * Strip anything that would let a message forge the look of a system event, or
 * break the renderer.
 *
 * ⛔ Control characters and bidirectional overrides are removed rather than
 * escaped. A right-to-left override in a chat line can make "ended session" read
 * as something else entirely in the transcript — the same class the Coworker's
 * trustBoundary already defends against, applied here because this transcript is
 * read by a human deciding whether something went wrong.
 */
export function sanitizeChatBody(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  const stripped = Array.from(s)
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      if (c === 0x0a || c === 0x09) return true; // newline and tab are legitimate
      if (c < 0x20 || c === 0x7f) return false; // other C0 and DEL
      if (c >= 0x80 && c <= 0x9f) return false; // C1
      if (c >= 0x202a && c <= 0x202e) return false; // bidi embedding/override
      if (c >= 0x2066 && c <= 0x2069) return false; // bidi isolates
      if (c === 0x200b || c === 0x200c || c === 0x200d || c === 0xfeff) return false; // zero-width
      return true;
    })
    .join("");
  return stripped.trim().slice(0, MAX_CHAT_CHARS);
}

/**
 * The sentence a system event renders as.
 *
 * ⛔ Composed HERE from the code and a small, typed set of facts — never from
 * caller-supplied prose. That is what makes "a system event cannot contain
 * screen contents" a structural property rather than a promise.
 */
export function renderSystemEvent(code: SystemEventCode, facts: SystemEventFacts = {}): string {
  const who = facts.actorName?.trim() || "Loopcom support";
  const caps = (facts.capabilities || []).filter(Boolean).join(", ");

  switch (code) {
    case "requested":
      return `${who} asked to connect.`;
    case "consented":
      return caps ? `Access allowed: ${caps}.` : "Access allowed.";
    case "declined":
      return "The request was declined.";
    case "connected":
      return "The connection is live.";
    case "capability_requested":
      return caps ? `${who} asked for ${caps}.` : `${who} asked for more access.`;
    case "capability_granted":
      return caps ? `${caps} allowed.` : "More access allowed.";
    case "capability_refused":
      return caps ? `${caps} declined.` : "The extra access was declined.";
    case "control_used":
      // ⛔ A COUNT. Never what was typed.
      return `${who} used the mouse and keyboard (${facts.count ?? 0} actions).`;
    case "clipboard_shared":
      // ⛔ A LENGTH. Never the text.
      return `Clipboard text shared (${facts.count ?? 0} characters).`;
    case "file_sent":
      return `${who} sent a file: ${facts.fileName || "unnamed"} (${formatBytes(facts.bytes)}).`;
    case "file_received":
      return `A file was sent to ${who}: ${facts.fileName || "unnamed"} (${formatBytes(facts.bytes)}).`;
    case "screen_changed":
      return `Now showing ${facts.screenName || "another screen"}.`;
    case "diagnostic_started":
      return `Diagnostics started: ${facts.detail || "checks running"}.`;
    case "diagnostic_finished":
      return `Diagnostics finished: ${facts.detail || "complete"}.`;
    case "ai_suggested":
      return `The Coworker suggested: ${facts.detail || "a next step"}.`;
    case "quality_degraded":
      return facts.detail
        ? `Picture quality reduced — ${facts.detail}.`
        : "Picture quality reduced to protect the connection.";
    case "call_started":
      return "A phone call started — the screen was throttled to protect call quality.";
    case "call_ended":
      return "The phone call ended — full picture quality restored.";
    case "ended":
      return facts.detail ? `Session ended (${facts.detail}).` : "Session ended.";
    case "revoked":
      return "Access was withdrawn by a Loopcom administrator.";
    case "killed":
      return "Remote support was switched off platform-wide.";
    case "desktop_connected":
      return facts.detail ? `${who} connected from ${facts.detail}.` : `${who} connected.`;
    case "machine_accepted":
      return facts.screenName ? `${facts.screenName} accepted the connection.` : "The computer accepted the connection.";
    case "login_ok":
      return "The computer's username and password were accepted.";
    case "login_failed":
      // ⛔ A COUNT of tries left. Never the username that was tried.
      return typeof facts.count === "number"
        ? `Wrong username or password (${facts.count} ${facts.count === 1 ? "try" : "tries"} left).`
        : "Wrong username or password.";
    case "login_locked":
      return "Too many wrong passwords — that computer is locked for 15 minutes.";
    case "share_used":
      return `${who} connected with a Connect ID password.`;
    case "sound_routed":
      return facts.detail ? `Sound is playing on ${facts.detail}.` : "Sound is playing on the connecting computer.";
    case "sound_stopped":
      return "Sound is playing on the remote computer again.";
    case "mic_routed":
      return facts.detail ? `${facts.detail}'s microphone is in use on this computer.` : "The connecting computer's microphone is in use here.";
    case "mic_stopped":
      return "This computer is using its own microphone again.";
    default: {
      // Exhaustiveness: adding a code without a sentence is a compile error.
      const never: never = code;
      return String(never);
    }
  }
}

export type SystemEventFacts = {
  actorName?: string | null;
  capabilities?: readonly string[];
  /** An input count or a character count. Never content. */
  count?: number;
  fileName?: string | null;
  bytes?: number | null;
  screenName?: string | null;
  /** Short, composed by the caller from its OWN closed vocabulary. */
  detail?: string | null;
};

function formatBytes(n: number | null | undefined): string {
  const b = typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
  if (b < 1024) return `${Math.round(b)} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A filename, made safe to show and safe to write (Phase 12).
 *
 * ⛔ Traversal, absolute paths, UNC paths, device names, alternate data streams
 * and trailing dots are all removed — the same fences the Coworker's `paths.ts`
 * applies, restated here because a filename arriving over a support session is
 * the same untrusted string arriving by a different door.
 */
export const WINDOWS_RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

export function sanitizeFileName(raw: unknown): { ok: true; name: string } | { ok: false; reason: string } {
  let s = typeof raw === "string" ? raw : "";

  // Take the last path segment on EITHER separator, so "a/b\..\c.txt" cannot
  // survive as a path. Done before anything else.
  s = s.split(/[\\/]/).pop() ?? "";
  s = s.trim();

  if (!s) return { ok: false, reason: "empty_filename" };

  // Control characters, and the characters Windows forbids outright.
  if (/[\u0000-\u001f\u007f<>:"|?*]/.test(s)) return { ok: false, reason: "illegal_characters" };

  // Alternate data streams: "notes.txt:evil.exe".
  if (s.includes(":")) return { ok: false, reason: "illegal_characters" };

  // "." and ".." never survive the split above as anything useful.
  if (s === "." || s === "..") return { ok: false, reason: "traversal" };

  // Trailing dots and spaces are silently stripped by Windows, which turns
  // "safe.txt." into "safe.txt" AFTER any check that looked at the raw string.
  const trimmed = s.replace(/[. ]+$/, "");
  if (!trimmed) return { ok: false, reason: "empty_filename" };

  const base = (trimmed.split(".")[0] || "").toUpperCase();
  if (WINDOWS_RESERVED.has(base)) return { ok: false, reason: "reserved_name" };

  if (trimmed.length > 180) return { ok: false, reason: "name_too_long" };

  return { ok: true, name: trimmed };
}

/* ─────────────────────────── writing ─────────────────────────────── */

export type RecordEventInput = {
  sessionId: string;
  tenantId: string;
  actorRole: EventActorRole;
  actorUserId?: string | null;
} & (
  | { kind: "system"; code: SystemEventCode; facts?: SystemEventFacts; meta?: Record<string, unknown> }
  | { kind: "chat"; body: string }
);

/**
 * ⛔ NEVER THROWS. The transcript is valuable and it is not load-bearing: losing
 * a line must never fail the action it was describing, and it certainly must
 * never fail an `end`. Failures are logged, loudly, and dropped.
 */
export async function recordEvent(input: RecordEventInput): Promise<void> {
  try {
    if (input.kind === "chat") {
      const body = sanitizeChatBody(input.body);
      if (!body) return; // An empty message is not an event.
      await db.remoteSupportEvent.create({
        data: {
          sessionId: input.sessionId,
          tenantId: input.tenantId,
          kind: "chat",
          actorRole: input.actorRole,
          actorUserId: input.actorUserId ?? null,
          code: "message",
          body,
        },
      });
      return;
    }

    await db.remoteSupportEvent.create({
      data: {
        sessionId: input.sessionId,
        tenantId: input.tenantId,
        kind: "system",
        actorRole: input.actorRole,
        actorUserId: input.actorUserId ?? null,
        code: input.code,
        body: renderSystemEvent(input.code, input.facts),
        meta: (input.meta ?? null) as any,
      },
    });
  } catch (err) {
    console.error("[REMOTE_SUPPORT] failed to record session event", {
      sessionId: input.sessionId,
      kind: input.kind,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
