// The 443 route is the default for new tenants (owner's instruction,
// 2026-08-17). Three separate things have to hold for that to mean anything,
// and two of them are in CALLERS — a unit test of any single function passes
// straight through the failure, so these read the source.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const apiSrc = () => readFileSync(join(__dirname, "server.ts"), "utf8");
const syncSrc = () => readFileSync(join(__dirname, "pbxExtensionSync.ts"), "utf8");
const schema = () =>
  readFileSync(join(__dirname, "..", "..", "..", "packages", "db", "prisma", "schema.prisma"), "utf8");

test("a new tenant defaults to the 443 route", () => {
  const line = schema()
    .split("\n")
    .find((l) => l.includes("webrtcRouteViaSbc") && l.includes("@default"));
  assert.ok(line, "Tenant.webrtcRouteViaSbc must declare a default");
  assert.match(
    line!,
    /@default\(true\)/,
    "new tenants must route through Connect on 443 — filtered internet is the norm for this customer base",
  );
});

test("⛔ neither bootstrap path stamps a direct-to-PBX URL onto a 443 tenant", () => {
  // This is the whole reason the default works. resolveWebrtcConfig prefers an
  // explicit sipWsUrl over the flag, so a bootstrap that writes the 8089
  // endpoint would leave every new tenant reading `webrtcRouteViaSbc: true`
  // while actually dialling the PBX direct. PBX_WS_ENDPOINT IS set in
  // production, so this is live, not hypothetical.
  for (const [name, src] of [["server.ts", apiSrc()], ["pbxExtensionSync.ts", syncSrc()]] as const) {
    const stamps = src.match(/!tenantRow\.sipWsUrl[^?]*\?/g) || [];
    assert.equal(stamps.length, 1, `${name}: expected exactly one sipWsUrl bootstrap stamp`);
    assert.match(
      stamps[0],
      /!tenantRow\.webrtcRouteViaSbc/,
      `${name}: the sipWsUrl stamp must be skipped for tenants on the 443 route`,
    );
    assert.match(
      src,
      /select: \{[^}]*webrtcRouteViaSbc: true[^}]*\}/,
      `${name}: must SELECT webrtcRouteViaSbc, or the guard reads undefined and always passes`,
    );
  }
});

test("an explicit sipWsUrl still wins — which is why the guard above is load-bearing", () => {
  // If this ever stops being true the guard is redundant; if it silently
  // changes the other way, flipped tenants break. Pin the behaviour.
  const src = apiSrc();
  assert.match(
    src,
    /const sipWsUrl = normalizeSipWsUrlHost\(explicitSipWsUrl \|\| fallbackSipWsUrl, canonicalHost\)/,
    "resolveWebrtcConfig must still prefer an explicit tenant sipWsUrl",
  );
  assert.match(
    src,
    /tenant\?\.webrtcRouteViaSbc\s*\n?\s*\?\s*sipPublicWsUrl\(\)/,
    "the 443 fallback must come from sipPublicWsUrl()",
  );
});

test("the migration only changes the DEFAULT, never existing tenants", () => {
  const sql = readFileSync(
    join(__dirname, "..", "..", "..", "packages", "db", "prisma", "migrations",
      "20260817230000_default_sip_route_via_443", "migration.sql"),
    "utf8",
  );
  assert.match(sql, /ALTER COLUMN "webrtcRouteViaSbc" SET DEFAULT true/);
  // Moving a live tenant forces its users to sign out and back in before the
  // app picks up the new address. That is a decision, not a migration.
  assert.doesNotMatch(sql, /UPDATE\s+"Tenant"/i, "must not rewrite existing tenants");
});
