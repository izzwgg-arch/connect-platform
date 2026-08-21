import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  avatarClassFor,
  callEventLabel,
  formatPhoneForDisplay,
  formatPhoneWhileTyping,
  initialsFor,
  isSearchablePhone,
  meetingPathFor,
  shortTimestamp,
} from "./loopcomDirect";

test("a number is shown the way a person writes it", () => {
  assert.equal(formatPhoneForDisplay("+13475550182"), "(347) 555-0182");
  assert.equal(formatPhoneForDisplay("+442071234567"), "+442071234567", "a non-NANP number is left alone");
  assert.equal(formatPhoneForDisplay(""), "");
});

test("the number field formats while it is still being typed", () => {
  assert.equal(formatPhoneWhileTyping("3"), "3");
  assert.equal(formatPhoneWhileTyping("347"), "347");
  assert.equal(formatPhoneWhileTyping("347555"), "(347) 555");
  assert.equal(formatPhoneWhileTyping("3475550182"), "(347) 555-0182");
  assert.equal(formatPhoneWhileTyping("13475550182"), "(347) 555-0182", "a leading 1 is absorbed");
  assert.equal(formatPhoneWhileTyping("(347) 555-0182"), "(347) 555-0182", "re-formatting is stable");
});

test("only a complete number triggers a search", () => {
  assert.equal(isSearchablePhone("347555018"), false);
  assert.equal(isSearchablePhone("3475550182"), true);
  assert.equal(isSearchablePhone("13475550182"), true);
  assert.equal(isSearchablePhone(""), false);
});

test("initials come from the name, and a nameless person gets a neutral mark", () => {
  assert.equal(initialsFor("Moshe Green"), "MG");
  assert.equal(initialsFor("Rivky"), "RI");
  assert.equal(initialsFor("Mrs. Halpert"), "MH");
  assert.equal(initialsFor(""), "?");
  assert.equal(initialsFor("   "), "?");
});

test("the same person always gets the same avatar colour", () => {
  assert.equal(avatarClassFor("uMoshe"), avatarClassFor("uMoshe"));
  assert.match(avatarClassFor("uMoshe"), /^c[1-5]$/);
  assert.equal(avatarClassFor(""), "unknown");
});

test("a finished call reads as plain English", () => {
  assert.equal(callEventLabel(240), "Video call · 4 min");
  assert.equal(callEventLabel(45), "Video call · 45 sec");
  assert.equal(callEventLabel(null), "Video call");
  assert.equal(callEventLabel(0), "Video call");
});

test("a call message links to the meeting, and a missing code links nowhere", () => {
  assert.equal(meetingPathFor("kxv-4mfp-tqe"), "/meet/kxv-4mfp-tqe");
  assert.equal(meetingPathFor(null), null);
});

test("timestamps shorten with age", () => {
  const now = new Date("2026-08-21T14:00:00Z");
  assert.match(shortTimestamp("2026-08-21T13:00:00Z", now), /\d/);
  assert.equal(shortTimestamp("not a date", now), "");
});

/* ---------------------------------------------------------- theme guards */

const css = readFileSync(path.join(__dirname, "..", "app", "(platform)", "direct", "loopcomDirect.css"), "utf8").replace(
  /\r\n/g,
  "\n",
);

/**
 * ⛔ Comments STRIPPED before any negative match. This file's own doc block
 * explains why prefers-color-scheme is wrong here, so a naive `includes()`
 * matches the explanation and fails against correct code — the guard-test trap
 * this repo has now hit five times.
 */
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, "");

test("⛔ the screen follows the IN-APP theme, never the operating system's", () => {
  // prefers-color-scheme is the OS setting and disagrees with the app's own
  // toggle; this codebase themes on :root[data-theme="..."].
  assert.ok(!cssCode.includes("prefers-color-scheme"), "Direct must not theme off prefers-color-scheme");
  assert.ok(cssCode.includes(':root[data-theme="light"]'), "a light override block must exist");
});

test("⛔ INK vs FILL: status text uses the darkened ink tokens, not the display colours", () => {
  // The light block must redefine every ink token, or light-mode text sits at
  // ~2:1 contrast (the queue wallboard lesson).
  const lightBlock = css.slice(css.indexOf(':root[data-theme="light"]'));
  for (const token of ["--lcd-ink-ok", "--lcd-ink-warn", "--lcd-ink-danger", "--lcd-ink-accent"]) {
    assert.ok(lightBlock.includes(`${token}:`), `${token} must be redefined for light mode`);
  }
});

test("⛔ surfaces and text come from theme tokens, so both modes work", () => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // A stray hex colour on a surface is what breaks one of the two modes. The
  // allowed literals are the ones documented in the file as deliberately fixed.
  const allowed = new Set([
    "#1466a8",
    "#eaf5ff",
    "#eef3f8",
    "#1a63c4",
    "#ffffff",
    "#04121d",
    "#0f7a4a",
    "#8a5a00",
    "#c0293a",
    "#22a8ff",
    "#34c27b",
    "#f0b655",
    "#b98cff",
    "#ff8f6b",
  ]);
  const hexes = [...stripped.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
  const unexpected = [...new Set(hexes)].filter((h) => !allowed.has(h));
  assert.deepEqual(unexpected, [], `unexpected literal colours: ${unexpected.join(", ")}`);
});

test("⛔ the shell owns its own scrolling with a definite height", () => {
  // max-height would let the panes stretch instead of scroll (Team Directory).
  assert.match(css, /\.lcd-shell\s*\{[^}]*height:\s*calc\(100vh/, "the shell needs a definite height");
  assert.match(css, /\.lcd-messages\s*\{[^}]*overflow-y:\s*auto/, "the message list must scroll");
  assert.match(css, /\.lcd-messages\s*\{[^}]*min-height:\s*0/, "min-height:0 is what makes flex children scroll");
});

/* --------------------------------------------------------- wiring guards */

test("⛔ Direct is in the sidebar and reuses the chat permission key", () => {
  const nav = readFileSync(path.join(__dirname, "..", "navigation", "navConfig.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.match(nav, /id:\s*"workspace\.direct"/, "the nav item must exist");
  assert.match(
    nav,
    /id:\s*"workspace\.direct"[^}]*permission:\s*"can_view_workspace_chat"/,
    "a new key would not reach TENANT_ADMIN without a live snapshot refresh",
  );
});

test("⛔ the page gates itself as well as the sidebar", () => {
  const page = readFileSync(
    path.join(__dirname, "..", "app", "(platform)", "direct", "page.tsx"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  assert.match(page, /PermissionGate/, "hiding a nav item is presentation, not access");
  assert.match(page, /fallback=/, "a refused page must say so, never render blank");
});
