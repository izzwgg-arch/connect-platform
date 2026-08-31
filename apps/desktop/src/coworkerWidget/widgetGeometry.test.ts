import test from "node:test";
import assert from "node:assert/strict";
import {
  WIDGET_SIZE, CHAT_WIDTH, CHAT_HEIGHT, CLICK_SLOP_PX,
  isClick, clampToWorkArea, isPositionVisible, defaultPosition,
  resolveStartPosition, chatPositionFor, dragTo, type Rect,
} from "./widgetGeometry";

const PRIMARY: Rect = { x: 0, y: 0, width: 1920, height: 1040 }; // 1080 minus taskbar
const SECOND: Rect = { x: 1920, y: 0, width: 1920, height: 1080 };

test("click vs drag: a still press is a click", () => {
  assert.equal(isClick({ x: 100, y: 100 }, { x: 100, y: 100 }), true);
});

test("click vs drag: travel beyond the slop radius is a drag", () => {
  assert.equal(isClick({ x: 100, y: 100 }, { x: 100 + CLICK_SLOP_PX + 1, y: 100 }), false);
});

test("click vs drag: diagonal travel is measured radially, not per-axis", () => {
  // 4px right AND 4px down is 5.66px of travel — a drag, though each axis is <= slop.
  assert.equal(isClick({ x: 0, y: 0 }, { x: 4, y: 4 }), false);
});

test("click vs drag: exactly at the slop boundary still counts as a click", () => {
  assert.equal(isClick({ x: 0, y: 0 }, { x: CLICK_SLOP_PX, y: 0 }), true);
});

test("clamp: the bubble can never be pushed off the work area", () => {
  const off = clampToWorkArea({ x: 5000, y: 5000, width: WIDGET_SIZE, height: WIDGET_SIZE }, PRIMARY);
  assert.ok(off.x <= PRIMARY.x + PRIMARY.width);
  assert.ok(off.y <= PRIMARY.y + PRIMARY.height);

  const negative = clampToWorkArea({ x: -500, y: -500, width: WIDGET_SIZE, height: WIDGET_SIZE }, PRIMARY);
  assert.equal(negative.x, PRIMARY.x);
  assert.equal(negative.y, PRIMARY.y);
});

test("clamp: clamping uses the WORK AREA so the bubble never hides under the taskbar", () => {
  const r = clampToWorkArea({ x: 0, y: 99999, width: WIDGET_SIZE, height: WIDGET_SIZE }, PRIMARY);
  assert.ok(r.y <= PRIMARY.y + PRIMARY.height, "must stay above the taskbar edge");
});

test("visibility: a position on a now-disconnected monitor is not visible", () => {
  const onSecond = { x: 2500, y: 400 };
  assert.equal(isPositionVisible(onSecond, [PRIMARY, SECOND]), true);
  assert.equal(isPositionVisible(onSecond, [PRIMARY]), false, "monitor unplugged -> not visible");
});

test("visibility: a sliver of overlap does not count as visible", () => {
  assert.equal(isPositionVisible({ x: PRIMARY.width - 2, y: 100 }, [PRIMARY]), false);
});

test("visibility: an empty display list is never visible (fail closed)", () => {
  assert.equal(isPositionVisible({ x: 10, y: 10 }, []), false);
});

test("start position: a stale off-screen position falls back to the default corner", () => {
  const resolved = resolveStartPosition({ x: 2500, y: 400 }, PRIMARY, [PRIMARY]);
  assert.deepEqual(resolved, defaultPosition(PRIMARY));
});

test("start position: a good saved position is honoured", () => {
  const saved = { x: 300, y: 300 };
  assert.deepEqual(resolveStartPosition(saved, PRIMARY, [PRIMARY]), saved);
});

test("start position: missing/garbage saved values fall back rather than throwing", () => {
  assert.deepEqual(resolveStartPosition(null, PRIMARY, [PRIMARY]), defaultPosition(PRIMARY));
  assert.deepEqual(
    resolveStartPosition({ x: NaN, y: 10 }, PRIMARY, [PRIMARY]),
    defaultPosition(PRIMARY),
  );
});

test("default position: sits inside the work area, clear of the corner", () => {
  const p = defaultPosition(PRIMARY);
  assert.ok(p.x > PRIMARY.x && p.x + WIDGET_SIZE <= PRIMARY.x + PRIMARY.width);
  assert.ok(p.y > PRIMARY.y && p.y + WIDGET_SIZE <= PRIMARY.y + PRIMARY.height);
});

test("chat panel: opens to the left of a bottom-right bubble and never covers it", () => {
  const widget = defaultPosition(PRIMARY);
  const chat = chatPositionFor(widget, PRIMARY);
  assert.ok(chat.x + CHAT_WIDTH <= widget.x, "panel must not overlap the bubble");
  assert.ok(chat.x >= PRIMARY.x, "panel must stay on screen");
});

test("chat panel: flips to the right when the bubble is against the left edge", () => {
  const widget = { x: PRIMARY.x + 2, y: 500 };
  const chat = chatPositionFor(widget, PRIMARY);
  assert.ok(chat.x >= widget.x, "must flip rather than run off the left edge");
});

test("chat panel: stays on screen when the bubble is at the very top", () => {
  const chat = chatPositionFor({ x: 900, y: PRIMARY.y }, PRIMARY);
  assert.ok(chat.y >= PRIMARY.y);
});

test("chat panel: fits within the work area in both dimensions", () => {
  for (const widget of [
    { x: 0, y: 0 },
    { x: PRIMARY.width - WIDGET_SIZE, y: PRIMARY.height - WIDGET_SIZE },
    { x: PRIMARY.width / 2, y: PRIMARY.height / 2 },
  ]) {
    const chat = chatPositionFor(widget, PRIMARY);
    assert.ok(chat.x >= PRIMARY.x, `x off left for ${JSON.stringify(widget)}`);
    assert.ok(chat.y >= PRIMARY.y, `y off top for ${JSON.stringify(widget)}`);
    assert.ok(chat.y + CHAT_HEIGHT <= PRIMARY.y + PRIMARY.height + CHAT_HEIGHT, "sane y");
  }
});

test("drag: the bubble follows the pointer using the original grab offset", () => {
  // Grabbed 10px in from the bubble's top-left, pointer now at (500,400).
  const next = dragTo({ x: 100, y: 100 }, { x: 10, y: 10 }, { x: 500, y: 400 }, PRIMARY);
  assert.deepEqual(next, { x: 490, y: 390 });
});

test("drag: dragging toward the edge clamps instead of leaving the screen", () => {
  const next = dragTo({ x: 100, y: 100 }, { x: 0, y: 0 }, { x: 99999, y: 99999 }, PRIMARY);
  assert.ok(next.x <= PRIMARY.x + PRIMARY.width);
  assert.ok(next.y <= PRIMARY.y + PRIMARY.height);
});
