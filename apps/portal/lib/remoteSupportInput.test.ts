import { test } from "node:test";
import assert from "node:assert/strict";

import {
  elementPointToScreenFraction,
  keyEventToCommand,
  mouseButtonName,
  shouldSendMove,
  wheelDeltaToWindows,
} from "./remoteSupportInput";

/**
 * The letterboxing maths is the reason this file exists. Getting it wrong does
 * not throw and does not look broken — every click just lands slightly off, and
 * further off toward the edges. That is a miserable thing to debug during a
 * live support call, so it is pinned here instead.
 */

// A 1920×1080 screen shown inside a 1000×800 element: the video is wider than
// the box, so there are bars top and bottom.
const SCREEN = { width: 1920, height: 1080 };
const WIDE_BOX = { width: 1000, height: 800 };
// Rendered height = 1000 / (1920/1080) = 562.5, so bars are (800-562.5)/2 = 118.75
const BAR = 118.75;

test("the centre of the video is the centre of the screen", () => {
  const p = elementPointToScreenFraction({ offsetX: 500, offsetY: 400 }, WIDE_BOX, SCREEN);
  assert.ok(p);
  assert.ok(Math.abs(p!.x - 0.5) < 1e-9, `x was ${p!.x}`);
  assert.ok(Math.abs(p!.y - 0.5) < 1e-9, `y was ${p!.y}`);
});

test("⛔ the top-left of the IMAGE is 0,0 — not the top-left of the element", () => {
  // This is the bug the whole module exists to prevent: treating the element's
  // corner as the screen's corner shifts every single click.
  const atImageCorner = elementPointToScreenFraction({ offsetX: 0, offsetY: BAR }, WIDE_BOX, SCREEN);
  assert.ok(atImageCorner);
  assert.ok(Math.abs(atImageCorner!.x - 0) < 1e-6);
  assert.ok(Math.abs(atImageCorner!.y - 0) < 1e-6);
});

test("⛔ a click in the black bar produces NO click at all", () => {
  // Clamping it to the edge would put a click somewhere the support person did
  // not aim, which on a real desktop can hit a close button.
  assert.equal(elementPointToScreenFraction({ offsetX: 500, offsetY: 10 }, WIDE_BOX, SCREEN), null);
  assert.equal(elementPointToScreenFraction({ offsetX: 500, offsetY: 790 }, WIDE_BOX, SCREEN), null);
});

test("the bottom-right of the image is 1,1", () => {
  const p = elementPointToScreenFraction({ offsetX: 1000, offsetY: 800 - BAR }, WIDE_BOX, SCREEN);
  assert.ok(p);
  assert.ok(Math.abs(p!.x - 1) < 1e-6);
  assert.ok(Math.abs(p!.y - 1) < 1e-6);
});

test("bars on the left and right are handled too", () => {
  // A tall element showing a wide screen puts the bars on the other axis... so
  // use a tall SCREEN in a wide box to force left/right bars.
  const tallScreen = { width: 1080, height: 1920 };
  const box = { width: 1000, height: 800 };
  // rendered width = 800 * (1080/1920) = 450; bars = (1000-450)/2 = 275
  const centre = elementPointToScreenFraction({ offsetX: 500, offsetY: 400 }, box, tallScreen);
  assert.ok(centre);
  assert.ok(Math.abs(centre!.x - 0.5) < 1e-9);
  assert.ok(Math.abs(centre!.y - 0.5) < 1e-9);

  assert.equal(elementPointToScreenFraction({ offsetX: 100, offsetY: 400 }, box, tallScreen), null);
  assert.equal(elementPointToScreenFraction({ offsetX: 900, offsetY: 400 }, box, tallScreen), null);
});

test("an exactly-matching aspect ratio has no bars", () => {
  const p = elementPointToScreenFraction({ offsetX: 480, offsetY: 270 }, { width: 960, height: 540 }, SCREEN);
  assert.ok(p);
  assert.ok(Math.abs(p!.x - 0.5) < 1e-9);
  assert.ok(Math.abs(p!.y - 0.5) < 1e-9);
});

test("a video or element with no size yields nothing rather than dividing by zero", () => {
  assert.equal(elementPointToScreenFraction({ offsetX: 5, offsetY: 5 }, { width: 0, height: 0 }, SCREEN), null);
  assert.equal(elementPointToScreenFraction({ offsetX: 5, offsetY: 5 }, WIDE_BOX, { width: 0, height: 0 }), null);
});

test("mouse buttons map to names", () => {
  assert.equal(mouseButtonName(0), "left");
  assert.equal(mouseButtonName(1), "middle");
  assert.equal(mouseButtonName(2), "right");
  assert.equal(mouseButtonName(99), "left");
});

// ── Keyboard ────────────────────────────────────────────────────────────────

test("plain typing is sent as text", () => {
  assert.deepEqual(keyEventToCommand({ key: "a" }), { kind: "text", text: "a" });
  assert.deepEqual(keyEventToCommand({ key: "Z", shiftKey: true }), { kind: "text", text: "Z" });
});

test("⛔ ctrl+c is a KEY press, never the letter c", () => {
  // Typing "c" would just insert a letter. This is the difference between
  // copying and corrupting whatever the customer had selected.
  assert.deepEqual(keyEventToCommand({ key: "c", ctrlKey: true }), {
    kind: "key", key: "c", modifiers: ["ctrl"],
  });
  assert.deepEqual(keyEventToCommand({ key: "V", ctrlKey: true, shiftKey: true }), {
    kind: "key", key: "v", modifiers: ["ctrl", "shift"],
  });
});

test("⛔ a bare modifier press is never sent", () => {
  // Sending these leaves modifiers stuck down on the customer's keyboard.
  for (const key of ["Shift", "Control", "Alt", "Meta", "AltGraph"]) {
    assert.equal(keyEventToCommand({ key }), null, `${key} must not be sent`);
  }
});

test("named keys are translated to the injector's vocabulary", () => {
  assert.deepEqual(keyEventToCommand({ key: "Enter" }), { kind: "key", key: "enter", modifiers: [] });
  assert.deepEqual(keyEventToCommand({ key: "ArrowLeft" }), { kind: "key", key: "left", modifiers: [] });
  assert.deepEqual(keyEventToCommand({ key: " " }), { kind: "key", key: "space", modifiers: [] });
  assert.deepEqual(keyEventToCommand({ key: "Escape" }), { kind: "key", key: "escape", modifiers: [] });
  assert.deepEqual(keyEventToCommand({ key: "F5" }), { kind: "key", key: "f5", modifiers: [] });
});

test("ctrl+alt+delete is expressed properly", () => {
  assert.deepEqual(keyEventToCommand({ key: "Delete", ctrlKey: true, altKey: true }), {
    kind: "key", key: "delete", modifiers: ["ctrl", "alt"],
  });
});

test("unknown multi-character keys are dropped rather than guessed at", () => {
  assert.equal(keyEventToCommand({ key: "ContextMenu" }), null);
  assert.equal(keyEventToCommand({ key: "Dead" }), null);
  assert.equal(keyEventToCommand({ key: "" }), null);
});

test("accented and non-Latin characters are typed as themselves", () => {
  // The unicode path in the injector is what makes this work without knowing
  // the customer's keyboard layout.
  assert.deepEqual(keyEventToCommand({ key: "é" }), { kind: "text", text: "é" });
  assert.deepEqual(keyEventToCommand({ key: "ש" }), { kind: "text", text: "ש" });
});

// ── Wheel ───────────────────────────────────────────────────────────────────

test("⛔ scroll direction is inverted for Windows", () => {
  // Positive deltaY in the DOM means scrolling down; a positive Windows wheel
  // value means up. Getting this backwards makes every page scroll the wrong
  // way, which reads as "remote control is broken".
  assert.ok(wheelDeltaToWindows(100) < 0, "scrolling down must be negative");
  assert.ok(wheelDeltaToWindows(-100) > 0, "scrolling up must be positive");
});

test("line and page scroll units are converted, not passed through raw", () => {
  const pixels = wheelDeltaToWindows(100, 0);
  const lines = wheelDeltaToWindows(3, 1);
  const pages = wheelDeltaToWindows(1, 2);
  for (const v of [pixels, lines, pages]) {
    assert.ok(Number.isFinite(v) && v !== 0);
    assert.ok(Math.abs(v) <= 2400);
  }
  // A three-line scroll should be in the same ballpark as ~120px, not 3 units.
  assert.ok(Math.abs(lines) > Math.abs(wheelDeltaToWindows(3, 0)));
});

test("⛔ scrolling stays PROPORTIONAL — a tiny gesture is never amplified", () => {
  // The tempting alternative is to round sub-threshold scrolls up to a full
  // 120 notch so "something happens". That turns the smallest possible
  // trackpad twitch into the largest possible jump on the customer's screen.
  const tiny = wheelDeltaToWindows(1);
  const normal = wheelDeltaToWindows(100);
  assert.ok(Math.abs(tiny) < Math.abs(normal), "a 1px scroll must be smaller than a 100px scroll");
  assert.ok(Math.abs(tiny) < 120, "a 1px scroll must not become a full notch");

  // A sub-threshold gesture rounds to nothing and the caller drops it, rather
  // than being inflated into a visible jump.
  assert.equal(wheelDeltaToWindows(0.1), 0);
});

test("a normal mouse notch is about one Windows notch", () => {
  // Browsers report ~100px per wheel notch, which should land near 120.
  assert.equal(wheelDeltaToWindows(100), -120);
});

test("a zero or malformed wheel event produces nothing", () => {
  assert.equal(wheelDeltaToWindows(0), 0);
  assert.equal(wheelDeltaToWindows(Number.NaN), 0);
  assert.equal(wheelDeltaToWindows(Number.POSITIVE_INFINITY), 0);
});

test("huge scrolls are bounded", () => {
  assert.equal(wheelDeltaToWindows(1_000_000), -2400);
  assert.equal(wheelDeltaToWindows(-1_000_000), 2400);
});

// ── Move throttling ─────────────────────────────────────────────────────────

test("the first move is always sent", () => {
  assert.equal(shouldSendMove({ x: 0.5, y: 0.5 }, null), true);
});

test("⛔ imperceptible moves are dropped — every event is a network message", () => {
  assert.equal(shouldSendMove({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }), false);
  assert.equal(shouldSendMove({ x: 0.5001, y: 0.5 }, { x: 0.5, y: 0.5 }), false);
});

test("a real move is sent", () => {
  assert.equal(shouldSendMove({ x: 0.51, y: 0.5 }, { x: 0.5, y: 0.5 }), true);
  assert.equal(shouldSendMove({ x: 0.5, y: 0.6 }, { x: 0.5, y: 0.5 }), true);
});
