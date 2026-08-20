/**
 * LiveKit plumbing for Loopcom Meetings — config, access tokens, and the
 * handful of RoomService (moderation) calls the host controls need.
 *
 * ⛔ NO LiveKit SDK on purpose. A LiveKit access token is a plain HS256 JWT
 * (iss = API key, sub = participant identity, `video` grant object), and the
 * RoomService admin API is plain JSON-over-POST (Twirp). Hand-rolling both on
 * `node:crypto` + `fetch` keeps apps/api's dependency list untouched — an
 * undeclared/undeployed dependency has killed this container before (the
 * `undici` incident, guarded by dependencyHygiene.test.ts).
 *
 * ⛔ Config is read at CALL time, never at module load — same rule as
 * androidApkInviteUrl.ts, and it is what makes this testable. When any of the
 * three values is missing or blank the feature answers "not configured" in
 * plain English; the api must boot fine on a machine with no LiveKit at all.
 */
import { createHmac, randomInt } from "node:crypto";

export type LiveKitConfig = {
  /** Internal HTTP base the api uses for RoomService calls, e.g. http://livekit:7880 */
  url: string;
  apiKey: string;
  apiSecret: string;
};

/**
 * ⛔ `""` is falsy but `" "` is not — trim BEFORE the emptiness check (the
 * chat-signing-secret lesson: a variable "set" to blank must read as unset).
 */
export function getLiveKitConfig(env: NodeJS.ProcessEnv = process.env): LiveKitConfig | null {
  const url = String(env.LIVEKIT_URL || "").trim().replace(/\/+$/, "");
  const apiKey = String(env.LIVEKIT_API_KEY || "").trim();
  const apiSecret = String(env.LIVEKIT_API_SECRET || "").trim();
  if (!url || !apiKey || !apiSecret) return null;
  return { url, apiKey, apiSecret };
}

export type LiveKitVideoGrant = {
  room: string;
  roomJoin: boolean;
  canPublish: boolean;
  canSubscribe: boolean;
  canPublishData: boolean;
  /** Moderation powers (used by the api's own RoomService calls; participant
   *  tokens never carry it — moderation goes through our host routes so it is
   *  permission-checked and auditable server-side). */
  roomAdmin?: boolean;
  /** ⛔ Required for RoomService.DeleteRoom — roomAdmin alone answers
   *  401 "permissions denied" there (seen live 2026-08-20). Only the api's own
   *  admin token ever carries it. */
  roomCreate?: boolean;
};

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Mint a LiveKit JWT. Shape verified against LiveKit's published token format:
 * HS256, iss = API key, sub = identity, `video` = grant object, `name` = the
 * display name the SDK shows other participants.
 */
export function buildLiveKitJwt(params: {
  config: Pick<LiveKitConfig, "apiKey" | "apiSecret">;
  identity: string;
  name?: string;
  ttlSeconds: number;
  grant: LiveKitVideoGrant;
  metadata?: string;
  nowMs?: number;
}): string {
  const now = Math.floor((params.nowMs ?? Date.now()) / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload: Record<string, unknown> = {
    iss: params.config.apiKey,
    sub: params.identity,
    // A little clock-skew grace on nbf so a just-minted token is never "not yet valid".
    nbf: now - 10,
    exp: now + Math.max(60, Math.floor(params.ttlSeconds)),
    video: params.grant,
  };
  if (params.name) payload.name = params.name;
  if (params.metadata) payload.metadata = params.metadata;
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = createHmac("sha256", params.config.apiSecret).update(signingInput).digest();
  return `${signingInput}.${b64url(sig)}`;
}

/** Room name derives from the meeting row id — stable and collision-free. */
export function liveKitRoomForMeeting(meetingId: string): string {
  return `meet-${meetingId}`;
}

/**
 * Meeting codes: three groups from an alphabet with no confusables
 * (no i/l/o/0/1 — these get read over the phone). ~46 bits of entropy, and the
 * DB unique index catches the astronomically unlikely collision (caller retries).
 */
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function buildMeetingCode(): string {
  const pick = (n: number) =>
    Array.from({ length: n }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  return `${pick(3)}-${pick(4)}-${pick(3)}`;
}

export function isValidMeetingCode(code: string): boolean {
  return /^[a-z2-9]{3}-[a-z2-9]{4}-[a-z2-9]{3}$/.test(code);
}

/** Guest identities are random — two guests named "Sam" must never collide. */
export function buildGuestIdentity(): string {
  const pick = (n: number) =>
    Array.from({ length: n }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  return `guest-${pick(10)}`;
}

/**
 * Display names are shown to everyone in the room — bound the length, strip
 * control characters, and refuse emptiness so a blank tile can't happen.
 */
export function sanitizeDisplayName(raw: unknown): string | null {
  const s = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return s.length >= 1 ? s : null;
}

/**
 * RoomService (Twirp) call. Only the moderation verbs the host routes need.
 * Bounded with AbortSignal.timeout — fine here because the response is a small
 * JSON body, never a stream piped to a client (the recording-stream lesson does
 * not apply).
 */
export async function roomServiceRequest(
  config: LiveKitConfig,
  method: "MutePublishedTrack" | "RemoveParticipant" | "DeleteRoom" | "UpdateRoomMetadata",
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; body: string }> {
  const room = String(body.room || "");
  const token = buildLiveKitJwt({
    config,
    identity: "connect-api",
    ttlSeconds: 120,
    grant: { room, roomJoin: false, canPublish: false, canSubscribe: false, canPublishData: false, roomAdmin: true, roomCreate: true },
  });
  const res = await fetchImpl(`${config.url}/twirp/livekit.RoomService/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, body: text };
}
