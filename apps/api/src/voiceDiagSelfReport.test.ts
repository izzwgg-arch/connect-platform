/**
 * ⛔⛔ /voice/diag is a CLIENT SELF-REPORT surface and must never be gated on a
 * VIEWING permission again.
 *
 * On 2026-08-24 Gesheft ext 101 reported "I cant answer from the computer
 * anymore". Her softphone had generated THREE failure blackboxes in the ten
 * minutes before she gave up (09:20:02, 09:24:09, 09:26:05 ET) and every one was
 * answered 403, because PORTAL_API_PERMISSION_RULES gated the whole /voice/diag
 * prefix on `can_view_pbx_sbc_connectivity` — an admin diagnostics key an
 * ordinary USER does not hold. The payloads are gone. See
 * docs/ai-context/AGENT_HANDOFF_GESHEFT_101_WINDOWS_ANSWER_2026-08-24.md.
 *
 * The rule is now inverted: the /voice/diag default is OPEN (authenticated
 * only), and the two ADMIN READ paths are locked by name. That way a NEW
 * self-report route can never silently start refusing telemetry.
 *
 * ⛔ The cost of inverting the default is that a new *read* route under
 * /voice/diag would be open to any authenticated user. That is what these tests
 * exist to prevent: every `app.get("/voice/diag…")` in server.ts MUST resolve to
 * a non-null permission, and every `app.post` MUST resolve to null. A route that
 * is neither fails the build instead of leaking or going silent.
 *
 * ⛔ Reads are CRLF-normalised — the working tree is CRLF under Izzy's global
 * core.autocrlf=true and a literal \n pattern matches nothing there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// VOICE_DIAG_GUARD_SERVER lets this guard be replayed against another copy of
// server.ts (e.g. the pre-fix blob from HEAD) to prove it is non-vacuous —
// the DESKTOP_GUARD_ROOT / MOBILE_GUARD_PIPELINE pattern used elsewhere here.
// ⛔ Never `git stash` in this tree to do that: other sessions share it.
const SERVER = process.env.VOICE_DIAG_GUARD_SERVER || path.join(__dirname, "server.ts");
const src = readFileSync(SERVER, "utf8").replace(/\r\n/g, "\n");

/**
 * ⛔ Drop only WHOLE-LINE line-comments, so a rule quoted in a doc block cannot
 * satisfy an assertion.
 *
 * ⛔⛔ Do NOT run a block-comment stripper over server.ts. This repo already
 * records the trap: a regex literal in this file opens a fake block-comment and
 * the stripper swallows tens of thousands of lines, so the rules table silently
 * parses as EMPTY and every assertion passes for the wrong reason. It happened
 * again while writing this test — the rules block measured 90,906 chars and
 * contained no rules at all.
 */
const LINE_COMMENT = "//";
const code = src
  .split("\n")
  .filter((line) => !line.trim().startsWith(LINE_COMMENT))
  .join("\n");

/** The rules table, parsed out of the source exactly as the server declares it. */
function parseRules(): Array<{ prefix: string; permission: string | null }> {
  const start = code.indexOf("const PORTAL_API_PERMISSION_RULES");
  assert.ok(start > 0, "PORTAL_API_PERMISSION_RULES not found in server.ts");
  const end = code.indexOf("\n];", start);
  assert.ok(end > start, "could not find the end of PORTAL_API_PERMISSION_RULES");
  const block = code.slice(start, end);
  const out: Array<{ prefix: string; permission: string | null }> = [];
  const re = /\{\s*prefix:\s*"([^"]+)"\s*,\s*permission:\s*(?:"([^"]+)"|(null))\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) out.push({ prefix: m[1], permission: m[2] ?? null });
  return out;
}

/** Mirrors portalApiPermissionForPath: longest matching prefix wins. */
function permissionForPath(pathname: string): string | null {
  const rule = parseRules()
    .filter((e) => pathname === e.prefix || pathname.startsWith(`${e.prefix}/`))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  return rule ? rule.permission : null;
}

/** Every route declared under /voice/diag, with its HTTP method. */
function voiceDiagRoutes(): Array<{ method: string; path: string }> {
  const re = /app\.(get|post|put|patch|delete)\("(\/voice\/diag[^"]*)"/g;
  const out: Array<{ method: string; path: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) out.push({ method: m[1].toUpperCase(), path: m[2] });
  return out;
}

test("the /voice/diag routes are actually present in server.ts", () => {
  const routes = voiceDiagRoutes();
  assert.ok(routes.length >= 10, `expected the /voice/diag surface, found ${routes.length}`);
  assert.ok(routes.some((r) => r.method === "POST"), "no POST self-report routes found");
  assert.ok(routes.some((r) => r.method === "GET"), "no GET admin-read routes found");
});

test("⛔ every /voice/diag SELF-REPORT (POST) is authenticated-only — no permission gate", () => {
  const offenders = voiceDiagRoutes()
    .filter((r) => r.method === "POST")
    .map((r) => ({ ...r, permission: permissionForPath(r.path) }))
    .filter((r) => r.permission !== null);
  assert.deepEqual(
    offenders,
    [],
    "A client posting telemetry about its OWN device must not need a permission — " +
      "gating these is how three real failure reports were destroyed on 2026-08-24. " +
      `Offending: ${JSON.stringify(offenders)}`,
  );
});

test("⛔ every /voice/diag ADMIN READ (GET) still requires a permission", () => {
  const offenders = voiceDiagRoutes()
    .filter((r) => r.method === "GET")
    .map((r) => ({ ...r, permission: permissionForPath(r.path) }))
    .filter((r) => r.permission === null);
  assert.deepEqual(
    offenders,
    [],
    "The /voice/diag default is OPEN, so an admin read route must be locked BY NAME " +
      `or it is exposed to every authenticated user. Offending: ${JSON.stringify(offenders)}`,
  );
});

test("the admin read paths are locked to can_view_pbx_sbc_connectivity specifically", () => {
  assert.equal(permissionForPath("/voice/diag/sessions"), "can_view_pbx_sbc_connectivity");
  assert.equal(permissionForPath("/voice/diag/sessions/abc/events"), "can_view_pbx_sbc_connectivity");
  assert.equal(permissionForPath("/voice/diag/recent-errors"), "can_view_pbx_sbc_connectivity");
});

test("the self-report paths resolve to no permission", () => {
  for (const p of [
    "/voice/diag/session/start",
    "/voice/diag/session/heartbeat",
    "/voice/diag/event",
    "/voice/diag/call-quality-report",
    "/voice/diag/webrtc-sdp-debug",
    "/voice/diag/call-quality-ping",
    "/voice/diag/call-quality-ping/clear",
  ]) {
    assert.equal(permissionForPath(p), null, `${p} must be authenticated-only`);
  }
});

test("⛔ no /voice/diag self-report route may take identity from the request body", () => {
  // Removing the permission gate is only safe because every write scopes to the
  // token. If one of these ever reads a userId/tenantId out of the body it
  // becomes a cross-tenant write the moment it is unauthenticated-by-permission.
  const start = code.indexOf('app.post("/voice/diag/session/start"');
  const end = code.indexOf('app.get("/admin/voice/quality/live"');
  assert.ok(start > 0 && end > start, "could not slice the /voice/diag route block");
  const block = code.slice(start, end);
  assert.doesNotMatch(
    block,
    /z\s*\.\s*object\(\{[^}]*\b(userId|tenantId)\s*:/,
    "a /voice/diag write declares userId/tenantId in its body schema — identity must come from the token",
  );
  const posts = (block.match(/app\.post\("\/voice\/diag/g) || []).length;
  const users = (block.match(/getUser\(req\)/g) || []).length;
  assert.ok(users >= posts, `every /voice/diag write must call getUser(req) (posts=${posts}, getUser=${users})`);
});

test("⛔ granting can_view_pbx_sbc_connectivity is NOT the fix — it drives a sidebar item", () => {
  // Izzy, 2026-08-24: "grant it for everybody... don't let him see it in the
  // sidebar or anything." Granting the key would have done the opposite: it is
  // the permission behind the SBC Connectivity nav entry, and it would also have
  // unlocked the cross-session admin reads above. Recorded so nobody "simplifies"
  // this fix into a blanket grant later.
  const nav = readFileSync(
    path.join(__dirname, "..", "..", "..", "packages", "shared", "src", "portalPermissions.ts"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  assert.match(
    nav,
    /pbx\.sbc_connectivity[\s\S]{0,200}can_view_pbx_sbc_connectivity/,
    "expected can_view_pbx_sbc_connectivity to still back the SBC Connectivity nav item",
  );
});
