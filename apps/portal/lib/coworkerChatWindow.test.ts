/**
 * The desktop Coworker popover (/desktop/coworker) — source guards.
 *
 * 2026-09-02: the desktop bubble's click opened `/assistant`, the SUPER_ADMIN owner
 * console, inside the full sidebar shell. Worse, any desktop window whose kind is
 * not "mini" fell through useSipPhone's proxy check and ran a FULL SIP engine — a
 * chat popover that would have registered a second phone on the same extension.
 * These read SOURCE because every one of those is a wiring property no unit test
 * of a helper can see.
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
const assistant = stripComments(read("components/FloatingAssistant.tsx"));
const sip = stripComments(read("hooks/useSipPhone.ts"));

test("the popover page docks the SAME FloatingAssistant behind AuthGate — not a second chatbot", () => {
  assert.match(page, /<AuthGate>/);
  assert.match(page, /<FloatingAssistant docked \/>/);
  assert.ok(!page.includes("agent-api"), "no direct agent calls in the page; the assistant component owns them");
});

test("the route is a passive desktop path, so it never bounces to /login", () => {
  assert.equal(DESKTOP_PASSIVE_PATH_PREFIX, "/desktop/");
  assert.equal(isDesktopPassivePath("/desktop/coworker"), true);
});

test("docked mode starts open, draws no corner bubble, and fills the window", () => {
  assert.match(assistant, /export function FloatingAssistant\(\{ docked = false \}/);
  assert.match(assistant, /useState\(docked\)/, "the popover must open with the chat showing — there is no bubble to press");
  assert.match(assistant, /\{!docked && \(\s*<div className="fa-fab-wrap">/, "the corner bubble must not render inside the popover");
  assert.match(assistant, /\.fa-docked \.fa-panel \{ top: 0; left: 0; right: 0; bottom: 0;/);
});

test("docked Minimize hides the desktop window through the bridge instead of collapsing to nothing", () => {
  const fn = assistant.slice(assistant.indexOf("const minimize = () => {"), assistant.indexOf("setOpen(false);\n  };") + 20);
  assert.match(fn, /coworkerWidget\?\.closeChat\?\.\(\)/);
  assert.equal((assistant.match(/onClick=\{minimize\}/g) || []).length, 5, "every panel's Minimize goes through the one helper");
  assert.ok(!assistant.includes('uiEvent("minimize"); setOpen(false);'), "a Minimize that only setOpen(false) leaves the popover an empty window");
});

test("the coworker chat window is a SIP PROXY — a chat popover must never register a second phone", () => {
  const fn = sip.slice(sip.indexOf("function isDesktopProxyWindow"), sip.indexOf("function localStateSnapshot"));
  assert.match(fn, /kind === "mini" \|\| kind === "coworker-chat"/);
  assert.match(sip, /windowKind\?: "full" \| "mini" \| "phone-engine" \| "coworker-widget" \| "coworker-chat"/);
});
