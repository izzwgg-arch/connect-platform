/**
 * Remote Desktop — every decision about which computer a person may reach, how
 * that computer is proven to be itself, and what a Connect ID password lets a
 * holder do. Pure functions, exactly like `remoteSupport/policy.ts`, and for the
 * same reason: these are the rules that must be readable and exhaustively
 * testable without a database, a socket or a browser.
 *
 * ⛔⛔ THIS IS NOT REMOTE SUPPORT WITH THE CONSENT DIALOG REMOVED.
 *
 * Remote SUPPORT binds a session to a PERSON who is present and answers a
 * prompt; its policy refuses standing consent by design. Remote DESKTOP binds a
 * session to a MACHINE that may have nobody at it. So three things that support
 * never needed are load-bearing here:
 *
 *  1. MACHINE IDENTITY. A computer proves it is itself with a key its own app
 *     minted on first enrollment (`x-machine-key`); the server keeps only the
 *     hash. Without this a Connect ID means "whoever claims this name", which is
 *     nothing.
 *
 *  2. STANDING ACCESS, TWO KINDS, NEVER MIXED. Your OWN computer is opened with
 *     a username and password set AT that machine and verified THERE, over the
 *     peer connection — this server never sees them, and only learns the verdict.
 *     Someone ELSE's computer is opened with a Connect ID + a password its owner
 *     issued, verified HERE, with an expiry and a scope. A share password never
 *     opens the owner's login, and the owner's login never satisfies a share.
 *
 *  3. THE OWNER IS ALWAYS IN CHARGE. The tray switch, the login, the shares and
 *     the Stop button all belong to the computer's owner. Nothing in here lets a
 *     connecting person widen what they were given.
 *
 * Everything else — the kill switch, revocations, heartbeats, the transcript,
 * the media budget — is the support engine's and is reused unchanged.
 */
import { createHash, randomInt } from "node:crypto";
import { HEARTBEAT_STALE_MS, MAX_SESSION_MS } from "../remoteSupport/policy";

/* ─────────────────────────── identity ─────────────────────────────── */

/** A machine that has not been seen for this long is offline. */
export const MACHINE_ONLINE_MS = 40_000;

/** Nine digits, never starting with zero, so "482 913 057" is always nine wide. */
export const CONNECT_ID_LENGTH = 9;

export function mintConnectId(rand: (max: number) => number = randomInt): string {
  let out = String(1 + rand(9));
  while (out.length < CONNECT_ID_LENGTH) out += String(rand(10));
  return out;
}

export function isConnectId(v: unknown): v is string {
  return typeof v === "string" && /^[1-9]\d{8}$/.test(v);
}

/** "482913057" → "482 913 057". Anything else is returned unchanged. */
export function formatConnectId(v: string): string {
  return isConnectId(v) ? `${v.slice(0, 3)} ${v.slice(3, 6)} ${v.slice(6)}` : v;
}

/** Digits only, so a person may type it with spaces, dashes or dots. */
export function normalizeConnectId(v: unknown): string | null {
  const digits = String(v ?? "").replace(/\D/g, "");
  return isConnectId(digits) ? digits : null;
}

/**
 * The machine key never touches the database in the clear. Hashed with the
 * deviceId so a key lifted from one install's settings cannot be replayed as a
 * different install.
 */
export function hashMachineKey(deviceId: string, machineKey: string): string {
  return createHash("sha256").update(`${deviceId}\u0000${machineKey}`).digest("hex");
}

export function isPlausibleMachineKey(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
}

export function isPlausibleDeviceId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9._:-]{8,120}$/.test(v);
}

export type MachineFacts = {
  id: string;
  tenantId: string;
  ownerUserId: string;
  deviceId: string;
  machineKeyHash: string;
  unattendedEnabled: boolean;
  hasAccessLogin: boolean;
  locked: boolean;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  shareFailCount: number;
  shareLockedUntil: Date | null;
};

export function machineOnline(m: { lastSeenAt: Date | null }, now: Date): boolean {
  return Boolean(m.lastSeenAt) && now.getTime() - (m.lastSeenAt as Date).getTime() <= MACHINE_ONLINE_MS;
}

export type Decision = { ok: true } | { ok: false; reason: string };
const deny = (reason: string): Decision => ({ ok: false, reason });
const allow: Decision = { ok: true };

/**
 * A machine registering, re-registering, or being adopted by a new signed-in
 * person.
 *
 * ⛔ THE KEY DECIDES, NEVER THE NAME. Two installs may both call themselves
 * "Office PC"; only the one holding the minted key is that row. A mismatch is
 * refused outright — it is either a stolen deviceId or a reinstall, and a
 * reinstall enrolls afresh under its new deviceId rather than inheriting.
 */
export function decideMachineRegister(input: {
  existing: Pick<MachineFacts, "machineKeyHash" | "revokedAt"> | null;
  presentedKeyHash: string;
}): Decision {
  if (!input.existing) return allow;
  if (input.existing.machineKeyHash !== input.presentedKeyHash) return deny("machine_key_mismatch");
  if (input.existing.revokedAt) return deny("machine_removed");
  return allow;
}

/**
 * Does this call come from the machine a session belongs to?
 *
 * ⛔ A constant-time comparison is not needed here: both sides are hashes of
 * high-entropy keys, so a timing oracle recovers nothing usable. What matters is
 * that the comparison is against the STORED hash of THIS machine, never against
 * "any machine in the tenant".
 */
export function machineKeyMatches(machine: Pick<MachineFacts, "machineKeyHash">, presentedKeyHash: string | null): boolean {
  return Boolean(presentedKeyHash) && machine.machineKeyHash === presentedKeyHash;
}

/* ─────────────────────── the connecting person ────────────────────── */

export type ActorFacts = {
  userId: string;
  tenantId: string;
  isSuperAdmin: boolean;
  canUseRemoteDesktop: boolean;
  canConnectById: boolean;
  canShareOwnComputer: boolean;
  /** True only for the Loopcom Windows app (read off its user agent). */
  fromDesktopApp: boolean;
};

/**
 * May this person reach one of THEIR OWN computers?
 *
 * Ownership is the whole rule: the row's ownerUserId is the person who last
 * signed in on that machine, and nobody else — not a colleague, not a tenant
 * admin, not a super admin — may open it this way. Anyone else needs a Connect
 * ID password the owner issued.
 *
 * ⛔ The login gate at the machine is deliberately NOT modelled here. It runs
 * on the machine, over the peer connection, after this decision says the
 * session may exist at all.
 */
export function decideOwnConnect(input: { actor: ActorFacts; machine: MachineFacts; now: Date }): Decision {
  const { actor, machine } = input;
  if (!actor.canUseRemoteDesktop) return deny("missing_permission");
  if (machine.revokedAt) return deny("machine_removed");
  if (machine.ownerUserId !== actor.userId) return deny("not_your_computer");
  if (!machine.unattendedEnabled) return deny("unattended_off");
  if (!machine.hasAccessLogin) return deny("no_access_login");
  if (!machineOnline(machine, input.now)) return deny("machine_offline");
  return allow;
}

/** Only the owner manages a computer: rename, remove, issue or revoke passwords. */
export function decideManageMachine(input: { actor: ActorFacts; machine: MachineFacts }): Decision {
  if (input.machine.revokedAt) return deny("machine_removed");
  if (input.machine.ownerUserId !== input.actor.userId) return deny("not_your_computer");
  return allow;
}

export function decideShareCreate(input: { actor: ActorFacts; machine: MachineFacts }): Decision {
  if (!input.actor.canShareOwnComputer) return deny("missing_share_permission");
  return decideManageMachine(input);
}

/* ─────────────────────── Connect ID passwords ─────────────────────── */

/**
 * The alphabet a share password is drawn from: no 0/O/1/l/I, because it is read
 * out loud and typed on another machine. 8 characters ≈ 42 bits, behind a
 * 5-tries-then-lock gate, which is more than enough for a secret that also
 * requires a signed-in Loopcom app and the right Connect ID.
 */
const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function mintSharePassword(rand: (max: number) => number = randomInt): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += PASSWORD_ALPHABET[rand(PASSWORD_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Hashed WITH the share id, so an identical password on two shares hashes differently. */
export function hashSharePassword(shareId: string, password: string): string {
  return createHash("sha256").update(`${shareId}\u0000${normalizeSharePassword(password)}`).digest("hex");
}

/**
 * People type the dash or leave it out, and read the letters over the phone —
 * so case, spaces and dashes never decide a match. The alphabet has no
 * confusable letters and the lockout bounds guessing.
 */
export function normalizeSharePassword(v: unknown): string {
  return String(v ?? "").replace(/[\s-]/g, "").toLowerCase();
}

export type ShareExpiry = "once" | "24h" | "standing";
export type ShareScope = "company" | "anyone";

export function isShareExpiry(v: unknown): v is ShareExpiry {
  return v === "once" || v === "24h" || v === "standing";
}
export function isShareScope(v: unknown): v is ShareScope {
  return v === "company" || v === "anyone";
}

export const SHARE_ONCE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * What a chosen expiry becomes on the row. "Once" still carries a 24-hour
 * ceiling — a one-time password nobody ever used must not sit armed forever.
 */
export function shareExpiryFor(expiry: ShareExpiry, now: Date): { oneTime: boolean; expiresAt: Date | null } {
  if (expiry === "standing") return { oneTime: false, expiresAt: null };
  if (expiry === "once") return { oneTime: true, expiresAt: new Date(now.getTime() + SHARE_ONCE_TTL_MS) };
  return { oneTime: false, expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) };
}

export type ShareFacts = {
  id: string;
  machineId: string;
  tenantId: string;
  passwordHash: string;
  scope: string;
  oneTime: boolean;
  expiresAt: Date | null;
  usedCount: number;
  revokedAt: Date | null;
  allowControl: boolean;
  allowSound: boolean;
  allowMic: boolean;
  allowClipboard: boolean;
};

export function shareIsLive(share: ShareFacts, now: Date): boolean {
  if (share.revokedAt) return false;
  if (share.expiresAt && now.getTime() > share.expiresAt.getTime()) return false;
  if (share.oneTime && share.usedCount > 0) return false;
  return true;
}

/** Guessing passwords against a Connect ID. */
export const SHARE_MAX_FAILURES = 5;
export const SHARE_LOCKOUT_MS = 15 * 60 * 1000;

export function shareLockedOut(machine: Pick<MachineFacts, "shareLockedUntil">, now: Date): boolean {
  return Boolean(machine.shareLockedUntil) && now.getTime() < (machine.shareLockedUntil as Date).getTime();
}

/** The next failure state after a wrong password. */
export function nextShareFailure(machine: Pick<MachineFacts, "shareFailCount">, now: Date): { shareFailCount: number; shareLockedUntil: Date | null } {
  const count = machine.shareFailCount + 1;
  if (count >= SHARE_MAX_FAILURES) return { shareFailCount: 0, shareLockedUntil: new Date(now.getTime() + SHARE_LOCKOUT_MS) };
  return { shareFailCount: count, shareLockedUntil: null };
}

/**
 * Connecting to someone else's computer.
 *
 * ⛔⛔ EVERY MISMATCH IS THE SAME ANSWER: `invalid_id_or_password`. Whether the
 * Connect ID exists, whether the machine is in another company, whether a share
 * is expired, revoked, already used or simply wrong — the caller learns one
 * thing, that the pair did not open anything. Distinguishing those would make
 * this route an oracle for which nine-digit ids are real computers.
 *
 * Only facts about the CALLER (no permission, not the desktop app, locked out
 * by their own guessing) are reported specifically, because those are things
 * they already know about themselves.
 */
export function decideConnectById(input: {
  actor: ActorFacts;
  machine: MachineFacts | null;
  /** Live shares on that machine whose hash matched the typed password. */
  matchedShare: ShareFacts | null;
  now: Date;
}): Decision {
  const { actor, machine, matchedShare, now } = input;
  if (!actor.canConnectById) return deny("missing_connect_permission");
  if (!actor.fromDesktopApp) return deny("desktop_app_required");
  if (!machine || machine.revokedAt) return deny("invalid_id_or_password");
  if (shareLockedOut(machine, now)) return deny("locked_out");
  if (!matchedShare || !shareIsLive(matchedShare, now)) return deny("invalid_id_or_password");
  if (matchedShare.scope !== "anyone" && machine.tenantId !== actor.tenantId) return deny("invalid_id_or_password");
  if (!machine.unattendedEnabled) return deny("machine_not_accepting");
  if (!machineOnline(machine, now)) return deny("machine_offline");
  return allow;
}

/* ─────────────────────────── capabilities ─────────────────────────── */

export const DESKTOP_CAPABILITIES = ["control", "sound", "mic", "clipboard"] as const;
export type DesktopCapability = (typeof DESKTOP_CAPABILITIES)[number];

export function isDesktopCapability(v: unknown): v is DesktopCapability {
  return typeof v === "string" && (DESKTOP_CAPABILITIES as readonly string[]).includes(v);
}

/**
 * What a session is granted, from what the connecting person asked for and
 * what the door allows.
 *
 * Your own computer allows everything you ask for. A share allows only what its
 * owner ticked. `view` is always present; nothing is granted that was not asked
 * for, so the connecting person can turn a capability OFF for themselves by not
 * requesting it.
 */
export function resolveDesktopGrant(input: {
  requested: readonly string[];
  allowed: { control: boolean; sound: boolean; mic: boolean; clipboard: boolean };
}): string[] {
  const asked = new Set(input.requested.filter(isDesktopCapability));
  const out: string[] = ["view"];
  for (const cap of DESKTOP_CAPABILITIES) {
    if (asked.has(cap) && input.allowed[cap]) out.push(cap);
  }
  return out;
}

export const OWN_MACHINE_ALLOWS = { control: true, sound: true, mic: true, clipboard: true } as const;

export function shareAllows(share: ShareFacts): { control: boolean; sound: boolean; mic: boolean; clipboard: boolean } {
  return { control: share.allowControl, sound: share.allowSound, mic: share.allowMic, clipboard: share.allowClipboard };
}

/* ────────────────────────── participation ─────────────────────────── */

export type DesktopSessionFacts = {
  id: string;
  tenantId: string;
  kind: string;
  status: "REQUESTED" | "CONSENTED" | "ACTIVE" | "ENDED" | "DECLINED" | "EXPIRED";
  machineId: string | null;
  requestedByUserId: string;
  targetUserId: string;
  clientAuthenticated: boolean;
  capabilitiesGranted: readonly string[];
  expiresAt: Date;
  startedAt: Date | null;
  lastSeenAdminAt: Date | null;
  lastSeenClientAt: Date | null;
};

export type DesktopRole = "VIEWER" | "MACHINE";

const TERMINAL = new Set(["ENDED", "DECLINED", "EXPIRED"]);

/**
 * Which side of a desktop session is calling?
 *
 * ⛔ THE MACHINE IS IDENTIFIED BY ITS KEY, NEVER BY ITS USER. On your own
 * computer both ends are signed in as the SAME person, so the support engine's
 * "target user = customer, requester = technician" split cannot tell them
 * apart. A call carrying the machine key that hashes to this session's machine
 * is the machine; a call without one from the person who asked is the viewer;
 * anybody else is nobody.
 */
export function decideDesktopParticipation(input: {
  session: DesktopSessionFacts;
  machine: Pick<MachineFacts, "id" | "machineKeyHash"> | null;
  actorUserId: string;
  presentedKeyHash: string | null;
  now: Date;
}): { ok: true; role: DesktopRole } | { ok: false; reason: string } {
  const { session, machine, actorUserId, presentedKeyHash, now } = input;
  if (session.kind !== "desktop") return { ok: false, reason: "not_a_desktop_session" };
  if (TERMINAL.has(session.status)) return { ok: false, reason: "session_over" };

  const lapse = desktopLapseReason(session, now);
  if (lapse) return { ok: false, reason: lapse };

  if (presentedKeyHash) {
    if (machine && machine.id === session.machineId && machineKeyMatches(machine, presentedKeyHash)) {
      return { ok: true, role: "MACHINE" };
    }
    return { ok: false, reason: "not_a_participant" };
  }
  if (actorUserId === session.requestedByUserId) return { ok: true, role: "VIEWER" };
  return { ok: false, reason: "not_a_participant" };
}

/**
 * The support engine's lapse rules, restated for the desktop shape. Same
 * numbers, same "absent means not here yet" grace (the bug that once killed
 * half of all support sessions), one difference: a machine that never accepts
 * an own-computer request in time reads as `machine_did_not_answer`, which is a
 * fact the connecting person can act on (walk over to it).
 */
export function desktopLapseReason(session: DesktopSessionFacts, now: Date): string | null {
  if (TERMINAL.has(session.status)) return null;
  if (session.status === "REQUESTED") {
    return now.getTime() > session.expiresAt.getTime() ? "machine_did_not_answer" : null;
  }
  if (session.startedAt && now.getTime() - session.startedAt.getTime() > MAX_SESSION_MS) return "max_duration";
  if (session.status === "ACTIVE") {
    const sinceStart = session.startedAt ? now.getTime() - session.startedAt.getTime() : Number.POSITIVE_INFINITY;
    const silent = (lastSeen: Date | null) =>
      lastSeen ? now.getTime() - lastSeen.getTime() > HEARTBEAT_STALE_MS : sinceStart > HEARTBEAT_STALE_MS;
    if (silent(session.lastSeenClientAt)) return "machine_disconnected";
    if (silent(session.lastSeenAdminAt)) return "viewer_disconnected";
  }
  return null;
}

/**
 * May the viewer drive the mouse and keyboard right now?
 *
 * Control needs the grant AND, for an own-computer session, the login to have
 * succeeded. A share session is authenticated by its password and starts true.
 */
export function decideDesktopControl(input: { session: DesktopSessionFacts; role: DesktopRole }): Decision {
  if (input.role !== "VIEWER") return deny("only_viewer_may_control");
  if (input.session.status !== "ACTIVE" && input.session.status !== "CONSENTED") return deny("session_not_active");
  if (!input.session.clientAuthenticated) return deny("not_signed_in_to_computer");
  if (!input.session.capabilitiesGranted.includes("control")) return deny("control_not_granted");
  return allow;
}

/** A request the machine has not answered dies quickly. */
export const DESKTOP_REQUEST_TTL_MS = 45_000;

/** Login attempts over the peer connection, as reported by the machine. */
export const LOGIN_MAX_FAILURES = 5;

/* ────────────────────────────── words ─────────────────────────────── */

export function explainDesktopReason(reason: string): string {
  const map: Record<string, string> = {
    missing_permission: "You do not have permission to use Remote Desktop.",
    missing_connect_permission: "You are not allowed to connect to other people's computers.",
    missing_share_permission: "You are not allowed to hand out access to this computer.",
    desktop_app_required: "Connecting by ID only works from the Loopcom app. Open Loopcom on this computer to connect.",
    machine_removed: "That computer was removed from Remote Desktop.",
    not_your_computer: "That computer is not one of yours.",
    unattended_off: "Remote Desktop is switched off on that computer. Turn it on from its tray icon.",
    no_access_login: "That computer has no username and password set yet. Set them from its tray icon.",
    machine_offline: "That computer is offline. Loopcom must be running and signed in on it.",
    machine_not_accepting: "That computer is not accepting connections right now.",
    invalid_id_or_password: "That Connect ID and password did not open anything. Check both and try again.",
    locked_out: "Too many wrong passwords for that Connect ID. Try again in 15 minutes.",
    machine_key_mismatch: "This installation is not the one registered under that computer. Remove the old computer first, then switch Remote Desktop on again here.",
    machine_did_not_answer: "The computer did not pick up. Loopcom may have just closed on it.",
    machine_disconnected: "The computer disconnected.",
    viewer_disconnected: "Your connection dropped.",
    max_duration: "The session reached its four-hour limit and was closed.",
    session_over: "This session has already finished.",
    not_a_participant: "You are not part of this session.",
    not_a_desktop_session: "That is not a Remote Desktop session.",
    not_signed_in_to_computer: "Sign in to the computer first.",
    control_not_granted: "You can see this computer, but not control it.",
    session_not_active: "The connection is not live yet.",
    only_viewer_may_control: "Only the connecting side can control.",
    already_ended: "This session has already finished.",
  };
  return map[reason] || "That is not allowed right now.";
}
