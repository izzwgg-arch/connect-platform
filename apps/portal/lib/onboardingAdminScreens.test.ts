import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards on the Admin → Onboarding screens.
 *
 * These read the SOURCE rather than rendering, because every defect they guard
 * against is invisible to a behavioural test of any one component: a stylesheet
 * that leaks out of its own screen, a class name that collides with globals.css,
 * and a page that stops carrying the ported look at all.
 *
 * ⛔ Files are read CRLF-normalised — this tree is checked out CRLF under
 * Izzy's global core.autocrlf, and a multi-line pattern silently matches
 * nothing otherwise.
 */

const ADMIN = join(__dirname, "..", "app", "(platform)", "admin", "onboarding");
const read = (...p: string[]) => readFileSync(join(ADMIN, ...p), "utf8").replace(/\r\n/g, "\n");

const css = () => read("onboarding-admin.css");
/** ⛔ Comments MUST be stripped before any negative match: this sheet's header
 *  deliberately names `.tab`, `.tabs` and the `.ob-` prefix while explaining
 *  why they were renamed away, so a naive scan reports them as live offenders. */
const cssCode = () => css().replace(/\/\*[\s\S]*?\*\//g, "");
const listPage = () => read("page.tsx");
const storyPage = () => read("[id]", "page.tsx");
const patternsPage = () => read("patterns", "page.tsx");

/** Selector lines only — comments and declarations are not selectors. */
function selectorLines(sheet: string): string[] {
  return sheet
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("{") && !l.startsWith("*") && !l.startsWith("/*") && !l.startsWith("//"))
    .map((l) => l.split("{")[0].trim())
    .filter((l) => l.length > 0 && !l.startsWith("@"));
}

// ⛔ globals.css already defines .tab and .tabs. The mock-up used both, so an
// unscoped port would have restyled screens nobody was looking at.
test("every rule is scoped to .oi-root, so nothing can leak into the rest of the portal", () => {
  const offenders = selectorLines(cssCode()).filter((sel) =>
    sel
      .split(",")
      .map((s) => s.trim())
      .some((s) => s.length > 0 && !s.startsWith(".oi-root") && !s.includes(".oi-root")),
  );
  assert.deepEqual(offenders, [], `these selectors escape the screen: ${offenders.join(" | ")}`);
});

test("every class in the sheet carries the oi- prefix", () => {
  const names = new Set((cssCode().match(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g) || []).map((c) => c.slice(1)));
  const bare = [...names].filter((n) => !n.startsWith("oi-"));
  assert.deepEqual(bare, [], `unprefixed classes can collide with globals.css: ${bare.join(", ")}`);
});

// ⛔ THE COLLISION THIS CAUGHT FOR REAL. Renaming the mock-up's `.ob-act.link`
// and `.ob-link` mechanically collapsed both onto `.oi-link`, so an "Open"
// action inherited the URL box's flex:1, mono font and panel background.
test("the quiet action and the link display box stay different classes", () => {
  const sheet = cssCode();
  assert.ok(!sheet.includes(".oi-act.oi-link "), "an action must not inherit the URL-box styling");
  assert.ok(sheet.includes(".oi-act.oi-act-quiet"), "the quiet action variant exists under its own name");
  for (const page of [listPage(), storyPage()]) {
    assert.ok(!/oi-act oi-link\b/.test(page), "no page may put both classes on one element");
  }
});

// ⛔ Connect theme tokens only. Bare :root is DARK and light is the opt-in
// override — a screen that themes off the OS disagrees with the app's own
// light/dark switch, which is the billing-slab bug.
test("the screens theme off Connect's tokens, never the operating system", () => {
  const sheet = cssCode();
  assert.ok(!sheet.includes("prefers-color-scheme"), "the app's own theme decides, not the OS");
  assert.ok(sheet.includes("var(--panel)") && sheet.includes("var(--border)") && sheet.includes("var(--text-dim)"));
});

// ⛔ --success / --warning / --danger are DISPLAY colours: as small text on the
// light panel they measure 2.15-3.76:1 and are unreadable. Fills keep the
// display colour; text takes the darkened ink.
test("status TEXT uses the readable ink, not the raw display colour", () => {
  const sheet = cssCode();
  assert.ok(sheet.includes(':root[data-theme="light"] .oi-root'), "light-mode ink overrides exist");
  for (const ink of ["--oi-ink-good", "--oi-ink-warn", "--oi-ink-stop", "--oi-ink-accent"]) {
    assert.ok(sheet.includes(`${ink}: #`), `${ink} must be darkened for the light panel`);
  }
  // ⛔ The lookbehind is load-bearing: without it this also matches the tail of
  // `border-color: var(--warning)`, which is CORRECT usage — borders and fills
  // are exactly where the display colour belongs. The first version of this
  // guard reported 14 false failures for that reason.
  const colourAsText = sheet.match(/(?<![-\w])color: var\(--(success|warning|danger)\)/g) || [];
  assert.deepEqual(colourAsText, [], "a display colour must never be used as small text");
  assert.ok(/border-color: var\(--warning\)/.test(sheet), "...while borders SHOULD use it, so the guard is not vacuous");
});

test("all three screens are wired to the ported stylesheet", () => {
  assert.ok(listPage().includes('import "./onboarding-admin.css"'));
  assert.ok(storyPage().includes('import "../onboarding-admin.css"'));
  assert.ok(patternsPage().includes('import "../onboarding-admin.css"'));
  for (const page of [listPage(), storyPage(), patternsPage()]) {
    assert.ok(page.includes('className="oi-root"'), "each screen roots the scoped styles");
  }
});

// ⛔ Sending must never hide the link: plenty of these customers are easier to
// reach on WhatsApp than by email, and that was Izzy's explicit ask.
test("the confirmation still shows the link with a Copy button after sending", () => {
  const page = listPage();
  assert.ok(page.includes("Invitation sent to"));
  assert.ok(page.includes("oi-linkrow"), "the link row survives the send");
  assert.ok(page.includes("rather text it to them"), "and says why it is still there");
  assert.ok(page.includes("Just make me a link"), "the link-only path is a first-class button");
});

test("the warning about an address that already has a login is on the screen", () => {
  const page = listPage();
  assert.ok(page.includes("email-check"), "it asks before the admin commits");
  assert.ok(page.includes("already has a Loopcom login"));
  assert.ok(page.includes("setTaken(null); // never block sending over a failed check"));
});

// ⛔ The two lanes exist because they were jumbled into one list before, where
// reading either meant skipping past the other.
test("the story screen keeps the customer's steps and our provisioning apart", () => {
  const page = storyPage();
  assert.ok(page.includes("What the customer did"));
  assert.ok(page.includes("What we did"));
  assert.ok(page.includes("Everything, raw"));
  assert.ok(page.includes("story.csv"), "the raw story can be exported for analysing later");
});

test("no screen prints a raw status enum at a person", () => {
  for (const page of [listPage(), storyPage()]) {
    assert.ok(!/>\{[a-z]*\.?status\}</.test(page), "statuses are turned into words before they are rendered");
  }
});
