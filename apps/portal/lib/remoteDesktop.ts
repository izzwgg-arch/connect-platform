/**
 * Remote Desktop — the pure rules both portal sides share: how a Connect ID is
 * shown and read, when a computer counts as online, and the exact shape of every
 * message that crosses the control channel between the connecting side and the
 * remote computer.
 *
 * ⛔ THE CONTROL CHANNEL IS UNTRUSTED IN BOTH DIRECTIONS. Either end can be a
 * tampered client, so every frame is parsed into a closed shape here before a
 * single field is acted on. The parsers return null for anything unexpected and
 * never throw — a malformed frame is dropped, never a crash in the app that is
 * showing someone's screen.
 */

export const MACHINE_ONLINE_MS = 40_000;

export function formatConnectId(v: string | null | undefined): string {
  const s = String(v ?? "");
  return /^\d{9}$/.test(s) ? `${s.slice(0, 3)} ${s.slice(3, 6)} ${s.slice(6)}` : s;
}

/** Nine digits, however they were typed. */
export function parseConnectId(input: string): string | null {
  const digits = String(input ?? "").replace(/\D/g, "");
  return /^[1-9]\d{8}$/.test(digits) ? digits : null;
}

/** Live formatting while typing: "482913057" → "482 913 057", capped at 9 digits. */
export function typedConnectId(input: string): string {
  const digits = String(input ?? "").replace(/\D/g, "").slice(0, 9);
  return [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9)].filter(Boolean).join(" ");
}

export function isMachineOnline(lastSeenAt: string | null | undefined, now = Date.now()): boolean {
  if (!lastSeenAt) return false;
  const t = new Date(lastSeenAt).getTime();
  return Number.isFinite(t) && now - t <= MACHINE_ONLINE_MS;
}

export type MachineView = {
  id: string;
  name: string;
  connectId: string;
  osLabel: string | null;
  monitors: number;
  unattendedEnabled: boolean;
  hasAccessLogin: boolean;
  locked: boolean;
  lastSeenAt: string | null;
  thisComputer: boolean;
  activeShares: number;
  standingShares: number;
};

/**
 * The words on a computer's card. One sentence per state, so a card never
 * offers a Connect button that will fail — the Warehouse-laptop case in the
 * mockups.
 */
export function describeMachineAccess(m: MachineView, now = Date.now()): { pill: "online" | "offline" | "warn" | "you"; status: string; access: string; canConnect: boolean } {
  const online = isMachineOnline(m.lastSeenAt, now);
  if (m.thisComputer) {
    return { pill: "you", status: "You are here", access: m.unattendedEnabled && m.hasAccessLogin ? "Unattended · username set" : m.unattendedEnabled ? "Unattended · no username yet" : "Remote Desktop off", canConnect: false };
  }
  if (!online) {
    return {
      pill: "offline",
      status: m.lastSeenAt ? `Offline · last seen ${relativeTime(m.lastSeenAt, now)}` : "Offline · never seen",
      access: m.unattendedEnabled && m.hasAccessLogin ? "Unattended · username set" : "Turn on unattended access from its tray icon",
      canConnect: false,
    };
  }
  if (!m.unattendedEnabled || !m.hasAccessLogin) {
    return { pill: "warn", status: "Online", access: !m.unattendedEnabled ? "Someone must be there to allow you" : "No username set on it yet", canConnect: false };
  }
  if (m.locked) {
    return { pill: "online", status: "Online · Windows is locked", access: "Unattended · username set", canConnect: true };
  }
  return { pill: "online", status: "Online · nobody using it", access: "Unattended · username set", canConnect: true };
}

export function relativeTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `today ${time}`;
  const yesterday = new Date(now - 86_400_000).toDateString() === d.toDateString();
  if (yesterday) return `yesterday ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

export type ShareExpiry = "once" | "24h" | "standing";

export function shareExpiryLabel(share: { oneTime: boolean; expiresAt: string | null }): string {
  if (share.oneTime) return "Once";
  if (!share.expiresAt) return "Until you remove it";
  const t = new Date(share.expiresAt).getTime();
  const left = t - Date.now();
  if (left <= 0) return "Expired";
  const h = Math.ceil(left / 3_600_000);
  return h >= 2 ? `${h} hours left` : `${Math.max(1, Math.ceil(left / 60_000))} min left`;
}

/* ───────────────────── the control channel frames ─────────────────── */

/**
 * Viewer → machine.
 *   login: the username and password typed on the connecting side. ⛔ This is
 *          the ONE frame that carries a secret, and it crosses only the
 *          DTLS-encrypted peer connection — never a Connect server.
 *   audio: where sound and microphone should be right now.
 *   clip:  clipboard text, only when the session was granted `clipboard`.
 */
export type ViewerFrame =
  | { t: "login"; username: string; password: string }
  | { t: "audio"; sound: boolean; mic: boolean }
  | { t: "clip"; text: string }
  | { t: "monitor"; sourceId: string };

/**
 * Machine → viewer.
 *   login_result: the verdict. ⛔ Never echoes what was typed.
 *   ready:        the screen is now being sent.
 *   screens:      the monitors on offer, so the toolbar can switch.
 *   clip:         clipboard text from the machine, only when granted.
 *   locked:       Windows reports the session locked; the picture is black and
 *                 input is refused by the OS until someone unlocks it.
 */
export type MachineFrame =
  | { t: "login_result"; ok: boolean; attemptsLeft?: number; lockedForMs?: number }
  | { t: "ready" }
  | { t: "screens"; screens: Array<{ id: string; name: string }> }
  | { t: "clip"; text: string }
  | { t: "locked"; locked: boolean }
  | { t: "phone"; onCall: boolean };

export const MAX_CLIP_CHARS = 100_000;
const MAX_LOGIN_FIELD = 200;

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length <= max ? v : null;
}

export function parseViewerFrame(raw: unknown): ViewerFrame | null {
  let v: any = raw;
  if (typeof raw === "string") {
    if (raw.length > MAX_CLIP_CHARS + 200) return null;
    try { v = JSON.parse(raw); } catch { return null; }
  }
  if (!v || typeof v !== "object") return null;
  switch (v.t) {
    case "login": {
      const username = str(v.username, MAX_LOGIN_FIELD);
      const password = str(v.password, MAX_LOGIN_FIELD);
      if (username == null || password == null) return null;
      return { t: "login", username, password };
    }
    case "audio":
      if (typeof v.sound !== "boolean" || typeof v.mic !== "boolean") return null;
      return { t: "audio", sound: v.sound, mic: v.mic };
    case "clip": {
      const text = str(v.text, MAX_CLIP_CHARS);
      if (text == null) return null;
      return { t: "clip", text };
    }
    case "monitor": {
      const sourceId = str(v.sourceId, 200);
      if (sourceId == null || !/^(screen|window):[\w:-]+$/.test(sourceId)) return null;
      return { t: "monitor", sourceId };
    }
    default:
      return null;
  }
}

export function parseMachineFrame(raw: unknown): MachineFrame | null {
  let v: any = raw;
  if (typeof raw === "string") {
    if (raw.length > MAX_CLIP_CHARS + 200) return null;
    try { v = JSON.parse(raw); } catch { return null; }
  }
  if (!v || typeof v !== "object") return null;
  switch (v.t) {
    case "login_result": {
      if (typeof v.ok !== "boolean") return null;
      const out: MachineFrame = { t: "login_result", ok: v.ok };
      if (typeof v.attemptsLeft === "number" && Number.isFinite(v.attemptsLeft)) out.attemptsLeft = Math.max(0, Math.min(10, Math.floor(v.attemptsLeft)));
      if (typeof v.lockedForMs === "number" && Number.isFinite(v.lockedForMs)) out.lockedForMs = Math.max(0, Math.min(3_600_000, Math.floor(v.lockedForMs)));
      return out;
    }
    case "ready":
      return { t: "ready" };
    case "screens": {
      if (!Array.isArray(v.screens) || v.screens.length > 16) return null;
      const screens: Array<{ id: string; name: string }> = [];
      for (const s of v.screens) {
        const id = str(s?.id, 200);
        const name = str(s?.name, 120);
        if (id == null || name == null) return null;
        screens.push({ id, name });
      }
      return { t: "screens", screens };
    }
    case "clip": {
      const text = str(v.text, MAX_CLIP_CHARS);
      if (text == null) return null;
      return { t: "clip", text };
    }
    case "locked":
      if (typeof v.locked !== "boolean") return null;
      return { t: "locked", locked: v.locked };
    case "phone":
      if (typeof v.onCall !== "boolean") return null;
      return { t: "phone", onCall: v.onCall };
    default:
      return null;
  }
}

/** The link readout's three states — "Measuring…" is real and never drawn as good. */
export function linkGrade(q: { packetLoss: number | null; roundTripMs: number | null } | null): "unknown" | "good" | "fair" | "poor" {
  if (!q || (q.packetLoss == null && q.roundTripMs == null)) return "unknown";
  const loss = q.packetLoss ?? 0;
  const rtt = q.roundTripMs ?? 0;
  if (loss >= 0.03 || rtt >= 300) return "poor";
  if (loss >= 0.01 || rtt >= 150) return "fair";
  return "good";
}

export function linkLabel(q: { packetLoss: number | null; roundTripMs: number | null; kbps?: number | null } | null, route: string | null): string {
  const grade = linkGrade(q);
  const word = grade === "unknown" ? "Measuring…" : grade === "good" ? "Good" : grade === "fair" ? "Slow" : "Poor";
  const parts = [word];
  if (route) parts.push(route);
  if (q?.roundTripMs != null) parts.push(`${q.roundTripMs} ms`);
  return parts.join(" · ");
}

/** The words a person is told when a session ends. */
export function describeEnd(reason: string | null | undefined, endedBy: string | null | undefined): string {
  switch (reason) {
    case "machine_disconnected": return "The computer disconnected.";
    case "viewer_disconnected": return "Your connection dropped.";
    case "machine_did_not_answer": return "The computer did not pick up.";
    case "max_duration": return "The session reached its four-hour limit.";
    case "remote_support_disabled": return "Remote access was switched off by Loopcom.";
    case "login_locked": return "Too many wrong passwords. That computer is locked for 15 minutes.";
    default:
      if (endedBy === "machine") return "Stopped from the remote computer.";
      if (endedBy === "viewer") return "You disconnected.";
      return "The session ended.";
  }
}
