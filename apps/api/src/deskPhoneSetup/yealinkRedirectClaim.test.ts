/**
 * `ensureYealinkRedirect` — the office wizard's own best-effort RPS claim, driven with
 * a fake `db` and a spy in place of `ManagedPhoneService`. The real writer
 * (`ManagedPhoneService.claimForOfficeWizard`) is proven separately in
 * `managedPhoneIntegration.test.ts`; this file proves the HOOK: which preconditions
 * skip before any network call, the cooldown, what each outcome writes onto the
 * `DeskPhoneSetupPhone` row, and that it never throws into its caller.
 *
 * Run with: node --experimental-test-module-mocks --import tsx --test
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { YealinkRedirectDeps, YealinkRedirectPhone } from "./yealinkRedirectClaim";

// ⛔ `yealinkRedirectClaim.ts` imports `db` from `@connect/db` at module load — the
// same lazy mock.module + require() pattern every other test in this directory uses,
// so importing it never touches a real Prisma client. Every test here passes its
// own `deps.db` anyway; this default is exercised only if a future call site forgets to.
mock.module("@connect/db", { namedExports: { db: {} } });
const { ensureYealinkRedirect } = require("./yealinkRedirectClaim");
const { DeviceError } = require("./yealinkRps");

const REDIRECT = "https://loopcom.net/phoneprov/0123456789abcdef/";
const user = { tenantId: "t1", sub: "u1" };

function fakeDb() {
  const updates: any[] = [];
  return {
    updates,
    deskPhoneSetupPhone: {
      update: async ({ where, data }: any) => { updates.push({ where, data }); return { id: where.id, ...data }; },
    },
  };
}

const SERIAL = "2142019121401463";

function basePhone(over: Partial<YealinkRedirectPhone> = {}): YealinkRedirectPhone {
  return {
    id: "phone-1", macAddress: "805ec0112233", vendor: "yealink", model: "T53W",
    extensionId: "ext-1", serialNumber: SERIAL, ipAddress: "192.168.1.5",
    skippedAt: null, state: "ASSIGNED", customerNote: null,
    vendorCloudState: null, vendorCloudCheckedAt: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  };
}

type Claim = { actor: unknown; input: any; requestId: string };

function harness(over: Partial<YealinkRedirectDeps & { claimResult: unknown }> = {}) {
  const audits: any[] = [];
  const db = fakeDb();
  const claims: Claim[] = [];
  const deps: YealinkRedirectDeps = {
    provisioningUrlFor: async () => REDIRECT,
    requesterIp: () => "203.0.113.9",
    audit: async (p: any) => { audits.push(p); },
    db,
    managedPhoneService: {
      claimForOfficeWizard: async (actor: any, input: any, requestId: string) => {
        claims.push({ actor, input, requestId });
        return { id: "mdp-1", rpsState: "assigned", lastError: null, conflict: false };
      },
    },
    ...over,
  };
  return { deps, db, audits, claims };
}

/* ── preconditions skip without a call ─────────────────────────────────────── */

test("skips without a call: not a Yealink", async () => {
  const { deps, claims } = harness();
  const out = await ensureYealinkRedirect(basePhone({ vendor: "grandstream" }), user, {}, deps);
  assert.deepEqual(out, { skipped: "not_yealink" });
  assert.equal(claims.length, 0);
});

test("skips without a call: the phone was left out of the setup", async () => {
  const { deps, claims } = harness();
  const out = await ensureYealinkRedirect(basePhone({ skippedAt: new Date() }), user, {}, deps);
  assert.deepEqual(out, { skipped: "phone_skipped" });
  assert.equal(claims.length, 0);
});

test("skips without a call: no extension assigned yet", async () => {
  const { deps, claims } = harness();
  const out = await ensureYealinkRedirect(basePhone({ extensionId: null }), user, {}, deps);
  assert.deepEqual(out, { skipped: "no_extension" });
  assert.equal(claims.length, 0);
});

test("skips without a call: no serial on file yet", async () => {
  const { deps, claims } = harness();
  const out = await ensureYealinkRedirect(basePhone({ serialNumber: null }), user, {}, deps);
  assert.deepEqual(out, { skipped: "no_serial" });
  assert.equal(claims.length, 0);
});

test("skips without a call: no model named yet", async () => {
  const { deps, claims } = harness();
  const out = await ensureYealinkRedirect(basePhone({ model: null }), user, {}, deps);
  assert.deepEqual(out, { skipped: "no_model" });
  assert.equal(claims.length, 0);
});

test("skips without a call: a model this catalogue does not manage", async () => {
  const { deps, claims } = harness();
  const out = await ensureYealinkRedirect(basePhone({ model: "SIP-NOT-A-REAL-MODEL" }), user, {}, deps);
  assert.deepEqual(out, { skipped: "model_not_managed" });
  assert.equal(claims.length, 0);
});

test("skips without a call: no provisioning folder resolvable for this tenant", async () => {
  const { deps, claims } = harness({ provisioningUrlFor: async () => null });
  const out = await ensureYealinkRedirect(basePhone(), user, {}, deps);
  assert.deepEqual(out, { skipped: "no_provisioning_folder" });
  assert.equal(claims.length, 0);
});

/* ── cooldown ───────────────────────────────────────────────────────────────── */

test("cooldown: a repeated check inside 60s with nothing changed is skipped", async () => {
  const { deps, claims } = harness();
  const checkedAt = new Date();
  const phone = basePhone({ vendorCloudState: "unavailable", vendorCloudCheckedAt: checkedAt, updatedAt: new Date(checkedAt.getTime() - 5_000) });
  const out = await ensureYealinkRedirect(phone, user, {}, deps);
  assert.deepEqual(out, { skipped: "cooldown" });
  assert.equal(claims.length, 0);
});

test("cooldown: a managed phone with nothing changed is never re-claimed, cooldown window or not", async () => {
  const { deps, claims } = harness();
  const old = new Date(Date.now() - 10 * 60_000);
  const phone = basePhone({ vendorCloudState: "managed", vendorCloudCheckedAt: old, updatedAt: old });
  const out = await ensureYealinkRedirect(phone, user, {}, deps);
  assert.deepEqual(out, { skipped: "already_managed" });
  assert.equal(claims.length, 0);
});

test("cooldown: the row changing since the last check bypasses the throttle", async () => {
  const { deps, claims } = harness();
  const checkedAt = new Date(Date.now() - 5_000);
  const phone = basePhone({ vendorCloudState: "unavailable", vendorCloudCheckedAt: checkedAt, updatedAt: new Date() });
  const out = await ensureYealinkRedirect(phone, user, {}, deps);
  assert.ok("ok" in out && out.ok);
  assert.equal(claims.length, 1);
});

test("cooldown: the very first check (no vendorCloudCheckedAt yet) is never throttled", async () => {
  const { deps, claims } = harness();
  const out = await ensureYealinkRedirect(basePhone({ vendorCloudCheckedAt: null, updatedAt: null }), user, {}, deps);
  assert.ok("ok" in out && out.ok);
  assert.equal(claims.length, 1);
});

/* ── what each outcome writes ──────────────────────────────────────────────── */

test("passes the resolved redirect URL and the presence pair through to the claim", async () => {
  const { deps, claims } = harness();
  const phone = basePhone({ ipAddress: "192.168.9.9" });
  const out = await ensureYealinkRedirect(phone, user, { headers: {} }, deps);
  assert.deepEqual(out, { ok: true, state: "managed" });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].input.mac, phone.macAddress);
  assert.equal(claims[0].input.redirectUrl, REDIRECT);
  assert.deepEqual(claims[0].input.presence, { discoveredIp: "192.168.9.9", requesterIp: "203.0.113.9" });
  assert.equal(claims[0].requestId, "office-wizard-phone-1");
});

test("managed: writes vendorCloudState=managed and audits DESK_PHONE_VENDOR_REDIRECT_CLAIMED", async () => {
  const { deps, db, audits } = harness();
  await ensureYealinkRedirect(basePhone(), user, {}, deps);
  const write = db.updates.at(-1);
  assert.equal(write.data.vendorCloudState, "managed");
  assert.ok(write.data.vendorCloudCheckedAt instanceof Date);
  const audit = audits.find((a) => a.action === "DESK_PHONE_VENDOR_REDIRECT_CLAIMED");
  assert.ok(audit);
  assert.equal(audit.metadata.serialTail, `…${SERIAL.slice(-4)}`);
  // ⛔ Never the real serial or a password.
  assert.ok(!JSON.stringify(audit).includes(SERIAL));
});

test("conflict: writes the customer-safe note, the technical note, and audits the conflict", async () => {
  const { deps, db, audits } = harness({
    managedPhoneService: { claimForOfficeWizard: async () => ({ id: "mdp-1", rpsState: "conflict", lastError: "rps_ownership_conflict", conflict: true }) },
  });
  const out = await ensureYealinkRedirect(basePhone(), user, {}, deps);
  assert.deepEqual(out, { ok: true, state: "conflict" });
  const write = db.updates.at(-1);
  assert.equal(write.data.vendorCloudState, "conflict");
  assert.match(write.data.customerNote, /previous provider/i);
  assert.doesNotMatch(write.data.customerNote, /RPS|YMCS|Yealink's cloud API/i, "no jargon beyond the maker's own name");
  assert.match(write.data.technicalNote, /yealink_rps_conflict mac=805ec0112233/);
  assert.match(write.data.technicalNote, /mac-removal\.html/);
  assert.ok(!write.data.technicalNote.includes(SERIAL), "never the full serial");
  const audit = audits.find((a) => a.action === "DESK_PHONE_VENDOR_REDIRECT_CONFLICT");
  assert.ok(audit);
  assert.equal(audit.metadata.rpsState, "conflict");
  assert.equal(audit.metadata.code, "rps_ownership_conflict");
});

test("conflict: never overwrites a note the halt ladder set for its own, more specific reason", async () => {
  const { deps, db } = harness({
    managedPhoneService: { claimForOfficeWizard: async () => ({ id: "x", rpsState: "conflict", lastError: "rps_ownership_conflict", conflict: true }) },
  });
  const phone = basePhone({ state: "NEEDS_ATTENTION", customerNote: "Loopcom Support can finish this one with you." });
  await ensureYealinkRedirect(phone, user, {}, deps);
  const write = db.updates.at(-1);
  assert.equal(write.data.customerNote, undefined, "the halt's own note is left untouched");
  assert.equal(write.data.technicalNote, undefined);
  assert.equal(write.data.vendorCloudState, "conflict", "the state itself still records the conflict");
});

test("managed: clears a previous conflict note of our own once the cloud confirms we hold it", async () => {
  const { deps, db } = harness();
  const phone = basePhone({
    customerNote: "Yealink's cloud still lists this phone under its previous provider, so it can't be set up from anywhere yet. "
      + "Loopcom will ask Yealink to release it. Restarting the phone on your office network still sets it up.",
  });
  await ensureYealinkRedirect(phone, user, {}, deps);
  const write = db.updates.at(-1);
  assert.equal(write.data.customerNote, null);
  assert.equal(write.data.technicalNote, null);
});

test("managed: leaves an UNRELATED customer note alone", async () => {
  const { deps, db } = harness();
  const phone = basePhone({ customerNote: "Something else entirely." });
  await ensureYealinkRedirect(phone, user, {}, deps);
  const write = db.updates.at(-1);
  assert.equal(write.data.customerNote, undefined);
});

test("unavailable: pending_credentials (RPS disabled) writes vendorCloudState=unavailable, no notes touched", async () => {
  const { deps, db, audits } = harness({
    managedPhoneService: { claimForOfficeWizard: async () => ({ id: "mdp-1", rpsState: "pending_credentials", lastError: null, conflict: false }) },
  });
  const out = await ensureYealinkRedirect(basePhone(), user, {}, deps);
  assert.deepEqual(out, { ok: true, state: "unavailable" });
  const write = db.updates.at(-1);
  assert.equal(write.data.vendorCloudState, "unavailable");
  assert.equal(write.data.customerNote, undefined);
  assert.ok(audits.find((a) => a.action === "DESK_PHONE_VENDOR_REDIRECT_FAILED"));
});

/* ── never throws ───────────────────────────────────────────────────────────── */

test("never throws: a rejecting claim resolves as unavailable instead of rejecting", async () => {
  const { deps } = harness({
    managedPhoneService: { claimForOfficeWizard: async () => { throw new DeviceError("rps_service_unavailable", 503); } },
  });
  await assert.doesNotReject(ensureYealinkRedirect(basePhone(), user, {}, deps));
  const out = await ensureYealinkRedirect(basePhone(), user, {}, deps);
  assert.deepEqual(out, { ok: true, state: "unavailable" });
});

test("never throws: a failing provisioningUrlFor resolves as a skip, never a rejection", async () => {
  const { deps } = harness({ provisioningUrlFor: async () => { throw new Error("pbx unreachable"); } });
  await assert.doesNotReject(ensureYealinkRedirect(basePhone(), user, {}, deps));
  assert.deepEqual(await ensureYealinkRedirect(basePhone(), user, {}, deps), { skipped: "no_provisioning_folder" });
});

test("never throws: a failing audit never undoes an already-recorded claim", async () => {
  const { deps, db } = harness({ audit: async () => { throw new Error("audit db down"); } });
  await assert.doesNotReject(ensureYealinkRedirect(basePhone(), user, {}, deps));
  assert.equal(db.updates.at(-1).data.vendorCloudState, "managed", "the write still landed");
});

test("never throws: a failing db write is swallowed, not propagated", async () => {
  const { deps } = harness({ db: { deskPhoneSetupPhone: { update: async () => { throw new Error("db down"); } } } });
  await assert.doesNotReject(ensureYealinkRedirect(basePhone(), user, {}, deps));
});

/* ── the halt's note always wins (live, 2026-09-17) ───────────────────────── */

test("conflict: never overwrites the note of a phone the ladder halted after the snapshot was taken", async () => {
  // The caller passed an ASSIGNED snapshot (a /retry had just happened); by the time the
  // RPS round trip finished, advance had halted the phone with "hold OK ~10 s".
  const { deps, db } = harness({
    managedPhoneService: { claimForOfficeWizard: async () => ({ id: "mdp-1", rpsState: "conflict", lastError: "rps_ownership_conflict", conflict: true }) },
  });
  (db as any).deskPhoneSetupPhone.findUnique = async () => ({
    state: "NEEDS_ATTENTION", haltedReason: "support", customerNote: "No problem — hold its OK button for about 10 seconds…",
  });
  const out = await ensureYealinkRedirect(basePhone({ state: "ASSIGNED", customerNote: null }), user, {}, deps);
  assert.deepEqual(out, { ok: true, state: "conflict" });
  const write = db.updates.at(-1)!;
  assert.equal(write.data.vendorCloudState, "conflict", "the cloud word still lands");
  assert.equal("customerNote" in write.data, false, "the halt's instruction was overwritten");
  assert.equal("technicalNote" in write.data, false);
});

test("conflict: never overwrites a note somebody else wrote, only an empty one or our own", async () => {
  const { deps, db } = harness({
    managedPhoneService: { claimForOfficeWizard: async () => ({ id: "mdp-1", rpsState: "conflict", lastError: "rps_ownership_conflict", conflict: true }) },
  });
  (db as any).deskPhoneSetupPhone.findUnique = async () => ({ state: "ASSIGNED", haltedReason: null, customerNote: "Some other, more specific sentence." });
  await ensureYealinkRedirect(basePhone(), user, {}, deps);
  assert.equal("customerNote" in db.updates.at(-1)!.data, false);
});

/* ── bounded ────────────────────────────────────────────────────────────────── */

test("bounded: a claim that never resolves still returns quickly as unavailable", async () => {
  const { deps } = harness({
    managedPhoneService: { claimForOfficeWizard: () => new Promise(() => { /* never settles */ }) },
    timeoutMs: 50,
  });
  const started = Date.now();
  const out = await ensureYealinkRedirect(basePhone(), user, {}, deps);
  assert.ok(Date.now() - started < 2_000, "bounded, not hung on a dead network call");
  assert.deepEqual(out, { ok: true, state: "unavailable" });
});
