import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The sidebar used to render two different DOM trees — one for the expanded
 * sidebar, one for the collapsed icon rail — and swap between them on the
 * toggle. Measured against this repo's own stylesheet, ANY DOM change inside
 * `.console-shell` costs ~70ms of style recalculation (the sheet carries 73
 * `:has()` rules and their invalidation work is paid per mutation, whatever
 * its size). So the swap stalled the main thread for 80-130ms on the exact
 * frame the width transition began, and that stall was the visible stutter.
 * A class-only toggle measures ~10ms.
 *
 * These are source-level guards on purpose. The defect was in what the
 * component RENDERS, not in what any function returns, so a unit test of a
 * helper passes straight through it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), "utf8");

const sidebar = read("SidebarNav.tsx");
const switcher = read("TenantSwitcher.tsx");
const css = read("../app/globals.css");

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

test("the sidebar renders ONE nav list, not one per mode", () => {
  assert.equal(
    count(sidebar, 'className={`drawer-nav-link'),
    1,
    "SidebarNav must build a nav link in exactly one place — a second one means the rail is rendering its own markup again",
  );
  assert.equal(count(sidebar, '<nav className="drawer-nav"'), 1);
  assert.equal(
    count(sidebar, "nav-rail-stack"),
    0,
    "nav-rail-stack was the separate rail tree; the rail is a class on the <aside> now",
  );
  assert.equal(count(sidebar, "drawer-nav-link-rail"), 0);
  assert.equal(count(sidebar, "drawer-user-rail"), 0);
});

test("the rail is expressed as a class, and the profile block is not rebuilt for it", () => {
  assert.match(sidebar, /!isMobile && effectiveRail \? "nav-rail" : ""/);
  assert.equal(
    count(sidebar, "<UserAvatarUpload"),
    1,
    "two avatars means the profile block is still being swapped per mode",
  );
  assert.equal(count(sidebar, "<TenantSwitcher"), 1);
});

test("the tenant switcher keeps both labels mounted and lets CSS choose", () => {
  assert.equal(
    count(switcher, "{!railMode ?"),
    0,
    "the switcher must not swap markup when the sidebar collapses",
  );
  assert.equal(count(switcher, "ws-switcher-rail-label"), 2, "one for the card, one for the trigger");
  assert.match(switcher, /ws-switcher-trigger-text/);
});

test("the mobile drawer slides on the compositor, never on a layout property", () => {
  const mobile = css.slice(css.indexOf("@media (max-width: 1080px)"));
  const drawer = mobile.slice(0, mobile.indexOf(".nav-backdrop"));
  assert.match(drawer, /transition: transform var\(--nav-ease-dur\)/);
  assert.doesNotMatch(
    drawer,
    /transition:\s*left\b/,
    "animating `left` relaid out the drawer and the page behind it every frame",
  );
  assert.match(drawer, /transform: translate3d\(-100%, 0, 0\)/);
});

test("no per-link transition is declared on the sidebar", () => {
  // 72 links x a transitioned property = 72 transition objects built on the
  // frame the slide starts. Measured at 11ms of pure setup.
  assert.equal(
    count(css, ".console-nav.nav-rail .drawer-nav-icon"),
    0,
    "resizing every icon well between modes costs a frame; the well is one size now",
  );
  const iconRule = css.slice(css.indexOf(".drawer-nav-icon {"));
  const iconBody = iconRule.slice(0, iconRule.indexOf("}"));
  assert.doesNotMatch(iconBody, /\bwidth var\(--nav-ease-dur\)/);
});

test("the fixed-position desktop toasts live outside the sidebar", () => {
  // At mobile widths the sidebar carries a transform, and a transformed
  // ancestor makes a fixed descendant position against it — which would drag
  // the toast off-screen with the closed drawer.
  assert.equal(count(sidebar, "<DesktopUpdateToast"), 0);
  assert.equal(count(sidebar, "<DesktopShellBeacon"), 0);
  const shell = read("PageShell.tsx");
  assert.equal(count(shell, "<DesktopUpdateToast />"), 1);
  assert.equal(count(shell, "<DesktopShellBeacon />"), 1);
});


/**
 * The second half of this story. Removing the DOM rebuild above helped but did
 * not fix the stutter: on the owner's machine (Intel HD 4000 driving a 3440px
 * ultrawide) the collapse dropped 5-6 frames per toggle EVEN WITH THE ANIMATION
 * DELETED, because re-rendering the shell at a new sidebar width is what costs
 * ~200ms - not the animation. The fix is that the width changes once per toggle
 * and the motion is carried by a clip and a transform, neither of which lays
 * anything out. Measured after: 0-2 dropped frames, layout time down ~12x.
 */

const SHEET_NOTE = "THE SIDEBAR'S BOX AND THE SIDEBAR'S CONTENTS ARE DELIBERATELY SEPARATE";

function ruleBody(source: string, selector: string): string {
  const at = source.indexOf(selector);
  assert.ok(at !== -1, `selector not found: ${selector}`);
  const open = source.indexOf("{", at);
  return source.slice(open, source.indexOf("}", open));
}

test("the sidebar's width is never transitioned", () => {
  assert.ok(css.includes(SHEET_NOTE), "the sheet design note must survive edits");
  assert.doesNotMatch(
    ruleBody(css, SHEET_NOTE),
    /transition:[^;]*width/,
    "animating width forces a full layout every frame - that was the stutter",
  );
  assert.doesNotMatch(
    ruleBody(css, ".console-nav.nav-rail {"),
    /transition/,
  );
});

test("the sidebar's contents sit out of the layout path in a fixed-size sheet", () => {
  const body = ruleBody(css, ".nav-sheet {");
  assert.match(body, /position:\s*absolute/, "in-flow contents re-lay-out on every width change");
  assert.match(body, /width:\s*280px/, "the sheet must never resize with the panel");
  assert.equal(count(sidebar, 'className="nav-sheet"'), 1, "exactly one sheet wraps the sidebar");
});

test("the motion is a clip plus a transform, and the width moves once", () => {
  assert.match(css, /\.console-nav\.nav-gliding \.nav-sheet \{[^}]*transition:\s*clip-path/);
  assert.match(css, /\.console-workspace\.ws-gliding \{[^}]*transition:\s*transform/);
  const hook = read("../hooks/useSidebarGlide.ts");
  assert.match(hook, /void workspace\.offsetWidth/, "the forced commit is load-bearing - a rAF instead measured 5x worse");
  const shell = read("PageShell.tsx");
  assert.match(shell, /useSidebarGlide\(railMode/);
  assert.match(shell, /ref=\{workspaceRef\}/);
});

test("the rail edge lands in the gap, so no label is ever sliced in half", () => {
  // 10 nav padding + 3 link border + 6 link padding + 34 icon column + 15 gap
  // = 68, which is exactly the rail width.
  assert.match(ruleBody(css, ".console-nav.nav-rail {"), /width:\s*68px/);
  const link = ruleBody(css, "\n.drawer-nav-link {");
  assert.match(link, /grid-template-columns:\s*34px 1fr auto/);
  assert.match(link, /gap:\s*15px/);
});

test("no rail rule may relayout the sheet", () => {
  // The rail is the expanded sidebar with a clip over it. Anything inside that
  // changes size or position reintroduces the per-toggle reflow.
  const lines = css.split("\n").filter((l) => l.includes(".console-nav.nav-rail .") && l.trimEnd().endsWith("{"));
  assert.ok(lines.length > 0, "expected some rail rules to exist");
  for (const line of lines) {
    const body = ruleBody(css, line.trim());
    // An absolutely positioned element is out of flow, so resizing it cannot
    // reflow anything else - the rail badge and update chip are laid over the
    // icon that way on purpose.
    if (/position:\s*absolute/.test(body)) continue;
    // Likewise anything positioned by offsets is a popup laid over the sidebar
    // (the tenant switcher panel), not part of its flow.
    if (/(?:^|[^-\w])(?:left|top|right|bottom)\s*:/.test(body)) continue;
    assert.doesNotMatch(
      body,
      /(?:^|[^-\w])(?:padding|margin|width|height|display)\s*:/,
      `this rail rule relayouts the sheet: ${line.trim()}`,
    );
  }
});
