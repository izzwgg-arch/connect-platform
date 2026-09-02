/**
 * Guards for the two things that made the first Coworker bubble dead on arrival
 * (2026-09-02, Izzy: "The widget is dead. It doesn't do anything. Plus, it
 * doesn't have the real Loopcom logo."):
 *
 *   1. the bubble was an `-webkit-app-region: drag` handle, so on Windows the
 *      renderer never received its mousedown/mouseup and a click opened nothing;
 *   2. the click (had it worked) opened `/assistant` — the SUPER_ADMIN owner
 *      console inside the full sidebar shell — in a 400px popover;
 *   3. the artwork was a hand-drawn SVG glyph, not the Loopcom mark.
 *
 * These read SOURCE on purpose: each defect is a property of the markup, the
 * route string or the wiring, which no unit test of a pure function can see.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { beginDrag, workAreaContaining, isClick, type Rect } from "./widgetGeometry";
import { CHAT_ROUTE, BLUR_CLICK_GRACE_MS } from "./widgetWindow";

const root = path.resolve(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/** HTML comments and CSS/JS comments both gone, so a guard cannot match its own explanation. */
const stripHtmlComments = (s: string) => stripComments(s.replace(/<!--[\s\S]*?-->/g, ""));

const html = read("assets/coworkerWidget.html");
const htmlCode = stripHtmlComments(html);
const window_ = stripComments(read("src/coworkerWidget/widgetWindow.ts"));
const preload = stripComments(read("src/preload.ts"));
const types = stripComments(read("src/types.ts"));
const main = stripComments(read("src/main.ts"));

// ── 1. the click reaches the renderer ────────────────────────────────

test("the bubble is NOT an app-region drag handle — that swallowed every click on Windows", () => {
  assert.ok(!/app-region\s*:\s*drag/.test(htmlCode), "an -webkit-app-region: drag bubble never sees mousedown/mouseup");
});

test("the bubble reports press and release over the bridge, with pointer capture", () => {
  assert.match(htmlCode, /addEventListener\("pointerdown"/);
  assert.match(htmlCode, /addEventListener\("pointerup"/);
  assert.match(htmlCode, /setPointerCapture\(/, "without capture a fast drag loses its pointerup outside the 64px window");
  assert.match(htmlCode, /api\.dragStart\(\)/);
  assert.match(htmlCode, /api\.dragEnd\(\)/);
  assert.ok(!htmlCode.includes("api.openChat()"), "the renderer must not decide click-vs-drag itself any more; main does, from the real cursor");
});

test("the renderer sends NO coordinates — main reads the real cursor", () => {
  assert.match(preload, /dragStart: \(\) => ipcRenderer\.send\("coworker-widget:drag-start"\)/);
  assert.match(preload, /dragEnd: \(\) => ipcRenderer\.send\("coworker-widget:drag-end"\)/);
  assert.match(preload, /closeChat: \(\) => ipcRenderer\.send\("coworker-widget:close-chat"\)/);
  assert.match(window_, /screen\.getCursorScreenPoint\(\)/);
  assert.match(window_, /ipcMain\.on\("coworker-widget:drag-start"/);
  assert.match(window_, /ipcMain\.on\("coworker-widget:drag-end"/);
  assert.match(window_, /ipcMain\.on\("coworker-widget:close-chat"/);
});

test("a still press is a click and opens the chat; travel persists the position", () => {
  const onDragEnd = window_.slice(window_.indexOf("function onDragEnd"), window_.indexOf("function chatIsShowing"));
  assert.match(onDragEnd, /isClick\(session\.startCursor, end\)/);
  assert.match(onDragEnd, /toggleChatPanel\(\)/);
  assert.match(onDragEnd, /setSaved\(\{ position/);
  assert.ok(!window_.includes('on("moved"'), "position is persisted once at drag end, not on every setPosition");
});

test("the drag is a main-process timer, not a dependency on renderer pointermove", () => {
  const start = window_.slice(window_.indexOf("function onDragStart"), window_.indexOf("function onDragMove"));
  assert.match(start, /setInterval\(/);
  assert.match(start, /DRAG_MAX_MS/, "a press with no release must be abandoned, never leak a timer forever");
});

test("clicking the bubble while the chat is open closes it instead of bouncing it", () => {
  assert.match(window_, /chatHiddenByBlurAt = Date\.now\(\)/);
  assert.match(window_, /Date\.now\(\) - chatHiddenByBlurAt < BLUR_CLICK_GRACE_MS/);
  assert.ok(BLUR_CLICK_GRACE_MS >= 200 && BLUR_CLICK_GRACE_MS <= 1000);
});

// ── 2. it opens the customer assistant, not the owner console ────────

test("the chat opens /desktop/coworker — never the /assistant owner console", () => {
  assert.equal(CHAT_ROUTE, "/desktop/coworker");
  assert.ok(!window_.includes('"/assistant'), "/assistant is the SUPER_ADMIN owner console inside the full shell");
  assert.ok(CHAT_ROUTE.startsWith("/desktop/"), "the portal treats /desktop/* as a passive desktop window (no login redirect)");
});

test("both coworker windows are typed window kinds the portal can recognise", () => {
  assert.match(types, /"coworker-widget"/);
  assert.match(types, /"coworker-chat"/);
  assert.match(window_, /--connect-window-kind=coworker-widget/);
  assert.match(window_, /--connect-window-kind=coworker-chat/);
});

test("both coworker windows log their console — the dead build was invisible in the log", () => {
  assert.match(window_, /attachDiag\?\.\(widgetWindow, "coworker-widget"\)/);
  assert.match(window_, /attachDiag\?\.\(chatWindow, "coworker-chat"\)/);
  assert.match(main, /attachDiag: \(win: BrowserWindow, tag: string\) => attachConsoleCapture\(win, tag\)/);
});

// ── 3. the real logo ─────────────────────────────────────────────────

test("the bubble carries the real Loopcom mark as embedded PNG, not a hand-drawn glyph", () => {
  const m = html.match(/src="data:image\/png;base64,([A-Za-z0-9+/=]+)"/);
  assert.ok(m, "no embedded PNG");
  const png = Buffer.from(m![1], "base64");
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG", "data URI is not a PNG");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.equal(width, 128);
  assert.equal(height, 128);
  assert.ok(png.length > 8_000, "a 128px render of the Blue 2B tile is well over 8 KB; anything smaller is not it");
  assert.ok(!/<svg|<path/.test(htmlCode), "the hand-drawn SVG infinity must not come back");
  assert.match(htmlCode, /img-src data:/, "the CSP must allow the embedded artwork or the bubble renders blank");
});

test("the generator can regenerate the artwork from the brand kit", () => {
  const script = read("../../scripts/desktop-coworker-bubble-asset.py");
  assert.match(script, /blue-2b\/android-app-icon-512\.png/);
  assert.match(script, /coworkerWidget\.html/);
});

// ── pure geometry added for the main-driven drag ─────────────────────

const PRIMARY: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
const SECOND: Rect = { x: 1920, y: 0, width: 2560, height: 1400 };

test("beginDrag remembers where the cursor grabbed the bubble", () => {
  const s = beginDrag({ x: 100, y: 200 }, { x: 130, y: 220 });
  assert.deepEqual(s.grabOffset, { x: 30, y: 20 });
  assert.deepEqual(s.origin, { x: 100, y: 200 });
  assert.deepEqual(s.startCursor, { x: 130, y: 220 });
  assert.equal(isClick(s.startCursor, { x: 132, y: 221 }), true);
  assert.equal(isClick(s.startCursor, { x: 150, y: 221 }), false);
});

test("workAreaContaining picks the display under the cursor, so a drag can cross monitors", () => {
  assert.deepEqual(workAreaContaining({ x: 10, y: 10 }, [PRIMARY, SECOND], PRIMARY), PRIMARY);
  assert.deepEqual(workAreaContaining({ x: 2000, y: 10 }, [PRIMARY, SECOND], PRIMARY), SECOND);
  assert.deepEqual(workAreaContaining({ x: 1920, y: 10 }, [PRIMARY, SECOND], PRIMARY), SECOND, "the boundary column belongs to the right-hand display");
  assert.deepEqual(workAreaContaining({ x: -50, y: 10 }, [PRIMARY, SECOND], PRIMARY), PRIMARY, "off every display falls back");
  assert.deepEqual(workAreaContaining({ x: 10, y: 10 }, [], SECOND), SECOND, "no displays at all still answers");
});
