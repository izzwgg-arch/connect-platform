/**
 * The floating Coworker bubble: geometry, click-vs-drag, and where the chat opens.
 *
 * ⛔ PURE ON PURPOSE. Everything here is arithmetic over plain rectangles, so the
 * fiddly parts — "did the user click or nudge it?", "is it still on a screen they
 * can see?", "which side does the chat open on near the right edge?" — are unit
 * tested rather than discovered by a customer whose bubble ended up off-screen
 * after they unplugged a monitor. The Electron wiring in widgetWindow.ts holds no
 * logic of its own.
 */

export type Rect = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

/** Diameter of the bubble in logical pixels. Small enough to live anywhere. */
export const WIDGET_SIZE = 64;

/** The compact chat panel the bubble opens. */
export const CHAT_WIDTH = 400;
export const CHAT_HEIGHT = 580;

/** Gap between the bubble and the chat panel. */
const CHAT_GAP = 12;

/** Keep at least this much of the bubble on screen when clamping. */
const MIN_VISIBLE = WIDGET_SIZE;

/**
 * ⛔ A press that moves further than this is a DRAG, not a click.
 *
 * 4px is deliberate. At 0 the bubble opens the chat every time somebody nudges it
 * while dragging; much above ~6 and a genuine tap on a high-DPI screen (where a
 * finger or a shaky mouse moves 2-3px) starts feeling dead. The value is exported
 * so the test suite pins the behaviour at the boundary rather than near it.
 */
export const CLICK_SLOP_PX = 4;

/**
 * A press is a click when the pointer never travelled beyond the slop radius.
 * ⛔ Radial distance, not per-axis: 4px right AND 4px down is 5.7px of travel and
 * is a drag, which a naive `dx < slop && dy < slop` would call a click.
 */
export function isClick(start: Point, end: Point, slop: number = CLICK_SLOP_PX): boolean {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  return Math.sqrt(dx * dx + dy * dy) <= slop;
}

/**
 * Keep a rectangle inside a work area.
 *
 * ⛔ Clamps against the WORK AREA, never the full display bounds — the taskbar sits
 * in the difference, and a bubble parked under it is a bubble the user cannot click.
 */
export function clampToWorkArea(rect: Rect, workArea: Rect): Rect {
  const maxX = workArea.x + workArea.width - MIN_VISIBLE;
  const maxY = workArea.y + workArea.height - MIN_VISIBLE;
  return {
    ...rect,
    x: Math.round(Math.min(Math.max(rect.x, workArea.x), Math.max(maxX, workArea.x))),
    y: Math.round(Math.min(Math.max(rect.y, workArea.y), Math.max(maxY, workArea.y))),
  };
}

/**
 * Is this saved position still usable?
 *
 * ⛔ THE MONITOR-UNPLUGGED CASE. A bubble saved at x=2600 on a second screen is
 * invisible once that screen is gone, and "my Loopcom button vanished" reads as a
 * broken app. Any saved position is re-validated against the CURRENT displays at
 * every launch, and an off-screen one falls back to the default corner.
 */
export function isPositionVisible(pos: Point, workAreas: readonly Rect[]): boolean {
  if (!Array.isArray(workAreas) || workAreas.length === 0) return false;
  const rect: Rect = { x: pos.x, y: pos.y, width: WIDGET_SIZE, height: WIDGET_SIZE };
  return workAreas.some((wa) => {
    const overlapX = Math.min(rect.x + rect.width, wa.x + wa.width) - Math.max(rect.x, wa.x);
    const overlapY = Math.min(rect.y + rect.height, wa.y + wa.height) - Math.max(rect.y, wa.y);
    // Require a meaningful amount on screen, not a single pixel of overlap.
    return overlapX >= MIN_VISIBLE / 2 && overlapY >= MIN_VISIBLE / 2;
  });
}

/**
 * The default resting place: above the tray, clear of the corner, on the primary
 * screen. Bottom-right because that is where Windows users expect a persistent
 * helper and it avoids the Start button.
 */
export function defaultPosition(workArea: Rect): Point {
  return {
    x: Math.round(workArea.x + workArea.width - WIDGET_SIZE - 24),
    y: Math.round(workArea.y + workArea.height - WIDGET_SIZE - 24),
  };
}

/** Resolve a stored position, falling back when it is missing or off-screen. */
export function resolveStartPosition(
  saved: Point | null | undefined,
  primaryWorkArea: Rect,
  workAreas: readonly Rect[],
): Point {
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && isPositionVisible(saved, workAreas)) {
    // ⛔ Return a Point, not the Rect the clamp works in. Leaking width/height here
    // would write them into persisted settings and drift the saved shape over time.
    const clamped = clampToWorkArea({ ...saved, width: WIDGET_SIZE, height: WIDGET_SIZE }, primaryWorkArea);
    return { x: clamped.x, y: clamped.y };
  }
  return defaultPosition(primaryWorkArea);
}

/**
 * Where the chat panel goes relative to the bubble.
 *
 * ⛔ It must never cover the bubble (you need to click it again to close) and never
 * hang off screen. Prefers left-of/above the bubble, because the bubble's own
 * default home is the bottom-right corner.
 */
export function chatPositionFor(widget: Point, workArea: Rect): Point {
  const preferLeft = widget.x - CHAT_WIDTH - CHAT_GAP;
  const x = preferLeft >= workArea.x ? preferLeft : widget.x + WIDGET_SIZE + CHAT_GAP;

  const preferAbove = widget.y + WIDGET_SIZE - CHAT_HEIGHT;
  const y = preferAbove >= workArea.y ? preferAbove : widget.y;

  return clampToWorkArea({ x, y, width: CHAT_WIDTH, height: CHAT_HEIGHT }, {
    ...workArea,
    // Clamp using the panel's own size so its far edge stays on screen too.
    width: Math.max(workArea.width - (CHAT_WIDTH - MIN_VISIBLE), MIN_VISIBLE),
    height: Math.max(workArea.height - (CHAT_HEIGHT - MIN_VISIBLE), MIN_VISIBLE),
  });
}

/** Apply a drag delta to a position, clamped to the screen. */
export function dragTo(origin: Point, grabOffset: Point, pointer: Point, workArea: Rect): Point {
  const next = { x: pointer.x - grabOffset.x, y: pointer.y - grabOffset.y };
  const clamped = clampToWorkArea({ ...next, width: WIDGET_SIZE, height: WIDGET_SIZE }, workArea);
  return { x: clamped.x, y: clamped.y };
}

/**
 * A drag in progress, as the main process tracks it. Pure data: where the window
 * was when the press began, where the cursor was, and the cursor's offset inside
 * the bubble (so the bubble does not jump to put its corner under the pointer).
 */
export type DragSession = { origin: Point; grabOffset: Point; startCursor: Point };

export function beginDrag(windowPos: Point, cursorAt: Point): DragSession {
  return {
    origin: { x: windowPos.x, y: windowPos.y },
    grabOffset: { x: cursorAt.x - windowPos.x, y: cursorAt.y - windowPos.y },
    startCursor: { x: cursorAt.x, y: cursorAt.y },
  };
}

/**
 * The work area of the display a point is on — so a bubble dragged onto a second
 * monitor clamps to THAT monitor, instead of snapping back to the primary one the
 * moment it crosses the edge. Falls back to the given area when the point is on no
 * display at all (between screens, or a display that just went away).
 */
export function workAreaContaining(point: Point, workAreas: readonly Rect[], fallback: Rect): Rect {
  for (const wa of workAreas) {
    if (point.x >= wa.x && point.x < wa.x + wa.width && point.y >= wa.y && point.y < wa.y + wa.height) return wa;
  }
  return fallback;
}
