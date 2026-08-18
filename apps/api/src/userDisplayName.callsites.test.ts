import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ⛔ This reads SOURCE on purpose. The 2026-08-17 defect was never in the naming
 * function — it was in its CALLERS: queries that never fetched the extension, and
 * email templates handed the raw `firstName` column. A unit test of
 * `displayNameForUser` passes straight through every one of those bugs.
 *
 * Audit: docs/ai-context/AGENT_HANDOFF_USER_NAMES_EMAIL_VS_PBX_2026-08-17.md
 */

// Normalise line endings: core.autocrlf=true checks these files out as CRLF on
// Windows, and the "\n}\n" slice below would otherwise never match there.
const readSrc = (...p: string[]) => readFileSync(join(__dirname, ...p), "utf8").replace(/\r\n/g, "\n");
const serverSrc = readSrc("server.ts");
const orchestratorSrc = readSrc("onboarding", "setupOrchestrator.ts");

test("the naming rule is the SHARED one, never a local reimplementation", () => {
  assert.match(
    serverSrc,
    /import \{[^}]*resolvePersonDisplayName[^}]*\} from "@connect\/shared"/,
    "apps/api must use the shared naming rule so it cannot drift from the portal",
  );
  assert.match(
    serverSrc,
    /function displayNameForUser\([\s\S]{0,600}?resolvePersonDisplayName\(/,
    "displayNameForUser must delegate to the shared rule",
  );
});

test("displayNameForUser accepts the PBX extension — it cannot prefer what it never receives", () => {
  const fn = serverSrc.slice(serverSrc.indexOf("function displayNameForUser("));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
  assert.match(body, /ownedExtensions\?\.\[0\]\?\.displayName/, "must read the owned extension");
  assert.match(body, /extensionDisplayName:/, "must pass the extension name into the shared rule");
});

test("EVERY customer email resolves the name through resolveUserNameForEmail", () => {
  // The four templates Connect sends to a human being.
  for (const marker of [
    "welcomeCreatePasswordEmail({",
    "passwordCreatedConfirmationEmail({",
    "passwordResetEmail({",
    "passwordChangedEmail({",
  ]) {
    const at = serverSrc.indexOf(marker);
    assert.notEqual(at, -1, `${marker} should still exist`);
    const window = serverSrc.slice(Math.max(0, at - 400), at + 400);
    assert.match(
      window,
      /resolveUserNameForEmail\(/,
      `${marker} must resolve the name through resolveUserNameForEmail — otherwise it addresses people by their email address`,
    );
  }
});

test("no email passes the raw firstName column as the greeting", () => {
  // `firstName:"e"` / `lastName:"l"` (Eli Lovi) is real live data, and passing it
  // straight through is what sent invitations reading "Hi e," and "Hi s,".
  assert.doesNotMatch(
    serverSrc,
    /userFirstName:\s*String\(input\.user\.firstName/,
    "userFirstName must come from the resolved name, not the raw column",
  );
  assert.doesNotMatch(
    orchestratorSrc,
    /userFirstName:\s*String\(input\.user\.firstName/,
    "the onboarding invite must not pass the raw firstName column either",
  );
});

test("the onboarding invite uses the same rule, with no sign-up-specific branch", () => {
  assert.match(
    orchestratorSrc,
    /import \{ resolvePersonDisplayName \} from "@connect\/shared"/,
    "onboarding must share the rule — a new customer's typed name IS their extension name",
  );
  assert.match(orchestratorSrc, /extensionDisplayName:/, "onboarding must feed the extension in");
  assert.doesNotMatch(
    orchestratorSrc,
    /const userName =\s*\n?\s*String\(input\.user\.displayName \|\| ""\)\.trim\(\) \|\|/,
    "the old local name chain must be gone",
  );
});

test("the naming queries actually select the extension", () => {
  // /me, the login JWT, the invite + reset validate screens and the tenant-user
  // dropdown all render a name. Each needs the extension in its own query.
  const requiredWindows = [
    { marker: 'app.get("/me"', label: "/me" },
    { marker: "const namingExtension = await db.extension", label: "login JWT" },
    { marker: 'app.get("/pbx/tenant-users"', label: "tenant-users dropdown" },
  ];
  for (const { marker, label } of requiredWindows) {
    const at = serverSrc.indexOf(marker);
    assert.notEqual(at, -1, `${label}: anchor "${marker}" not found`);
    const window = serverSrc.slice(at, at + 2200);
    assert.match(
      window,
      /ownedExtensions|db\.extension\s*\n?\s*\.findFirst/,
      `${label} must fetch the extension, or it silently falls back to the email address`,
    );
  }
});

test("a name lookup can never break an invitation", () => {
  // ⛔ It must be a try/catch, NOT a promise `.catch()`. When the model accessor
  // is missing the call throws SYNCHRONOUSLY, so `.catch` never runs and the
  // invitation dies with it — which is exactly what the onboarding suite caught.
  for (const [src, marker, label] of [
    [serverSrc, "async function resolveUserNameForEmail(", "resolveUserNameForEmail"],
    [orchestratorSrc, "let namingExtension", "onboarding invite"],
  ] as const) {
    const at = src.indexOf(marker);
    assert.notEqual(at, -1, `${label}: anchor not found`);
    const body = src.slice(at, at + 1400);
    assert.match(body, /try \{[\s\S]*?\} catch/, `${label} must wrap the lookup in try/catch`);
    assert.match(body, /extension\?\.findFirst\?\./, `${label} must call the model defensively`);
  }
});
