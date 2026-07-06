#!/usr/bin/env node
// ============================================================================
// wake-canary-reconcile.mjs — Connect mobile wake-canary AstDB reconciler.
//
// Computes the DESIRED wake-canary state from Connect's mobile-provisioning
// source of truth and reconciles it against the PBX AstDB runtime control key
//
//     connect/wake_canary/T<pbxTenantId>_<extNumber> = 1
//
// This is the ONE key both call paths read:
//   • [connect-dial-with-wake]  (IVR / Connect wake path)  — already reads it
//   • [T<id>_cos-all] overlay   (native call path)         — reads it via
//        scripts/pbx/install-connect-cos-wake-overlay.sh
//
// OWNERSHIP METADATA (so rollback only ever touches keys WE created):
//     connect/wake_canary_owner/T<id>_<ext>      = connect-mobile
//     connect/wake_canary_source/T<id>_<ext>     = mobile-provisioning
//     connect/wake_canary_updated_at/T<id>_<ext> = <ISO timestamp>
//
// MODES:
//   dry-run         (default) read DB + AstDB, print the plan, write NOTHING
//   report          read DB + AstDB, print coverage/mismatch summary, write NOTHING
//   verify          read DB + AstDB, exit non-zero if drift exists, write NOTHING
//   apply           write ONLY reviewed ENABLE/DISABLE changes (GATED, see below)
//   rollback-owned  clear ONLY keys whose _owner == connect-mobile (GATED)
//
// SAFETY:
//   • apply / rollback-owned refuse to run unless BOTH:
//       --i-understand-this-mutates-astdb   is passed, AND
//       --fixture is NOT used (fixtures are read-only demonstrations)
//   • --fixture <path> loads {extensions, astdb} JSON for offline dry-run /
//     report / verify / tests — never mutates anything.
//   • DB read is via @connect/db (Prisma). AstDB read/write is via a command
//     runner that shells `asterisk -rx ...` (locally on the PBX, or over SSH
//     when PBX_SSH is set, e.g. PBX_SSH=connect).
//   • Fails closed: any DB or PBX read error aborts before any write.
//
// This file is import-safe: importing it does NOT run main(); the pure
// functions below are unit-tested by wake-canary-reconcile.test.ts.
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── Constants ───────────────────────────────────────────────────────────────
export const CANARY_FAMILY = "connect/wake_canary";
export const OWNER_FAMILY = "connect/wake_canary_owner";
export const SOURCE_FAMILY = "connect/wake_canary_source";
export const UPDATED_FAMILY = "connect/wake_canary_updated_at";
export const OWNER_VALUE = "connect-mobile";
export const SOURCE_VALUE = "mobile-provisioning";

// A device older than this by lastSeenAt is "stale". Stale devices do NOT by
// themselves qualify an extension — but a stale device is still evidence the
// extension WAS mobile, so it is only a supporting signal, never the sole one.
export const DEFAULT_STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const ACTIONS = Object.freeze({
  ENABLE: "ENABLE",
  KEEP_ENABLED: "KEEP_ENABLED",
  DISABLE: "DISABLE",
  KEEP_DISABLED: "KEEP_DISABLED",
  SKIP_NEEDS_REVIEW: "SKIP_NEEDS_REVIEW",
});

/** The single runtime key name for an extension. */
export function canaryKey(pbxTenantId, extNumber) {
  return `T${pbxTenantId}_${extNumber}`;
}

// ── Pure: classify one extension record ─────────────────────────────────────
//
// `rec` shape (already joined from Prisma — kept plain for testability):
//   {
//     tenantId, tenantName, tenantWebrtcEnabled,          // Tenant
//     pbxTenantId, pbxTenantLinkStatus,                   // TenantPbxLink (may be null)
//     extensionId, extNumber, extStatus, ownerUserId,     // Extension
//     pbxLinkPresent, provisionStatus, isSuspended,       // PbxExtensionLink (may be null)
//     devices: [{ active, deactivatedAt, lastSeenAt }]    // MobileDevice[]
//   }
//
// Returns eligibility + device counts + risk flags. Does NOT look at AstDB;
// the ENABLE/DISABLE decision is made later against current key state.
export function evaluateEligibility(rec, opts = {}) {
  const now = opts.now instanceof Date ? opts.now.getTime() : (opts.now ?? Date.now());
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const risk = [];

  const devices = Array.isArray(rec.devices) ? rec.devices : [];
  const activeDevices = devices.filter((d) => d && d.active === true && d.deactivatedAt == null);
  const staleActiveDevices = activeDevices.filter((d) => {
    const seen = toMs(d.lastSeenAt);
    return seen != null && now - seen > staleMs;
  });
  const freshActiveDevices = activeDevices.filter((d) => {
    const seen = toMs(d.lastSeenAt);
    return seen != null && now - seen <= staleMs;
  });
  const staleDeviceCount = devices.length - activeDevices.length + staleActiveDevices.length;
  const latestActiveLastSeenAt = activeDevices
    .map((d) => toMs(d.lastSeenAt))
    .filter((v) => v != null)
    .sort((a, b) => b - a)[0];

  const pbxTenantId = rec.pbxTenantId != null && String(rec.pbxTenantId).trim() !== ""
    ? String(rec.pbxTenantId).trim()
    : null;
  const key = pbxTenantId ? canaryKey(pbxTenantId, rec.extNumber) : null;

  const base = {
    tenantId: rec.tenantId,
    tenantName: rec.tenantName ?? null,
    pbxTenantId,
    extensionId: rec.extensionId,
    extNumber: rec.extNumber,
    ownerUserId: rec.ownerUserId ?? null,
    activeDeviceCount: activeDevices.length,
    staleDeviceCount,
    latestActiveLastSeenAt: latestActiveLastSeenAt != null ? new Date(latestActiveLastSeenAt).toISOString() : null,
    key,
    riskFlags: risk,
  };

  // ── NEEDS_REVIEW gates (ambiguous mapping — never auto-enable/disable) ────
  if (!pbxTenantId) {
    risk.push("missing_pbx_tenant_id");
    return { ...base, eligible: false, decision: ACTIONS.SKIP_NEEDS_REVIEW, mobileReason: "no PBX tenant mapping" };
  }
  // TenantPbxLink.status is a CDR/sync HEALTH artifact, NOT an authoritative
  // "is this tenant PBX-linked" flag. apps/worker/src/main.ts flips it to ERROR
  // on any CDR-sync failure and back to LINKED on success, so production runs
  // with status=ERROR across every tenant while remaining fully PBX-linked
  // (pbxTenantId present) — the proven T2/110 canary is one such tenant. The
  // established codebase pattern (pbxOmbutelMohClassSync / pbxOmbutelPromptSync /
  // pbxOmbutelInboundDidSync) treats {LINKED, ERROR} + a present pbxTenantId as a
  // valid linked tenant. Only an explicit UNLINKED is a real "not linked" signal.
  // A present pbxTenantId is already required immediately above.
  if (rec.pbxTenantLinkStatus === "UNLINKED") {
    risk.push("pbx_tenant_link_unlinked");
    return { ...base, eligible: false, decision: ACTIONS.SKIP_NEEDS_REVIEW, mobileReason: "tenant PBX link UNLINKED" };
  }
  if (!rec.pbxLinkPresent) {
    risk.push("missing_pbx_extension_link");
    return { ...base, eligible: false, decision: ACTIONS.SKIP_NEEDS_REVIEW, mobileReason: "no PBX extension link" };
  }

  // ── Hard ineligibility (deterministic — safe to DISABLE owned keys) ───────
  if (rec.tenantWebrtcEnabled !== true) {
    return { ...base, eligible: false, decision: "INELIGIBLE", mobileReason: "tenant WebRTC/mobile disabled" };
  }
  if (rec.extStatus !== "ACTIVE") {
    return { ...base, eligible: false, decision: "INELIGIBLE", mobileReason: `extension status ${rec.extStatus}` };
  }
  if (rec.provisionStatus === "DISABLED") {
    return { ...base, eligible: false, decision: "INELIGIBLE", mobileReason: "extension provisioning DISABLED" };
  }
  if (rec.isSuspended === true) {
    return { ...base, eligible: false, decision: "INELIGIBLE", mobileReason: "extension suspended" };
  }

  // ── Mobile capability evidence ────────────────────────────────────────────
  // Eligibility REQUIRES a current active Connect mobile client: a fresh
  // MobileDevice row (active === true, deactivatedAt == null, lastSeenAt within
  // the stale window) mapped to this extension. This targets REAL current mobile
  // clients, not every user-owned extension.
  //
  // There is NO explicit mobile-entitlement flag in the schema (checked: no
  // mobileEnabled/isMobile/provisioned-mobile column). PbxExtensionLink
  // .webrtcEnabled and .provisionStatus describe VitalPBX/softphone *capability*,
  // not a live client, so an active MobileDevice is the source of truth.
  //
  // ownerUserId ALONE is NOT sufficient: an owner with zero active devices is a
  // provisioned identity without a live mobile client (or a desk user) and must
  // be surfaced for review, never auto-enabled. Future users become eligible
  // automatically the moment they create an active MobileDevice row (picked up by
  // the scheduled reconciler / provisioning hook).
  const hasOwner = rec.ownerUserId != null && String(rec.ownerUserId).trim() !== "";
  const hasFreshActiveDevice = freshActiveDevices.length > 0;
  const hasAnyActiveDevice = activeDevices.length > 0;

  if (hasFreshActiveDevice) {
    return { ...base, eligible: true, decision: "ELIGIBLE", mobileReason: hasOwner ? "owner + active mobile device" : "active mobile device" };
  }
  if (hasAnyActiveDevice && staleActiveDevices.length === activeDevices.length) {
    // Active but stale device(s) only — not a current client. Never enable.
    risk.push("stale_devices_only");
    return { ...base, eligible: false, decision: "INELIGIBLE", mobileReason: "stale active device(s) only — no current mobile client" };
  }
  if (hasOwner) {
    // Owner assigned but no active mobile device — ambiguous. Surface for review;
    // do NOT enable (owner alone is not proof of a mobile client).
    risk.push("owner_without_active_mobile_device");
    return { ...base, eligible: false, decision: ACTIONS.SKIP_NEEDS_REVIEW, mobileReason: "owner assigned but no active mobile device" };
  }
  return { ...base, eligible: false, decision: "INELIGIBLE", mobileReason: "no mobile capability evidence" };
}

function toMs(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

// ── Pure: parse `asterisk -rx "database show connect/wake_canary"` output ───
// Lines look like:  /connect/wake_canary/T2_110                    : 1
// Returns { "T2_110": "1", ... } for the requested family prefix.
export function parseAstDbShow(text, family) {
  const out = {};
  const prefix = `/${family}/`;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(prefix)) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const path = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    const keyName = path.slice(prefix.length);
    if (keyName) out[keyName] = value;
  }
  return out;
}

// ── Pure: reconcile desired vs current ──────────────────────────────────────
//
// `records`  : Array of joined extension records (see evaluateEligibility).
// `astdb`    : { value: {key:val}, owner: {key:val} } — current AstDB state
//              (value = connect/wake_canary, owner = connect/wake_canary_owner).
// Returns { rows, orphans, counts } where each row has a concrete action.
export function reconcile(records, astdb, opts = {}) {
  const value = astdb?.value ?? {};
  const owner = astdb?.owner ?? {};
  const rows = [];
  const seenKeys = new Set();

  for (const rec of records) {
    const eva = evaluateEligibility(rec, opts);
    const key = eva.key;
    const currentValue = key ? (value[key] ?? null) : null;
    const currentOwner = key ? (owner[key] ?? null) : null;
    if (key) seenKeys.add(key);

    let action;
    if (eva.decision === ACTIONS.SKIP_NEEDS_REVIEW) {
      action = ACTIONS.SKIP_NEEDS_REVIEW;
    } else if (eva.eligible) {
      action = currentValue === "1" ? ACTIONS.KEEP_ENABLED : ACTIONS.ENABLE;
    } else {
      // ineligible
      if (currentValue === "1") {
        if (currentOwner === OWNER_VALUE) {
          action = ACTIONS.DISABLE;
        } else {
          // A manually-created key we do not own — never clear it silently.
          eva.riskFlags.push("enabled_key_not_owned_by_connect");
          action = ACTIONS.SKIP_NEEDS_REVIEW;
        }
      } else {
        action = ACTIONS.KEEP_DISABLED;
      }
    }

    rows.push({ ...eva, currentValue, currentOwner, action });
  }

  // ── Orphan owned keys: enabled + owned by us but no matching DB record ─────
  const orphans = [];
  for (const [key, val] of Object.entries(value)) {
    if (val !== "1") continue;
    if (seenKeys.has(key)) continue;
    if (owner[key] !== OWNER_VALUE) continue; // only reconcile OUR keys
    orphans.push({ key, currentValue: val, currentOwner: owner[key], action: ACTIONS.DISABLE, reason: "orphan owned key — no matching mobile extension" });
  }

  const counts = summarize(rows, orphans);
  return { rows, orphans, counts };
}

export function summarize(rows, orphans = []) {
  const byAction = {};
  for (const a of Object.values(ACTIONS)) byAction[a] = 0;
  const tenants = new Set();
  for (const r of rows) {
    byAction[r.action] = (byAction[r.action] ?? 0) + 1;
    if (r.pbxTenantId) tenants.add(r.pbxTenantId);
  }
  const disableOrphans = orphans.length;
  return {
    totalRecords: rows.length,
    tenants: tenants.size,
    byAction,
    orphanDisable: disableOrphans,
    toWrite: byAction[ACTIONS.ENABLE],
    toClear: byAction[ACTIONS.DISABLE] + disableOrphans,
  };
}

/** True if reconcile output implies no ENABLE/DISABLE changes are needed. */
export function hasDrift(result) {
  return result.counts.toWrite > 0 || result.counts.toClear > 0;
}

// ── IO adapters (not exercised by unit tests) ───────────────────────────────

/** Build joined extension records from the Connect DB via Prisma. */
export async function loadRecordsFromDb() {
  const dbMod = await import("@connect/db");
  const PrismaClient = dbMod.PrismaClient || dbMod.default?.PrismaClient;
  const db = dbMod.db || (PrismaClient ? new PrismaClient() : null);
  if (!db) throw new Error("could not obtain a Prisma client from @connect/db");

  const extensions = await db.extension.findMany({
    include: {
      tenant: { select: { id: true, name: true, webrtcEnabled: true, pbxTenantLink: { select: { pbxTenantId: true, status: true } } } },
      pbxLink: { select: { provisionStatus: true, isSuspended: true, webrtcEnabled: true } },
      mobileDevices: { select: { active: true, deactivatedAt: true, lastSeenAt: true } },
    },
  });

  return extensions.map((e) => ({
    tenantId: e.tenantId,
    tenantName: e.tenant?.name ?? null,
    tenantWebrtcEnabled: e.tenant?.webrtcEnabled === true,
    pbxTenantId: e.tenant?.pbxTenantLink?.pbxTenantId ?? null,
    pbxTenantLinkStatus: e.tenant?.pbxTenantLink?.status ?? null,
    extensionId: e.id,
    extNumber: e.extNumber,
    extStatus: e.status,
    ownerUserId: e.ownerUserId ?? null,
    pbxLinkPresent: e.pbxLink != null,
    provisionStatus: e.pbxLink?.provisionStatus ?? null,
    isSuspended: e.pbxLink?.isSuspended ?? null,
    devices: (e.mobileDevices ?? []).map((d) => ({ active: d.active, deactivatedAt: d.deactivatedAt, lastSeenAt: d.lastSeenAt })),
  }));
}

/** Shell out to `asterisk -rx <cmd>` locally or over SSH (PBX_SSH set). */
function makeAstRunner(execFileSync) {
  const sshTarget = process.env.PBX_SSH || "";
  return function astRx(cmd) {
    if (sshTarget) {
      return execFileSync("ssh", [sshTarget, `asterisk -rx ${JSON.stringify(cmd)}`], { encoding: "utf8" });
    }
    return execFileSync("asterisk", ["-rx", cmd], { encoding: "utf8" });
  };
}

async function readAstDbState(astRx) {
  const value = parseAstDbShow(astRx(`database show ${CANARY_FAMILY}`), CANARY_FAMILY);
  const owner = parseAstDbShow(astRx(`database show ${OWNER_FAMILY}`), OWNER_FAMILY);
  return { value, owner };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { mode: "dry-run", fixture: null, confirm: false, staleDays: null, json: false, now: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixture") args.fixture = argv[++i];
    else if (a === "--i-understand-this-mutates-astdb") args.confirm = true;
    else if (a === "--json") args.json = true;
    else if (a === "--stale-days") args.staleDays = Number(argv[++i]);
    else if (a === "--now") args.now = argv[++i];
    else if (a.startsWith("--")) positional.push(a.slice(2));
    else positional.push(a);
  }
  if (positional.length) args.mode = positional[0];
  return args;
}

function fmtRow(r) {
  return [
    r.pbxTenantId ? `T${r.pbxTenantId}` : "T?",
    r.extNumber,
    r.action.padEnd(17),
    `dev=${r.activeDeviceCount}/${r.staleDeviceCount}`,
    `key=${r.currentValue ?? "-"}`,
    `owner=${r.currentOwner ?? "-"}`,
    r.mobileReason,
    r.riskFlags.length ? `[${r.riskFlags.join(",")}]` : "",
  ].join("  ");
}

async function main() {
  const { execFileSync } = await import("node:child_process");
  const args = parseArgs(process.argv.slice(2));
  const opts = {};
  if (args.staleDays != null) opts.staleMs = args.staleDays * 24 * 60 * 60 * 1000;
  if (args.now != null) opts.now = new Date(args.now).getTime();

  const mutating = args.mode === "apply" || args.mode === "rollback-owned";
  if (mutating && args.fixture) {
    console.error("REFUSING: --fixture is read-only; cannot apply/rollback against a fixture.");
    process.exit(2);
  }
  if (mutating && !args.confirm) {
    console.error("REFUSING: apply/rollback-owned require --i-understand-this-mutates-astdb.");
    process.exit(2);
  }

  // Load records + AstDB state (fixture = offline; else live DB + PBX).
  let records, astdb, astRx;
  if (args.fixture) {
    const fx = JSON.parse(readFileSync(args.fixture, "utf8"));
    records = fx.extensions ?? [];
    astdb = normalizeFixtureAstDb(fx.astdb);
  } else {
    astRx = makeAstRunner(execFileSync);
    try {
      records = await loadRecordsFromDb();
    } catch (err) {
      console.error(`FAIL-CLOSED: DB read failed: ${err?.message ?? err}`);
      process.exit(3);
    }
    try {
      astdb = await readAstDbState(astRx);
    } catch (err) {
      console.error(`FAIL-CLOSED: PBX AstDB read failed: ${err?.message ?? err}`);
      process.exit(3);
    }
  }

  const result = reconcile(records, astdb, opts);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(args.mode, result, records);
  }

  switch (args.mode) {
    case "dry-run":
    case "report":
      return; // read-only
    case "verify":
      process.exit(hasDrift(result) ? 1 : 0);
      break;
    case "apply":
      await applyChanges(result, astRx);
      return;
    case "rollback-owned":
      await rollbackOwned(astdb, astRx);
      return;
    default:
      console.error(`Unknown mode: ${args.mode}`);
      process.exit(64);
  }
}

function normalizeFixtureAstDb(a) {
  if (!a) return { value: {}, owner: {} };
  // Fixture may provide either already-split {value,owner} or raw families.
  if (a.value || a.owner) return { value: a.value ?? {}, owner: a.owner ?? {} };
  return { value: a[CANARY_FAMILY] ?? {}, owner: a[OWNER_FAMILY] ?? {} };
}

function printHuman(mode, result, records) {
  console.log(`\n=== wake-canary reconcile (${mode}) ===`);
  console.log(`records=${result.counts.totalRecords} tenants=${result.counts.tenants}`);
  const order = [ACTIONS.ENABLE, ACTIONS.KEEP_ENABLED, ACTIONS.DISABLE, ACTIONS.KEEP_DISABLED, ACTIONS.SKIP_NEEDS_REVIEW];
  for (const r of result.rows.slice().sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action) || String(a.pbxTenantId).localeCompare(String(b.pbxTenantId)) || a.extNumber.localeCompare(b.extNumber))) {
    console.log("  " + fmtRow(r));
  }
  if (result.orphans.length) {
    console.log("  -- orphan owned keys (no matching mobile extension) --");
    for (const o of result.orphans) console.log(`  ${o.key}  ${o.action}  ${o.reason}`);
  }
  console.log("\n-- counts by action --");
  for (const [a, n] of Object.entries(result.counts.byAction)) console.log(`  ${a.padEnd(18)} ${n}`);
  console.log(`  ${"ORPHAN_DISABLE".padEnd(18)} ${result.counts.orphanDisable}`);
  // counts by tenant
  const byTenant = {};
  for (const r of result.rows) {
    const t = r.pbxTenantId ? `T${r.pbxTenantId}` : "T?";
    byTenant[t] = byTenant[t] || { enable: 0, keep: 0, disable: 0, skip: 0, total: 0 };
    byTenant[t].total++;
    if (r.action === ACTIONS.ENABLE) byTenant[t].enable++;
    else if (r.action === ACTIONS.KEEP_ENABLED) byTenant[t].keep++;
    else if (r.action === ACTIONS.DISABLE) byTenant[t].disable++;
    else if (r.action === ACTIONS.SKIP_NEEDS_REVIEW) byTenant[t].skip++;
  }
  console.log("\n-- counts by tenant --");
  for (const [t, c] of Object.entries(byTenant).sort()) {
    console.log(`  ${t.padEnd(6)} total=${c.total} enable=${c.enable} keep_enabled=${c.keep} disable=${c.disable} needs_review=${c.skip}`);
  }
  console.log(`\ndrift=${hasDrift(result) ? "YES" : "no"}  (toWrite=${result.counts.toWrite} toClear=${result.counts.toClear})`);
}

async function applyChanges(result, astRx) {
  const nowIso = new Date().toISOString();
  let wrote = 0, cleared = 0, failed = 0;
  const put = (family, key, val) => astRx(`database put ${family} ${key} ${JSON.stringify(String(val))}`);
  const del = (family, key) => astRx(`database del ${family} ${key}`);
  for (const r of result.rows) {
    try {
      if (r.action === ACTIONS.ENABLE) {
        put(CANARY_FAMILY, r.key, "1");
        put(OWNER_FAMILY, r.key, OWNER_VALUE);
        put(SOURCE_FAMILY, r.key, SOURCE_VALUE);
        put(UPDATED_FAMILY, r.key, nowIso);
        // verify
        const back = parseAstDbShow(astRx(`database show ${CANARY_FAMILY}`), CANARY_FAMILY);
        if (back[r.key] !== "1") throw new Error("post-write verify failed");
        wrote++;
      } else if (r.action === ACTIONS.DISABLE) {
        del(CANARY_FAMILY, r.key);
        del(OWNER_FAMILY, r.key);
        del(SOURCE_FAMILY, r.key);
        del(UPDATED_FAMILY, r.key);
        cleared++;
      }
    } catch (err) {
      failed++;
      console.error(`  [PARTIAL] ${r.key} ${r.action} failed: ${err?.message ?? err} — re-run to retry (idempotent).`);
    }
  }
  for (const o of result.orphans) {
    try {
      del(CANARY_FAMILY, o.key); del(OWNER_FAMILY, o.key); del(SOURCE_FAMILY, o.key); del(UPDATED_FAMILY, o.key);
      cleared++;
    } catch (err) {
      failed++;
      console.error(`  [PARTIAL] orphan ${o.key} clear failed: ${err?.message ?? err}`);
    }
  }
  console.log(`\napply complete: wrote=${wrote} cleared=${cleared} failed=${failed}`);
  if (failed) process.exit(4);
}

async function rollbackOwned(astdb, astRx) {
  let cleared = 0;
  for (const [key, ownerVal] of Object.entries(astdb.owner ?? {})) {
    if (ownerVal !== OWNER_VALUE) continue; // NEVER clear keys we do not own
    astRx(`database del ${CANARY_FAMILY} ${key}`);
    astRx(`database del ${OWNER_FAMILY} ${key}`);
    astRx(`database del ${SOURCE_FAMILY} ${key}`);
    astRx(`database del ${UPDATED_FAMILY} ${key}`);
    cleared++;
  }
  console.log(`rollback-owned complete: cleared ${cleared} owned key(s)`);
}

// Only run main() when executed directly, not when imported by tests.
const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  main().catch((err) => {
    console.error(err?.stack ?? String(err));
    process.exit(1);
  });
}
