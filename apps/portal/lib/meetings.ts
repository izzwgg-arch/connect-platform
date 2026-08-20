/**
 * Loopcom Meetings — the pure helpers behind the /meet/<code> page and the
 * Meetings screen. No React, no LiveKit import: everything here is testable
 * with node:test alone.
 *
 * ⛔ TWO-HOSTNAME RULE: every URL built here derives from the window the person
 * is already on (`window.location`), never a hardcoded hostname — a meeting
 * link minted on app.loopcom.net must say app.loopcom.net, and the LiveKit
 * WebSocket must ride the same origin so it works on filtered internet the
 * same way the softphone's /sip proxy does.
 */

/** The nginx location (on BOTH vhosts) proxying to LiveKit's signal endpoint. */
export const MEET_WS_PATH = "/meetws";

export const MEET_NAME_STORAGE_KEY = "cc-meet-name";

export type LocationLike = { protocol: string; host: string; origin?: string };

/** wss://<current host>/meetws — the LiveKit client appends its own /rtc path. */
export function meetingWsUrl(loc: LocationLike): string {
  const scheme = loc.protocol === "http:" ? "ws" : "wss";
  return `${scheme}://${loc.host}${MEET_WS_PATH}`;
}

/** The link a person shares. Origin-derived, never hardcoded. */
export function meetingLink(code: string, loc: LocationLike): string {
  const origin = loc.origin || `${loc.protocol}//${loc.host}`;
  return `${origin}/meet/${code}`;
}

// ── In-meeting data protocol (chat + raised hands) ──────────────────────────
// Rides LiveKit's data channel between the participants; the server never
// stores it — meeting chat clears when the meeting ends, on purpose.

export type MeetChatMessage = { t: "chat"; text: string; name: string; ts: number };
export type MeetHandMessage = { t: "hand"; up: boolean; name: string; ts: number };
export type MeetDataMessage = MeetChatMessage | MeetHandMessage;

export function encodeMeetData(msg: MeetDataMessage): Uint8Array<ArrayBuffer> {
  // TS 5.9 types TextEncoder's result as Uint8Array<ArrayBufferLike>; the
  // runtime value is always backed by a plain ArrayBuffer, and LiveKit's
  // publishData demands the narrower type.
  return new TextEncoder().encode(JSON.stringify(msg)) as Uint8Array<ArrayBuffer>;
}

/**
 * ⛔ Never throws — a malformed payload from any participant must be dropped,
 * not crash the room for everyone else.
 */
export function decodeMeetData(raw: Uint8Array | ArrayBuffer): MeetDataMessage | null {
  try {
    const text = new TextDecoder().decode(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.t === "chat" && typeof parsed.text === "string" && typeof parsed.name === "string") {
      const text2 = String(parsed.text).slice(0, 2000).trim();
      if (!text2) return null;
      return { t: "chat", text: text2, name: String(parsed.name).slice(0, 60), ts: Number(parsed.ts) || Date.now() };
    }
    if (parsed.t === "hand" && typeof parsed.up === "boolean" && typeof parsed.name === "string") {
      return { t: "hand", up: parsed.up, name: String(parsed.name).slice(0, 60), ts: Number(parsed.ts) || Date.now() };
    }
    return null;
  } catch {
    return null;
  }
}

export type RaisedHand = { identity: string; name: string; ts: number };

/** First hand up answers first — the host reads this order in the People panel. */
export function orderRaisedHands(hands: Map<string, { name: string; ts: number }>): RaisedHand[] {
  return Array.from(hands.entries())
    .map(([identity, h]) => ({ identity, name: h.name, ts: h.ts }))
    .sort((a, b) => a.ts - b.ts || a.identity.localeCompare(b.identity));
}

// ── Join API shapes ─────────────────────────────────────────────────────────

export type MeetingInfo = { exists: boolean; title?: string; locked?: boolean; ended?: boolean };

export type MeetingJoinGrant = {
  token: string;
  room: string;
  identity: string;
  isHost: boolean;
  wsPath: string;
  title: string;
};

export type MeetingSummary = {
  id: string;
  code: string;
  title: string;
  locked: boolean;
  createdAt: string;
  endedAt: string | null;
  joinPath: string;
};

/**
 * Plain-English text for the join page's refusals. The server already sends a
 * `message`; these cover the cases where the body never arrived (network) —
 * ⛔ read via `.body`, never `.payload` (that field has never existed).
 */
export function joinErrorText(errorCode: string | null | undefined): string {
  switch (errorCode) {
    case "meeting_ended":
      return "This meeting has ended.";
    case "meeting_locked":
      return "The host has locked this meeting to new participants.";
    case "meeting_not_found":
      return "This meeting link is not valid. Check the link and try again.";
    case "meetings_not_configured":
      return "Video meetings are not available right now.";
    case "name_required":
      return "Type your name so people know who joined.";
    default:
      return "Could not join the meeting. Check your connection and try again.";
  }
}
