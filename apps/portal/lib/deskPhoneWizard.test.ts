import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ⛔ These read SOURCE on purpose. Both defects this screen exists to avoid live in
 * markup and in a render condition, not in a function: the last screen built from a
 * mockup in this repo shipped with the one thing that had actually been asked for
 * rendered only behind a flag nobody could reach, and every unit test passed.
 *
 * ⛔ Read with CRLF normalised — the working tree is CRLF under core.autocrlf and a
 * multi-line pattern otherwise matches nothing, which reads as "the string isn't
 * there".
 */
const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8").split("\r\n").join("\n");

/** ⛔ Every negative assertion reads a comment-stripped copy. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const WIZARD = read("components", "deskPhones", "DeskPhoneWizard.tsx");
const CSS = read("components", "deskPhones", "deskPhones.css");
const PAGE = read("app", "(platform)", "settings", "desk-phones", "page.tsx");
const SETTINGS = read("app", "(platform)", "settings", "page.tsx");

/* ── nothing technical reaches the customer ─────────────────────────────── */

test("the wizard never renders a hardware address, an IP or a provisioning URL", () => {
  // The API's customer view strips these at the source; this makes sure the screen
  // cannot reintroduce one by reading a field it should not have.
  for (const field of ["\\.mac\\b", "macAddress", "ipAddress", "provisioningUrl", "firmware\\b"]) {
    const re = new RegExp(`\\{?\\s*(phone|p)\\s*\\.\\s*${field}`);
    assert.ok(!re.test(WIZARD), `the wizard reads ${field}, which belongs in diagnostics only`);
  }
});

test("no status code, protocol name or provisioning jargon is on any customer string", () => {
  // ⛔ Comments are stripped first. The rules are EXPLAINED in comments, so a naive
  // scan of the file matches its own doc block and fails against correct code --
  // this repo has been caught by that five separate times.
  const executable = stripComments(WIZARD);
  // single-line literals only; a greedy match spans JSX attributes and captures the
  // whole file
  const NL = String.fromCharCode(10);
  const literal = new RegExp("\"([^\"\\"+NL+"]{12,160})\"", "g");
  const strings = [...executable.matchAll(literal)].map((m) => m[1]);
  const banned = /(HTTP|SIP|DHCP|Option\s*66|RPS|TFTP|MAC address|IP address|provisioning|subnet)/i;
  const leaks = strings.filter((s) => banned.test(s) && !s.startsWith("/") && !s.includes("desk-phones"));
  assert.deepEqual(leaks, [], "customer-facing copy must not contain jargon");
});

test("the six customer words are the only statuses the screen knows", () => {
  const m = /status:\s*"([^"]+)"(?:\s*\|\s*"([^"]+)")*/.exec(WIZARD);
  assert.ok(m, "the status union should be declared");
  for (const word of ["Finding", "Preparing", "Restarting", "Connecting", "Ready", "Needs attention"]) {
    assert.ok(WIZARD.includes(`"${word}"`), `${word} missing from the status union`);
  }
  assert.ok(!/"Failed"/.test(WIZARD), "a customer is never shown the word failed");
});

/* ── the card disappears ─────────────────────────────────────────────────── */

test("the setup card is driven by whether anything is left to do", () => {
  // ⛔ Not by "has a run", which would leave the customer permanently looking at
  // provisioning terminology after everything is connected.
  assert.match(PAGE, /state\?\.showSetupCard\s*&&/,
    "the card must render only while work remains");
});

test("an unreadable state is said out loud, not rendered as nothing to do", () => {
  assert.match(PAGE, /loadError/);
  assert.match(PAGE, /could not check your desk phones/i);
});

test("the page exports only a default component", () => {
  // ⛔ A named export from an App Router page fails the production build and
  // `tsc --noEmit` does not catch it.
  const exports = [...PAGE.matchAll(/^export\s+(default\s+)?(function|const|class)/gm)];
  assert.equal(exports.length, 1, "exactly one export");
  assert.ok(exports[0][1], "and it must be the default");
});

/* ── discoverability, which is the other half of "built" ─────────────────── */

test("desk phone setup is reachable from Settings", () => {
  assert.match(SETTINGS, /\/settings\/desk-phones/,
    "a feature that has to be discovered is not built");
  assert.match(SETTINGS, /Set Up My Phones/);
});

test("the Settings entry is behind the same key as the page and the API", () => {
  // ⛔ A visible control that refuses on click reads as a broken product. Nav gate,
  // page gate and API gate must all name ONE permission.
  assert.match(SETTINGS, /PermissionGate permission=\{"can_setup_desk_phones"/);
  assert.match(PAGE, /permission=\{"can_setup_desk_phones"/);
});

/* ── the wizard asks what Izzy asked for ─────────────────────────────────── */

test("it asks whether the customer knows what phone they have, and lets them say no", () => {
  assert.match(WIZARD, /Do you know what kind of phone you have\?/);
  assert.match(WIZARD, /No &mdash; I have no idea/);
  // "I don't know" is the same size as yes, not a small grey link
  assert.match(WIZARD, /Perfectly normal/);
});

test("cable versus Wi-Fi is drawn, not just described", () => {
  assert.match(WIZARD, /function CableDrawing/);
  assert.match(WIZARD, /function WifiDrawing/);
  assert.match(WIZARD, /aria-label="A desk phone with a network cable/);
  // ⛔ "Ethernet" means nothing to most people
  assert.ok(!/Ethernet/i.test(stripComments(WIZARD)), "the word means nothing to most people");
});

test("the same-office check is drawn too", () => {
  assert.match(WIZARD, /function SameNetworkDrawing/);
  assert.match(WIZARD, /all connect to the same office internet box/);
});

test("every drawing has an accessible label", () => {
  const svgs = [...WIZARD.matchAll(/<svg[^>]*>/g)].map((m) => m[0]);
  const unlabelled = svgs.filter((s) => !/aria-label|aria-hidden/.test(s));
  assert.deepEqual(unlabelled, [], "a drawing with no label is invisible to a screen reader");
});

test("the phone photo falls back to a drawing rather than a broken image", () => {
  assert.match(WIZARD, /photoFor\(p\.model\)\s*\n?\s*\?\s*<img/);
  assert.match(WIZARD, /:\s*<PhoneGlyph\s*\/>/);
});

test("a missing desktop app is explained rather than shown as an empty list", () => {
  assert.match(WIZARD, /needs the Loopcom app on a computer in the same office/);
});

/* ── the stylesheet ──────────────────────────────────────────────────────── */

test("every class is namespaced and scoped, so nothing collides with globals", () => {
  const selectors = [...CSS.matchAll(/^\.([a-zA-Z][\w-]*)/gm)].map((m) => m[1]);
  const stray = selectors.filter((s) => !s.startsWith("dps-"));
  assert.deepEqual(stray, [], "an unprefixed class in a 14,000-line stylesheet is a collision waiting");
});

test("the wizard follows the in-app theme, never the operating system's", () => {
  // ⛔ prefers-color-scheme is the OS setting, which disagrees with the app's own
  // light/dark toggle. Comments are stripped first: the rule is explained in one.
  const executable = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/prefers-color-scheme/.test(executable.replace(/@media \(prefers-reduced-motion[\s\S]*$/, "")),
    "colour must come from the portal's own theme tokens");
});

test("the choice tiles set their own colour, because a button does not inherit it", () => {
  // this exact omission made the tile text invisible in dark mode during review
  const tile = CSS.slice(CSS.indexOf(".dps-tile {"), CSS.indexOf(".dps-tile.dps-sel"));
  assert.match(tile, /color:\s*var\(--dps-text\)/);
});

test("motion is disabled for anyone who asks for less of it", () => {
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)/);
});

test("wide content scrolls in its own container", () => {
  assert.match(CSS, /\.dps-scroll\s*\{\s*overflow-x:\s*auto/);
});

/* ── the escape hatches Izzy asked for (2026-08-22) ──────────────────────── */

test("'I don't know the password' is a real button, not a wall", () => {
  // ⛔ Izzy: "What if they don't know their password?" The screen must offer the
  // way out on the SAME screen that asks — a person who has to hunt for it is stuck.
  assert.ok(WIZARD.includes("dontKnowPassword"), "the escape handler is gone");
  assert.ok(/I don&rsquo;t know it/.test(WIZARD), "the escape button's words are gone");
  // and pressing it must never post the api — it goes through the driver's memo
  const handler = WIZARD.slice(WIZARD.indexOf("const dontKnowPassword"), WIZARD.indexOf("const dontKnowPassword") + 400);
  assert.ok(!handler.includes("apiPost"), "the escape posts to the api instead of the driver");
});

test("the clearing screen lets a person pick WHICH devices, per device", () => {
  // ⛔ Izzy: "they should be able to select which one should be cleared, not just
  // clear all phones." A checkbox per row, ticked by default, and the button
  // counts only the ticked ones.
  assert.ok(WIZARD.includes("clearTicks"), "the per-device selection state is gone");
  assert.ok(WIZARD.includes('type="checkbox"'), "the checkboxes are gone");
  assert.ok(WIZARD.includes("tickedCount"), "the button no longer counts the ticked devices");
  assert.ok(WIZARD.includes("Skip all of these for now"), "the no-thanks path is gone");
  assert.ok(WIZARD.includes("declineAllResets"), "skipping no longer records a deliberate no");
});

test("the person-only asks are FULL SCREENS, never cards beside a progress list", () => {
  // ⛔ Izzy saw the card version: "it took me a second to realize how it's working…
  // dumb people will just get stuck here." When a decision is needed the wizard
  // stops and shows one question. The progress list renders only when nothing is
  // being asked.
  assert.ok(WIZARD.includes('step === "live" && !needs.length'),
    "the progress list no longer waits for the questions to be answered");
  assert.ok(/needs\.some\(\(n\) => n\.kind === "reset_authorization"\)/.test(WIZARD),
    "the clearing question is no longer its own screen");
});

test("every kind of device gets plain words, never category jargon", () => {
  assert.ok(WIZARD.includes("deviceKindFor"), "the wizard no longer knows device kinds");
  assert.ok(WIZARD.includes("describeKind"), "the friendly kind words are gone");
  const stripped = stripComments(WIZARD);
  for (const jargon of ["ATA", "FXS", "analog telephone adapter", "paging gateway"]) {
    assert.ok(!stripped.includes(`"${jargon}"`), `category jargon on the screen: ${jargon}`);
  }
});

/* ── the sidebar door (2026-08-22) ───────────────────────────────────────── */

test("the sidebar item, the page gate and the api gate all name ONE permission", () => {
  // ⛔ [[a-gate-must-agree-with-the-gate-behind-it]]: a nav key that differs from
  // the page's is either a visible door that refuses on click (the Queues bug) or
  // an invisible page that works. All three surfaces must say can_setup_desk_phones.
  const NAV = read("navigation", "navConfig.ts");
  const item = NAV.slice(NAV.indexOf('id: "workspace.desk_phones"'), NAV.indexOf('id: "workspace.desk_phones"') + 400);
  assert.ok(item.length > 10, "the sidebar item is gone");
  assert.ok(item.includes('permission: "can_setup_desk_phones"'),
    "the sidebar item gates on a different key than the page");
  assert.ok(item.includes('href: "/settings/desk-phones"'), "the item points somewhere else");
  assert.ok(PAGE.includes('"can_setup_desk_phones"'), "the page no longer gates on the same key");
});

test("the desk-phones item sits in the workspace section, before Install", () => {
  const NAV = read("navigation", "navConfig.ts");
  const at = NAV.indexOf('id: "workspace.desk_phones"');
  const install = NAV.indexOf('id: "workspace.install"');
  assert.ok(at > 0 && install > 0 && at < install, "the item moved out of place");
  const item = NAV.slice(at, at + 400);
  assert.ok(item.includes('section: "workspace"'), "the item left the workspace section");
});

test("no force rule makes the desk-phones item visible past its permission", () => {
  // Only system owners see it BECAUSE the key is in no default bucket — not
  // because of a hardcoded role check that a future permission grant could not
  // override. isNavItemVisibleForUser must not special-case it.
  const NAV = read("navigation", "navConfig.ts");
  const visible = NAV.slice(NAV.indexOf("export function isNavItemVisibleForUser"));
  assert.ok(!visible.includes("workspace.desk_phones"),
    "a hardcoded visibility rule would make the permission toggles a lie");
});
