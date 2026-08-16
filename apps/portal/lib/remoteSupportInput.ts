/**
 * Turning what the support person does in a browser into commands the
 * customer's computer can perform.
 *
 * ⛔ THE COORDINATE PROBLEM, which is the whole reason this file is separate
 * and tested. The support person sees the customer's screen inside a <video>
 * element that is almost never the same size or shape as the real screen. The
 * video is letterboxed (`object-fit: contain`), so there are usually black bars
 * on two sides. A click at the centre of the *element* is not a click at the
 * centre of the *screen* unless those bars are accounted for.
 *
 * Getting this wrong does not throw and does not look broken — it just means
 * every click lands slightly off, and further off the closer you get to the
 * edges. That is extremely confusing to debug during a live support call, so
 * the maths lives here on its own with tests instead of inline in a component.
 *
 * Everything is expressed as a 0..1 fraction of the customer's screen, so the
 * support side never needs to know their resolution.
 */

export type Rect = { width: number; height: number };

export type PointerPosition = {
  /** Position within the element the user clicked, in CSS pixels. */
  offsetX: number;
  offsetY: number;
};

export type ScreenFraction = { x: number; y: number } | null;

/**
 * Where a point inside a letterboxed video actually is on the source screen.
 *
 * Returns null when the point is in a black bar — that is not a location on
 * the customer's screen, so it must produce no click at all rather than a
 * clamped one at the edge.
 */
export function elementPointToScreenFraction(
  point: PointerPosition,
  element: Rect,
  video: Rect,
): ScreenFraction {
  if (!element.width || !element.height || !video.width || !video.height) return null;

  const elementAspect = element.width / element.height;
  const videoAspect = video.width / video.height;

  let renderedWidth = element.width;
  let renderedHeight = element.height;
  let offsetLeft = 0;
  let offsetTop = 0;

  if (videoAspect > elementAspect) {
    // Video is wider than the element: bars on top and bottom.
    renderedHeight = element.width / videoAspect;
    offsetTop = (element.height - renderedHeight) / 2;
  } else {
    // Video is taller: bars left and right.
    renderedWidth = element.height * videoAspect;
    offsetLeft = (element.width - renderedWidth) / 2;
  }

  const x = (point.offsetX - offsetLeft) / renderedWidth;
  const y = (point.offsetY - offsetTop) / renderedHeight;

  // In a black bar — deliberately no click.
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;

  return { x, y };
}

/** DOM button number → the name the injector understands. */
export function mouseButtonName(button: number): "left" | "right" | "middle" {
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "left";
}

/**
 * Browser key name → the injector's key vocabulary.
 *
 * Anything not named here that is a single character is typed as that
 * character, which is what makes non-English layouts work without a table.
 */
const KEY_ALIASES: Record<string, string> = {
  Enter: "enter",
  Backspace: "backspace",
  Tab: "tab",
  Escape: "escape",
  " ": "space",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  Delete: "delete",
  Insert: "insert",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  CapsLock: "capslock",
  PrintScreen: "printscreen",
  Pause: "pause",
};

/** Modifier keys are never sent on their own — they only ever decorate a key. */
const BARE_MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph"]);

export type KeyEventLike = {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
};

export type InputCommand =
  | { kind: "move"; x: number; y: number }
  | { kind: "down"; x: number; y: number; button: string }
  | { kind: "up"; x: number; y: number; button: string }
  | { kind: "click"; x: number; y: number; button: string; double?: boolean }
  | { kind: "scroll"; x: number; y: number; deltaY: number }
  | { kind: "text"; text: string }
  | { kind: "key"; key: string; modifiers?: string[] };

/**
 * Translate a keyboard event.
 *
 * Returns null for anything that should not be sent — a bare modifier press,
 * or a key with no meaning on the far side. Sending those would put stuck
 * modifiers on the customer's keyboard.
 */
export function keyEventToCommand(event: KeyEventLike): InputCommand | null {
  const raw = String(event.key ?? "");
  if (!raw) return null;
  if (BARE_MODIFIERS.has(raw)) return null;

  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("ctrl");
  if (event.shiftKey) modifiers.push("shift");
  if (event.altKey) modifiers.push("alt");
  if (event.metaKey) modifiers.push("meta");

  const aliased = KEY_ALIASES[raw];
  if (aliased) return { kind: "key", key: aliased, modifiers };

  // Function keys pass through by name.
  if (/^F([1-9]|1[0-2])$/.test(raw)) return { kind: "key", key: raw.toLowerCase(), modifiers };

  if (raw.length === 1) {
    // ⛔ With a modifier held this must be a KEY press, not typed text —
    // "ctrl + c" typed as the letter c is just the letter c. Only an
    // unmodified character (or one with plain shift, which the character
    // already reflects) is text.
    const onlyShift = modifiers.every((m) => m === "shift");
    if (modifiers.length === 0 || onlyShift) return { kind: "text", text: raw };
    return { kind: "key", key: raw.toLowerCase(), modifiers };
  }

  // Something like "F13", "ContextMenu", "Dead" — not worth guessing at.
  return null;
}

/**
 * Normalise a wheel event.
 *
 * Browsers report wheel deltas in three different units; Windows expects
 * multiples of 120 per notch. Lines and pages are converted so a scroll feels
 * roughly the same regardless of which browser the support person uses.
 */
export function wheelDeltaToWindows(deltaY: number, deltaMode = 0): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  const perUnit = deltaMode === 1 ? 40 : deltaMode === 2 ? 400 : 1;
  const pixels = deltaY * perUnit;
  // Windows' wheel is inverted relative to the DOM: positive deltaY is
  // scrolling down, but a positive wheel value means scrolling up.
  const notches = -pixels / 100;
  const scaled = Math.round(notches * 120);

  // ⛔ Sub-threshold scrolls return 0 and the caller drops them. The tempting
  // alternative — rounding them UP to a full 120 notch so "something happens" —
  // is wrong and was briefly written that way: a 0.1px trackpad twitch would
  // have become a full scroll notch, turning the smallest possible gesture into
  // the largest possible jump. Scrolling must stay proportional to the hand
  // that made it.
  const bounded = Math.max(-2400, Math.min(2400, scaled));
  // Normalise -0 to 0. They compare equal with ===, but not with Object.is,
  // which is what test assertions and some equality checks use — a value that
  // is "zero except when you check carefully" is not worth shipping.
  return bounded === 0 ? 0 : bounded;
}

/**
 * Should this move be sent?
 *
 * Mouse-move fires far more often than is useful, and every event is a network
 * message plus a Windows API call. Anything under a small threshold since the
 * last sent position is dropped — the pointer still looks smooth because the
 * far side interpolates naturally, and the traffic drops by an order of
 * magnitude.
 */
export function shouldSendMove(
  next: { x: number; y: number },
  last: { x: number; y: number } | null,
  minDelta = 0.002,
): boolean {
  if (!last) return true;
  return Math.abs(next.x - last.x) >= minDelta || Math.abs(next.y - last.y) >= minDelta;
}
