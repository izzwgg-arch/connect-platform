/**
 * Carrier migration tests.
 *
 * The behavioural half drives the pure rules; the source guards read the
 * CALL SITES, because every defect this feature can have is a caller — a route
 * that touches a carrier it must not, a watcher that flips texting, a nav item
 * that is not owner-only. A unit test of any single function passes straight
 * through all of those.
 *
 * ⛔ Reads are CRLF-normalised: this worktree checks out .ts as CRLF under
 * Izzy's global core.autocrlf, and a literal "\n}" match silently finds
 * nothing on Windows while passing in CI.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  PROTECTED_DIDS,
  buildBoard,
  buildGates,
  carrierMigrationE164,
  decideClaim,
  decideSmsSwitch,
  explainClaim,
  explainSmsSwitch,
  formatDid,
  normalizeDid,
  stageLine,
} from "./board";

const ROOT = process.env.CM_GUARD_ROOT || join(__dirname, "..", "..", "..", "..");
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
}
/** Executable lines only — a negative assertion must never match a comment
 *  that quotes the very pattern it forbids (this trap has bitten repeatedly). */
function code(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
    .join("\n");
}

// ── The two number shapes ────────────────────────────────────────────────────

test("a number is normalised to bare 10 digits from every shape it arrives in", () => {
  assert.equal(normalizeDid("8453050012"), "8453050012");
  assert.equal(normalizeDid("+18453050012"), "8453050012");
  assert.equal(normalizeDid("18453050012"), "8453050012");
  assert.equal(normalizeDid("(845) 305-0012"), "8453050012");
  assert.equal(normalizeDid("845-305-0012"), "8453050012");
  assert.equal(normalizeDid("305-0012"), "");
  assert.equal(normalizeDid(null), "");
});

test("the E.164 conversion happens in one place and matches TenantSmsNumber's shape", () => {
  // PbxTenantInboundDid stores 8453050012; TenantSmsNumber stores +18453050012.
  assert.equal(carrierMigrationE164("8453050012"), "+18453050012");
  assert.equal(carrierMigrationE164("(845) 305-0012"), "+18453050012");
  assert.equal(carrierMigrationE164("nonsense"), "");
});

test("a number is formatted for reading, never for joining", () => {
  assert.equal(formatDid("8453050012"), "(845) 305-0012");
  assert.equal(formatDid("+18453050012"), "(845) 305-0012");
});

// ── Gates ────────────────────────────────────────────────────────────────────

const baseGateInput = {
  activeSmsRegistrations: 0,
  smsRegistrationsInFlight: 0,
  textingNumbers: 14,
  attestationGranted: false,
  voicePathReady: true,
  voicePathDetail: null,
};

test("with no 10DLC registration at all the texting gate is BLOCKED and says how many numbers it holds up", () => {
  const g = buildGates(baseGateInput).find((x) => x.id === "tendlc")!;
  assert.equal(g.level, "blocked");
  assert.match(g.detail, /14 of our numbers carry texting/);
});

test("a filed-but-unapproved registration reads as in progress, not approved", () => {
  const g = buildGates({ ...baseGateInput, smsRegistrationsInFlight: 1 }).find((x) => x.id === "tendlc")!;
  assert.equal(g.level, "pending");
});

test("an active registration clears the texting gate", () => {
  const g = buildGates({ ...baseGateInput, activeSmsRegistrations: 1 }).find((x) => x.id === "tendlc")!;
  assert.equal(g.level, "ok");
});

test("attestation is never reported as granted unless it actually is", () => {
  assert.equal(buildGates(baseGateInput).find((x) => x.id === "attestation")!.level, "pending");
  assert.equal(
    buildGates({ ...baseGateInput, attestationGranted: true }).find((x) => x.id === "attestation")!.level,
    "ok",
  );
});

test("an unreachable SignalWire blocks the voice gate and carries the reason", () => {
  const g = buildGates({ ...baseGateInput, voicePathReady: false, voicePathDetail: "no credentials" }).find(
    (x) => x.id === "voice",
  )!;
  assert.equal(g.level, "blocked");
  assert.equal(g.detail, "no credentials");
});

// ── The board ────────────────────────────────────────────────────────────────

const okGates = buildGates({ ...baseGateInput, activeSmsRegistrations: 1, attestationGranted: true });
const blockedGates = buildGates(baseGateInput);

function inv(did: string, tenantId: string, tenantName: string) {
  return { did, connectTenantId: tenantId, tenantName };
}
function sms(did: string, tenantId: string, provider = "VOIPMS") {
  return { phoneE164: carrierMigrationE164(did), provider, tenantId };
}

test("a number with no texting row reads 'none', never 'VoIP.ms'", () => {
  const b = buildBoard({
    inventory: [inv("8453050012", "t1", "Loopcom Demo 2")],
    migrations: [],
    smsNumbers: [],
    gates: okGates,
  });
  assert.equal(b.customers[0].numbers[0].sms, "none");
  assert.equal(b.customers[0].numbers[0].hasTexting, false);
});

test("the three lanes are tracked separately — calls can be moved while texting is not", () => {
  const b = buildBoard({
    inventory: [inv("3479780090", "t2", "Loopcom Demo")],
    migrations: [
      {
        did: "3479780090",
        status: "live",
        holdReason: null,
        voiceCarrier: "signalwire",
        smsCarrier: "voipms",
        portReference: null,
        focDate: null,
        filedAt: null,
        landedAt: null,
        pointedAt: null,
        smsFlippedAt: null,
        lastError: null,
        notes: null,
      },
    ],
    smsNumbers: [sms("3479780090", "t2")],
    gates: okGates,
  });
  const n = b.customers[0].numbers[0];
  assert.equal(n.voice, "signalwire");
  assert.equal(n.sms, "voipms", "texting must NOT be dragged along by the voice lane");
});

test("a number that texts is blocked while the texting registration is not approved", () => {
  const b = buildBoard({
    inventory: [inv("8457761765", "t3", "Relax Tires")],
    migrations: [],
    smsNumbers: [sms("8457761765", "t3")],
    gates: blockedGates,
  });
  const n = b.customers[0].numbers[0];
  assert.ok(n.blockers.some((x) => /texting is not registered/.test(x)));
  assert.match(n.stage, /^Blocked/);
});

test("a voice-only number is clear to file even when texting is unregistered", () => {
  const b = buildBoard({
    inventory: [inv("8456622530", "t4", "NY Garden Sprinkler")],
    migrations: [],
    smsNumbers: [],
    gates: blockedGates,
  });
  assert.deepEqual(b.customers[0].numbers[0].blockers, []);
  assert.equal(b.customers[0].numbers[0].stage, "Ready to file");
});

test("the platform's own numbers are flagged with the reason, not silently", () => {
  const did = Object.keys(PROTECTED_DIDS)[0];
  const b = buildBoard({
    inventory: [inv(did, "t5", "Connect Communications")],
    migrations: [],
    smsNumbers: [],
    gates: okGates,
  });
  const n = b.customers[0].numbers[0];
  assert.ok(n.protectedReason && n.protectedReason.length > 20);
  assert.ok(n.blockers.some((x) => /one of ours/.test(x)));
});

test("outbound is per customer and waits for every one of that customer's numbers", () => {
  const b = buildBoard({
    inventory: [inv("8452441708", "t6", "Trust"), inv("8452882280", "t6", "Trust")],
    migrations: [
      {
        did: "8452441708",
        status: "live",
        holdReason: null,
        voiceCarrier: "signalwire",
        smsCarrier: "voipms",
        portReference: null,
        focDate: null,
        filedAt: null,
        landedAt: null,
        pointedAt: null,
        smsFlippedAt: null,
        lastError: null,
        notes: null,
      },
    ],
    smsNumbers: [],
    gates: okGates,
  });
  assert.equal(b.customers[0].outbound.level, "pending");
  assert.match(b.customers[0].outbound.label, /Waiting on 1 more/);
});

test("outbound stays blocked while attestation is not granted, however many numbers moved", () => {
  const b = buildBoard({
    inventory: [inv("8456622530", "t7", "NY Garden")],
    migrations: [
      {
        did: "8456622530",
        status: "live",
        holdReason: null,
        voiceCarrier: "signalwire",
        smsCarrier: "voipms",
        portReference: null,
        focDate: null,
        filedAt: null,
        landedAt: null,
        pointedAt: null,
        smsFlippedAt: null,
        lastError: null,
        notes: null,
      },
    ],
    smsNumbers: [],
    gates: blockedGates,
  });
  assert.equal(b.customers[0].outbound.level, "blocked");
  assert.match(b.customers[0].outbound.detail, /labelled spam/);
});

test("the gap between landing and being pointed at us is measured in seconds", () => {
  const landed = new Date("2026-09-12T14:42:06Z");
  const pointed = new Date("2026-09-12T14:42:19Z");
  const b = buildBoard({
    inventory: [inv("8453050012", "t8", "Loopcom Demo 2")],
    migrations: [
      {
        did: "8453050012",
        status: "live",
        holdReason: null,
        voiceCarrier: "signalwire",
        smsCarrier: "voipms",
        portReference: null,
        focDate: null,
        filedAt: null,
        landedAt: landed,
        pointedAt: pointed,
        smsFlippedAt: null,
        lastError: null,
        notes: null,
      },
    ],
    smsNumbers: [],
    gates: okGates,
  });
  assert.equal(b.customers[0].numbers[0].claimSeconds, 13);
});

test("the summary counts each lane honestly", () => {
  const b = buildBoard({
    inventory: [inv("8453050012", "t1", "A"), inv("8457761765", "t2", "B"), inv("3479780090", "t3", "C")],
    migrations: [
      {
        did: "8453050012",
        status: "live",
        holdReason: null,
        voiceCarrier: "signalwire",
        smsCarrier: "voipms",
        portReference: null,
        focDate: null,
        filedAt: null,
        landedAt: null,
        pointedAt: null,
        smsFlippedAt: null,
        lastError: null,
        notes: null,
      },
      {
        did: "8457761765",
        status: "filed",
        holdReason: null,
        voiceCarrier: "voipms",
        smsCarrier: "voipms",
        portReference: "SW-1",
        focDate: null,
        filedAt: null,
        landedAt: null,
        pointedAt: null,
        smsFlippedAt: null,
        lastError: null,
        notes: null,
      },
    ],
    smsNumbers: [sms("8457761765", "t2")],
    gates: okGates,
  });
  assert.equal(b.summary.total, 3);
  assert.equal(b.summary.onSignalwire, 1);
  assert.equal(b.summary.moving, 1);
  assert.equal(b.summary.onVoipms, 2);
  assert.equal(b.summary.textingNumbers, 1);
});

test("the stage line is a sentence a person can act on, never a status code", () => {
  assert.equal(
    stageLine({ status: "held", blockers: [], holdReason: "overdue countdown", focDate: null, voice: "voipms" }),
    "Held back — overdue countdown",
  );
  assert.equal(
    stageLine({ status: "landing", blockers: [], holdReason: null, focDate: null, voice: "voipms" }),
    "Landing today — watching for it",
  );
  assert.match(
    stageLine({ status: "filed", blockers: [], holdReason: null, focDate: "2026-09-12T12:00:00Z", voice: "voipms" }),
    /^Filed — due Sep 12$/,
  );
});

// ── The two decisions that touch a carrier / a customer's texting ────────────

const filedRow = { status: "filed", pointedAt: null as Date | null };

test("the watcher claims a filed number the moment it is seen", () => {
  assert.deepEqual(decideClaim(filedRow, true), { claim: true });
});

test("the watcher IGNORES a number on the account that nobody filed", () => {
  // A test number, or one somebody bought by hand — we do not own the intent.
  const d = decideClaim({ status: "not_started", pointedAt: null }, true);
  assert.deepEqual(d, { claim: false, reason: "not_awaiting_arrival" });
});

test("the watcher never touches a held number, even when it lands", () => {
  assert.deepEqual(decideClaim({ status: "held", pointedAt: null }, true), { claim: false, reason: "held" });
});

test("the watcher never points the same number twice", () => {
  assert.deepEqual(decideClaim({ status: "landing", pointedAt: new Date() }, true), {
    claim: false,
    reason: "already_pointed",
  });
});

test("a number that has not arrived is left alone", () => {
  assert.deepEqual(decideClaim(filedRow, false), { claim: false, reason: "not_on_account_yet" });
});

test("texting will not move before the number has landed", () => {
  const d = decideSmsSwitch({ hasTexting: true, voice: "voipms", smsCarrier: "voipms", tendlcActive: true });
  assert.deepEqual(d, { switch: false, reason: "number_has_not_landed_yet" });
});

test("texting will not move while the registration is unapproved — the customer would lose outgoing texts", () => {
  const d = decideSmsSwitch({ hasTexting: true, voice: "signalwire", smsCarrier: "voipms", tendlcActive: false });
  assert.deepEqual(d, { switch: false, reason: "texting_not_registered" });
  assert.match(explainSmsSwitch(d.reason), /outgoing texts away/);
});

test("texting moves only when the number has landed AND the registration is approved", () => {
  assert.deepEqual(
    decideSmsSwitch({ hasTexting: true, voice: "signalwire", smsCarrier: "voipms", tendlcActive: true }),
    { switch: true },
  );
});

test("every refusal has a plain-English sentence — a screen must never show a slug", () => {
  for (const r of ["held", "not_awaiting_arrival", "already_pointed", "not_on_account_yet"]) {
    assert.ok(explainClaim(r).length > 15 && !explainClaim(r).includes("_"), r);
  }
  for (const r of ["no_texting_on_this_number", "already_on_signalwire", "number_has_not_landed_yet", "texting_not_registered"]) {
    assert.ok(explainSmsSwitch(r).length > 15 && !explainSmsSwitch(r).includes("_"), r);
  }
});

// ── Source guards ────────────────────────────────────────────────────────────

test("GUARD: marking a port filed never contacts a carrier", () => {
  const src = read("apps/api/src/carrierMigration/routes.ts");
  const start = src.indexOf('"/admin/carrier-migration/numbers/:did/filed"');
  const end = src.indexOf('app.post("/admin/carrier-migration/numbers/:did/claim"');
  assert.ok(start > 0 && end > start, "found the filed handler");
  const body = code(src.slice(start, end));
  for (const banned of ["updateNumberHandlers", "listNumbers", "purchaseNumber", "swRequest", "runCarrierMigrationSweep"]) {
    assert.ok(!body.includes(banned), `the filed route must not call ${banned} — SignalWire has no porting API`);
  }
});

test("GUARD: the arrival watcher never moves a customer's texting", () => {
  const body = code(read("apps/api/src/carrierMigration/arrivalWatcher.ts"));
  assert.ok(!body.includes("tenantSmsNumber"), "flipping TenantSmsNumber.provider on a timer would silently break outbound texting");
  assert.ok(!body.includes("SIGNALWIRE\""), "the watcher must not write a provider enum");
});

test("GUARD: the watcher asks decideClaim before touching a carrier", () => {
  const body = code(read("apps/api/src/carrierMigration/arrivalWatcher.ts"));
  const decision = body.indexOf("decideClaim(");
  const write = body.indexOf("updateNumberHandlers(");
  assert.ok(decision > 0 && write > decision, "the decision must come before the only carrier write");
});

test("GUARD: the claim button asks the same question the sweep asks", () => {
  const src = code(read("apps/api/src/carrierMigration/routes.ts"));
  const start = src.indexOf('"/admin/carrier-migration/numbers/:did/claim"');
  const body = src.slice(start, start + 1800);
  assert.ok(body.includes("decideClaim("), "a button must never do something the timer would refuse");
});

test("GUARD: moving texting is gated by decideSmsSwitch, never a bare update", () => {
  const src = code(read("apps/api/src/carrierMigration/routes.ts"));
  const start = src.indexOf('"/admin/carrier-migration/numbers/:did/sms-switch"');
  const end = src.indexOf('"/admin/carrier-migration/numbers/:did/notes"');
  assert.ok(start > 0 && end > start);
  const body = src.slice(start, end);
  assert.ok(body.indexOf("decideSmsSwitch(") < body.indexOf("tenantSmsNumber.update"), "gate before the write");
});

test("GUARD: every carrier-migration route is platform-owner only", () => {
  const src = code(read("apps/api/src/carrierMigration/routes.ts"));
  const registrations = src.split(/app\.(?:get|post)\("\/admin\/carrier-migration/).slice(1);
  assert.ok(registrations.length >= 7, `expected the full route set, saw ${registrations.length}`);
  for (const r of registrations) {
    assert.ok(r.includes("requireOwner(req, reply)"), "a route opened without requireOwner");
  }
});

test("GUARD: server.ts registers the routes, starts the watcher and gates the prefix", () => {
  const src = code(read("apps/api/src/server.ts"));
  assert.ok(src.includes("registerCarrierMigrationRoutes({"), "routes registered");
  assert.ok(src.includes("startCarrierMigrationWatch("), "watcher started");
  assert.ok(
    src.includes('{ prefix: "/admin/carrier-migration", permission: "can_manage_global_settings" }'),
    "a new /admin prefix with no rule sits outside the global gate entirely",
  );
});

test("GUARD: the nav item is owner-only in both places that decide it", () => {
  const nav = code(read("apps/portal/navigation/navConfig.ts"));
  assert.ok(nav.includes('id: "admin.carrier_migration"'), "nav item exists");
  assert.ok(
    nav.includes('item.id === "admin.carrier_migration" && backendJwtRole !== "SUPER_ADMIN"'),
    "force line missing — a granted key would open a door that changes a customer's carrier",
  );
  assert.ok(nav.includes('"admin.carrier_migration",'), "must be in OWNER_ONLY_FIXED_NAV_ITEMS so both permission editors mark it Locked");
});

test("GUARD: the permission key is in the shared catalog, or the editors silently drop it", () => {
  const shared = code(read("packages/shared/src/portalPermissions.ts"));
  assert.ok(shared.includes('permission: "can_view_admin_carrier_migration"'));
});

test("GUARD: the test file is registered in the runner, or none of this ever runs", () => {
  const pkg = read("apps/api/package.json");
  assert.ok(pkg.includes("src/carrierMigration/*.test.ts"), "unregistered tests protect nothing");
});
