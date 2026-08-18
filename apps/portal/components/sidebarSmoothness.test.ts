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
  // The rail's 36px icon well is part of the original design and stays. What
  // must never come back is a TRANSITION on it: Chrome builds one transition
  // object per element, and across ~72 links that measured 11ms of pure setup
  // on the very frame the slide begins.
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
