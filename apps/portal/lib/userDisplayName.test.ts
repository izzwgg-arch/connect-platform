import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPreferredUserDisplayName, getExtensionDisplayName, formatUserNameFallback } from "./userDisplayName";

/**
 * ⛔ Half of this reads SOURCE on purpose. The bug was that the main dashboard
 * rolled its OWN greeting off user.name + user.email and never looked at the
 * extension — while the sidebar right beside it, using the helper below, showed
 * the correct PBX name. A unit test of the helper passes straight through that.
 *
 * Audit: docs/ai-context/AGENT_HANDOFF_USER_NAMES_EMAIL_VS_PBX_2026-08-17.md
 */

test("the PBX name wins over the email address", () => {
  assert.equal(
    getPreferredUserDisplayName({ name: "eli", email: "eli@displaydex.com", extensionDisplayName: "Eli Lovi" }),
    "Eli Lovi",
  );
  assert.equal(
    getPreferredUserDisplayName({ name: "845luzerj", email: "845luzerj@gmail.com", extensionDisplayName: "Luzer Jungreis" }),
    "Luzer Jungreis",
  );
});

test("the extension number prefix never reaches the screen", () => {
  // Otherwise the headline reads "Welcome, 105".
  assert.equal(
    getPreferredUserDisplayName({ name: "fhalpert", email: "fhalpert@trustbookkeepingny.com", extensionDisplayName: "105 - Mrs. Halpert" }),
    "Mrs. Halpert",
  );
  assert.equal(getExtensionDisplayName("101- Mr. Sofer"), "Mr. Sofer");
  assert.equal(getExtensionDisplayName({ displayName: "106 - Miss Spilman" }), "Miss Spilman");
});

test("a department stays a department", () => {
  assert.equal(
    getPreferredUserDisplayName({ name: "sales", email: "sales@bvisible.us", extensionDisplayName: "Front Desk" }),
    "Front Desk",
  );
});

test("falls back to the email only when there is no extension", () => {
  assert.equal(getPreferredUserDisplayName({ name: null, email: "support@connectcomunications.com" }), "support");
  assert.equal(formatUserNameFallback(null, "vigdor@trustbookkeepingny.com"), "vigdor");
  assert.equal(getExtensionDisplayName(null), null);
  assert.equal(getExtensionDisplayName({ displayName: "   " }), null);
});

test("the MAIN DASHBOARD uses the shared helper and does not roll its own", () => {
  const src = readFileSync(join(__dirname, "..", "app", "(platform)", "dashboard", "page.tsx"), "utf8");
  assert.match(
    src,
    /import \{ getPreferredUserDisplayName \} from "\.\.\/\.\.\/\.\.\/lib\/userDisplayName"/,
    "the dashboard must import the shared helper",
  );
  assert.match(src, /getPreferredUserDisplayName\(user\)/, "the greeting must come from the helper");
  assert.doesNotMatch(
    src,
    /function firstName\(name: string \| null \| undefined, email: string \| null \| undefined\)/,
    "the local greeting resolver that ignored the extension must stay deleted",
  );
});

test("no portal screen cuts the resolved name down to its first word", () => {
  // ".split(' ')[0]" on the resolved name turns "Front Desk" into "Front" and
  // "Mrs. Halpert" into "Mrs." — the exact regression this fix exists to avoid.
  for (const rel of [
    ["app", "(platform)", "dashboard", "page.tsx"],
    ["components", "SidebarNav.tsx"],
    ["components", "ProfileMenu.tsx"],
  ]) {
    const src = readFileSync(join(__dirname, "..", ...rel), "utf8");
    assert.doesNotMatch(
      src,
      /getPreferredUserDisplayName\([^)]*\)[^;\n]*\.split\(/,
      `${rel.join("/")} must not split the resolved name`,
    );
  }
});
