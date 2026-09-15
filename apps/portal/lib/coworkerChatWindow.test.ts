/**
 * The desktop Coworker popover (/desktop/coworker) — source guards.
 *
 * 2026-09-02: the desktop bubble's click opened `/assistant`, the SUPER_ADMIN owner
 * console, inside the full sidebar shell. Worse, any desktop window whose kind is
 * not "mini" fell through useSipPhone's proxy check and ran a FULL SIP engine — a
 * chat popover that would have registered a second phone on the same extension.
 * 2026-09-15: the popover became the Coworker WORKSPACE (the approved IDE-style
 * chat) — these guards moved with it. They read SOURCE because every one of these
 * is a wiring property no unit test of a helper can see.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isDesktopPassivePath, DESKTOP_PASSIVE_PATH_PREFIX } from "./sessionExpiry";

const root = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const page = stripComments(read("app/desktop/coworker/page.tsx"));
const popover = stripComments(read("components/coworker/CoworkerPopover.tsx"));
const bridge = stripComments(read("components/coworker/coworkerBridge.ts"));
const sip = stripComments(read("hooks/useSipPhone.ts"));

test("the popover page renders the Coworker workspace's compact form behind AuthGate — not the owner console, not a second chatbot", () => {
  assert.match(page, /<AuthGate>/);
  assert.match(page, /<CoworkerPopover \/>/);
  assert.match(page, /<UiLanguageProvider>/, "the popover sits outside the platform layout, so it brings its own language provider");
  assert.ok(!page.includes("agent-api"), "no direct agent calls in the page; the session hook owns them");
  assert.ok(!/\/assistant/.test(page), "never the /assistant owner console");
});

test("the route is a passive desktop path, so it never bounces to /login", () => {
  assert.equal(DESKTOP_PASSIVE_PATH_PREFIX, "/desktop/");
  assert.equal(isDesktopPassivePath("/desktop/coworker"), true);
});

test("the popover fills the window, and Minimize hides the desktop window through the bridge", () => {
  assert.match(read("components/coworker/coworkerStyles.ts"), /\.cw-popover \{ position: fixed; inset: 0;/);
  assert.match(popover, /onClick=\{closeBubble\}/);
  assert.match(bridge, /coworkerWidget\?\.closeChat\?\.\(\)/);
});

test("Open full page carries the task across and only shows for people who have the page", () => {
  assert.match(popover, /can\(COWORKER_PAGE_PERMISSION\)/);
  assert.match(popover, /\/coworker\?task=\$\{encodeURIComponent\(s\.taskId\)\}/);
  assert.match(popover, /b\.openFull\(route\)/);
});

test("the coworker chat window is a SIP PROXY — a chat popover must never register a second phone", () => {
  const fn = sip.slice(sip.indexOf("function isDesktopProxyWindow"), sip.indexOf("function localStateSnapshot"));
  assert.match(fn, /kind === "mini" \|\| kind === "coworker-chat"/);
  assert.match(sip, /windowKind\?: "full" \| "mini" \| "phone-engine" \| "coworker-widget" \| "coworker-chat"/);
});
