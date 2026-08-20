import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Conference page wiring guards. Source-reading on purpose — the defects these
 * prevent live in what the page RENDERS and what the nav declares, which no
 * unit test of a helper can see. Reads are CRLF-normalised (Windows checkouts).
 */

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8").replace(/\r\n/g, "\n");

const pageSrc = read("app/(platform)/conference/page.tsx");
const dialogSrc = read("app/(platform)/conference/ConferenceDialog.tsx");
const navSrc = read("navigation/navConfig.ts");
const cssSrc = read("app/globals.css");

test("⛔ the page gates itself on can_view_conferences — nav hiding is not access", () => {
  assert.match(pageSrc, /PermissionGate/);
  assert.match(pageSrc, /"can_view_conferences"/);
});

test("manage controls check what the route accepts — no visible door that 403s", () => {
  // The server's own mayManage answer wins once loaded; the local key check
  // covers the first render. Both name the same key the write routes gate on.
  assert.match(pageSrc, /serverMayManage \?\? can\("can_manage_conferences"/);
});

test("joining dials through the crm:dial click-to-call bus, not a second phone path", () => {
  assert.match(pageSrc, /new CustomEvent\("crm:dial"/);
});

test("the dialog posts to the existing /voice/conferences routes — no second creation path", () => {
  assert.match(dialogSrc, /apiPost<[^>]*>\("\/voice\/conferences"/);
  assert.match(dialogSrc, /apiPatch<[^>]*>\(\s*`\/voice\/conferences\//);
});

test("⛔ applyNow is offered to SUPER_ADMIN only, and only sent when ticked", () => {
  assert.match(dialogSrc, /isSuper && applyNow \? \{ applyNow: true \} : \{\}/);
  assert.match(dialogSrc, /backendJwtRole === "SUPER_ADMIN"/);
});

test("the sidebar item sits in Workspace, right before Install — Izzy's placement", () => {
  const conference = navSrc.indexOf('id: "workspace.conference"');
  const install = navSrc.indexOf('id: "workspace.install"');
  assert.ok(conference > -1, "workspace.conference nav item is missing");
  assert.ok(install > -1, "workspace.install nav item is missing");
  assert.ok(conference < install, "Conference must be declared BEFORE Install");
  // And nothing between them: the entry immediately preceding Install.
  const between = navSrc.slice(conference, install);
  const otherItems = (between.match(/id: "workspace\./g) || []).length;
  assert.equal(otherItems, 1, "Conference must be the item immediately before Install");
  assert.match(between, /permission: "can_view_workspace_conference"/);
  assert.match(between, /href: "\/conference"/);
});

test("the conference styles exist and alias theme tokens, never an own palette", () => {
  assert.match(cssSrc, /\.cf-grid \{/);
  const start = cssSrc.indexOf("Conference — room cards");
  assert.ok(start > -1, "the .cf-* block header is missing");
  // ⛔ Comments stripped first — the block's own header names the forbidden
  // pattern while warning against it (the three-times-hit guard trap). The
  // slice starts INSIDE the header comment, so cut to its close before the
  // generic stripper runs.
  const afterHeader = cssSrc.slice(start);
  const block = afterHeader.slice(afterHeader.indexOf("*/") + 2).replace(/\/\*[\s\S]*?\*\//g, "");
  // The billing lesson: a section must follow the app's theme switch, never
  // the operating system's.
  assert.doesNotMatch(block, /prefers-color-scheme/);
});
