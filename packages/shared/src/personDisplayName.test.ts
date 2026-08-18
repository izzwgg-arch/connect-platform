import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePersonDisplayName,
  resolvePersonGreetingName,
  stripExtensionNumberPrefix,
} from "./personDisplayName";

// Every case below is a REAL live row from the 2026-08-17 audit, not an
// invented example — see AGENT_HANDOFF_USER_NAMES_EMAIL_VS_PBX_2026-08-17.md.

test("the PBX name beats the email address", () => {
  assert.equal(
    resolvePersonDisplayName({ extensionDisplayName: "Eli Lovi", displayName: "eli", email: "eli@displaydex.com" }),
    "Eli Lovi",
  );
  assert.equal(
    resolvePersonDisplayName({ extensionDisplayName: "Luzer Jungreis", displayName: "845luzerj", email: "845luzerj@gmail.com" }),
    "Luzer Jungreis",
  );
  assert.equal(
    resolvePersonDisplayName({ extensionDisplayName: "Barish", displayName: "7816646", email: "7816646@gmail.com" }),
    "Barish",
  );
  assert.equal(
    resolvePersonDisplayName({ extensionDisplayName: "Nick Stefanicha", displayName: "nicholas", email: "nicholas@yossiswoodworx.com" }),
    "Nick Stefanicha",
  );
});

test("the PBX name beats a stored name too — it is the source of truth, not a fallback", () => {
  // Secro: displayName is a completely unrelated gmail handle, firstName/lastName
  // say "Gitty Openheim", the PBX says "Gitty". The PBX wins outright.
  assert.equal(
    resolvePersonDisplayName({
      extensionDisplayName: "Gitty",
      displayName: "myworksecro",
      firstName: "Gitty",
      lastName: "Openheim",
      email: "office@secrosolutions.com",
    }),
    "Gitty",
  );
});

test("a department name is kept as the person's name", () => {
  // Asked and answered 2026-08-17: if the PBX says Front Desk, it is Front Desk.
  assert.equal(
    resolvePersonDisplayName({ extensionDisplayName: "Front Desk", displayName: "sales", email: "sales@bvisible.us" }),
    "Front Desk",
  );
  assert.equal(
    resolvePersonDisplayName({ extensionDisplayName: "Hiring", displayName: "connect", email: "connect@gesheftkosher.com" }),
    "Hiring",
  );
  assert.equal(
    resolvePersonDisplayName({ extensionDisplayName: "Secretary", email: "smoothoffice1213@gmail.com" }),
    "Secretary",
  );
});

test("the extension NUMBER prefix is stripped, or the dashboard says 'Welcome, 105'", () => {
  assert.equal(stripExtensionNumberPrefix("105 - Mrs. Halpert"), "Mrs. Halpert");
  // 101 has no space before the dash — the real row, and the reason a stricter
  // pattern would miss it.
  assert.equal(stripExtensionNumberPrefix("101- Mr. Sofer"), "Mr. Sofer");
  assert.equal(stripExtensionNumberPrefix("106 - Miss Spilman"), "Miss Spilman");
  assert.equal(stripExtensionNumberPrefix("104 - Mrs. Schwartz"), "Mrs. Schwartz");
  assert.equal(stripExtensionNumberPrefix("107 - Mrs Pollak"), "Mrs Pollak");
  assert.equal(
    resolvePersonDisplayName({ extensionDisplayName: "105 - Mrs. Halpert", displayName: "fhalpert", email: "fhalpert@trustbookkeepingny.com" }),
    "Mrs. Halpert",
  );
});

test("stripping never eats a name that is only a number, or a real hyphen", () => {
  assert.equal(stripExtensionNumberPrefix("110"), "110");
  assert.equal(stripExtensionNumberPrefix("TEMP"), "TEMP");
  // Nothing but digits after the dash: not a "number - name" pair, leave it.
  assert.equal(stripExtensionNumberPrefix("24 - 7"), "24 - 7");
  assert.equal(stripExtensionNumberPrefix("Accounts Receivable"), "Accounts Receivable");
  assert.equal(stripExtensionNumberPrefix(""), "");
  assert.equal(stripExtensionNumberPrefix(null), "");
});

test("the name is never cut down to a first name", () => {
  // Splitting is what produced "Hi Mrs.," and "Hi Front," — both worse than the
  // full name. Greeting and display must agree, always.
  assert.equal(resolvePersonGreetingName({ extensionDisplayName: "105 - Mrs. Halpert" }), "Mrs. Halpert");
  assert.equal(resolvePersonGreetingName({ extensionDisplayName: "Front Desk" }), "Front Desk");
  assert.equal(
    resolvePersonGreetingName({ extensionDisplayName: "Lester Tan" }),
    resolvePersonDisplayName({ extensionDisplayName: "Lester Tan" }),
  );
});

test("initials-only stored names are skipped — this is the 'Hi s,' bug", () => {
  // No extension to fall back on, so the email local part must win over "e e".
  assert.equal(
    resolvePersonDisplayName({ firstName: "e", lastName: "l", email: "eli@displaydex.com" }),
    "eli",
  );
  assert.equal(
    resolvePersonDisplayName({ firstName: "y", lastName: "p", email: "yossi@yossiswoodworx.com" }),
    "yossi",
  );
  assert.equal(
    resolvePersonDisplayName({ firstName: "S.", lastName: "W.", email: "shia@trimprony.com" }),
    "shia",
  );
  // ...but a genuinely short real name is NOT initials.
  assert.equal(
    resolvePersonDisplayName({ firstName: "fix", lastName: "up", email: "fixupusa1@gmail.com" }),
    "fix up",
  );
});

test("falls back cleanly when there is no extension", () => {
  assert.equal(
    resolvePersonDisplayName({ displayName: "Pilot CRM Agent (13C)", email: "crm.pilot.agent.p13c@connect-internal.test" }),
    "Pilot CRM Agent (13C)",
  );
  assert.equal(resolvePersonDisplayName({ email: "support@connectcomunications.com" }), "support");
  assert.equal(resolvePersonDisplayName({}), "there");
  assert.equal(resolvePersonDisplayName({}, "User"), "User");
  // An address pasted into the name box is the email wearing a hat.
  assert.equal(
    resolvePersonDisplayName({ displayName: "someone@example.com", email: "someone@example.com" }),
    "someone",
  );
});

test("a new sign-up needs no special case — their typed name IS the extension name", () => {
  // onboarding/pbxTenantBuild.ts sets ext_name from the person the customer
  // typed, so the single PBX-first rule already returns what they entered.
  assert.equal(
    resolvePersonDisplayName({ extensionDisplayName: "Lester Tan", displayName: "Lester Tan", firstName: "Lester", lastName: "Tan", email: "lt@bvisible.us" }),
    "Lester Tan",
  );
});

test("whitespace and non-string junk never crash it", () => {
  assert.equal(resolvePersonDisplayName({ extensionDisplayName: "   Eli Lovi  " }), "Eli Lovi");
  assert.equal(resolvePersonDisplayName({ extensionDisplayName: "   ", displayName: "  eli " }), "eli");
  assert.equal(resolvePersonDisplayName({ extensionDisplayName: undefined, displayName: null, email: undefined }), "there");
});
