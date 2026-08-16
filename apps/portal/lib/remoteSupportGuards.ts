/**
 * Validation of input commands as they arrive on the customer's machine.
 *
 * ⛔ THIS IS DEFENCE IN DEPTH AND THE DUPLICATION IS DELIBERATE. The Electron
 * main process validates these commands again before performing them. Both
 * checks are wanted: this one is the first place a message from the network
 * lands, the other is the last gate before Windows' input queue, and neither
 * can import the other (one lives in the portal bundle, one in the desktop
 * app). If you change the shape of a command, change BOTH — a command that
 * passes here and fails there is a mouse that silently stops moving.
 *
 * The threat this addresses is small but real: the peer connection is
 * end-to-end, so what arrives is whatever the support side's browser sent. A
 * compromised or buggy sender must not be able to push arbitrary structures
 * into the injector.
 */

export type SafeInputCommand =
  | { kind: "move"; x: number; y: number }
  | { kind: "down"; x: number; y: number; button: string }
  | { kind: "up"; x: number; y: number; button: string }
  | { kind: "click"; x: number; y: number; button: string; double?: boolean }
  | { kind: "scroll"; x: number; y: number; deltaY: number }
  | { kind: "text"; text: string }
  | { kind: "key"; key: string; modifiers?: string[] };

const POINTER_KINDS = new Set(["move", "down", "up", "click", "scroll"]);
const BUTTONS = new Set(["left", "right", "middle"]);
const MODIFIERS = new Set(["shift", "ctrl", "alt", "meta"]);

const NAMED_KEYS = new Set([
  "backspace", "tab", "enter", "shift", "ctrl", "alt", "pause", "capslock",
  "escape", "space", "pageup", "pagedown", "end", "home", "left", "up",
  "right", "down", "printscreen", "insert", "delete", "meta",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);

/** A finite 0..1 fraction, or null when the value is unusable. */
function fraction(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

export function sanitizeIncomingInput(raw: unknown): SafeInputCommand | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const kind = String(c.kind || "");

  if (POINTER_KINDS.has(kind)) {
    const x = fraction(c.x);
    const y = fraction(c.y);
    // Malformed coordinates refuse the command rather than defaulting it to a
    // screen corner, which would click something nobody aimed at.
    if (x === null || y === null) return null;
    const button = BUTTONS.has(String(c.button)) ? String(c.button) : "left";

    if (kind === "move") return { kind: "move", x, y };
    if (kind === "down") return { kind: "down", x, y, button };
    if (kind === "up") return { kind: "up", x, y, button };
    if (kind === "click") return { kind: "click", x, y, button, double: c.double === true };

    const deltaY = Number(c.deltaY);
    if (!Number.isFinite(deltaY) || deltaY === 0) return null;
    return { kind: "scroll", x, y, deltaY: Math.max(-2400, Math.min(2400, Math.round(deltaY))) };
  }

  if (kind === "text") {
    const text = typeof c.text === "string" ? c.text.replace(/[\r\n]/g, "").slice(0, 500) : "";
    return text ? { kind: "text", text } : null;
  }

  if (kind === "key") {
    const key = String(c.key || "").toLowerCase();
    if (!key) return null;
    if (!NAMED_KEYS.has(key) && key.length !== 1) return null;
    const modifiers = Array.isArray(c.modifiers)
      ? c.modifiers.map((m) => String(m).toLowerCase()).filter((m) => MODIFIERS.has(m))
      : [];
    return { kind: "key", key, modifiers };
  }

  return null;
}
