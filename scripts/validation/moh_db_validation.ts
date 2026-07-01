/**
 * MOH per-call-source — DB/API-layer validation harness
 * ═══════════════════════════════════════════════════════════════════════════
 * STAGING / LOCAL ONLY. This script MUST NEVER point at production.
 *
 *   • Requires a THROWAWAY Postgres (e.g. a local Docker `postgres:16` container).
 *   • Validates only the DB + shared-logic layer that the /voice/moh/* API
 *     endpoints wrap: source-policy CRUD, global-default CRUD, schedule targeting
 *     fields, hidden-source (mobile_app/parked) behavior, resolution/diagnostics
 *     priority, and rollback tombstone logic.
 *   • It does NOT stand up the Fastify/Redis/auth stack, and it does NOT prove
 *     any live PBX behavior — it says NOTHING about `CHANNEL(musicclass)`,
 *     `MOH_SRC`, AstDB, or real call routing. Live-call validation still requires
 *     a real staging PBX or an approved production maintenance window.
 *
 * SAFETY: refuses to run unless ALL of the following hold (see assertSafeTarget):
 *   1. ALLOW_MOH_DB_VALIDATION=1 is set.
 *   2. DATABASE_URL host is localhost / 127.0.0.1 / ::1 / host.docker.internal
 *      (or an explicitly allow-listed host via MOH_VALIDATION_ALLOWED_HOST).
 *   3. DATABASE_URL database name clearly looks non-production
 *      (contains "stage" or "test", e.g. connect_stage / moh_stage).
 *
 * ─── How to run (throwaway Docker Postgres) ─────────────────────────────────
 *   docker run -d --name moh_stage_pg -e POSTGRES_PASSWORD=stage \
 *     -e POSTGRES_USER=stage -e POSTGRES_DB=connect_stage -p 55433:5432 postgres:16
 *
 *   # From packages/db, materialize the current schema onto the throwaway DB:
 *   $env:DATABASE_URL="postgresql://stage:stage@localhost:55433/connect_stage"
 *   npx prisma generate
 *   npx prisma db push --skip-generate --accept-data-loss
 *
 *   # From the repo root, run this harness:
 *   $env:ALLOW_MOH_DB_VALIDATION="1"
 *   $env:DATABASE_URL="postgresql://stage:stage@localhost:55433/connect_stage"
 *   npx tsx scripts/validation/moh_db_validation.ts
 *
 *   # Tear down when done:
 *   docker rm -f moh_stage_pg
 *
 * See docs/pbx/moh-db-validation.md for the full runbook.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  resolveEffectiveMohClass,
  normalizeMohCallSource,
  buildTenantSourceMohKeys,
  computeSourceKeysClearForRollback,
} from "../../packages/shared/src/mohCallSource";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Hard refuse to run against anything that is not an obvious throwaway/staging
 * database. This is the single most important safety gate in the file.
 */
function assertSafeTarget(): void {
  if (process.env.ALLOW_MOH_DB_VALIDATION !== "1") {
    throw new Error(
      "REFUSING TO RUN: set ALLOW_MOH_DB_VALIDATION=1 to explicitly opt in. " +
        "This harness writes/deletes rows and must only ever target a throwaway DB.",
    );
  }
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("REFUSING TO RUN: DATABASE_URL is not set.");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("REFUSING TO RUN: DATABASE_URL is not a parseable URL.");
  }

  const host = url.hostname.toLowerCase();
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "host.docker.internal"]);
  const extraAllowed = (process.env.MOH_VALIDATION_ALLOWED_HOST || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const hostAllowed = localHosts.has(host) || extraAllowed.includes(host);
  if (!hostAllowed) {
    throw new Error(
      `REFUSING TO RUN: DATABASE_URL host "${host}" is not local/allow-listed. ` +
        "Point at localhost or set MOH_VALIDATION_ALLOWED_HOST to an explicit staging host.",
    );
  }

  const dbName = url.pathname.replace(/^\//, "").split("?")[0].toLowerCase();
  const looksNonProd = /(^|[_-])(stage|staging|test|dev|throwaway|scratch)([_-]|$)/.test(dbName) ||
    dbName.includes("stage") || dbName.includes("test");
  if (!looksNonProd) {
    throw new Error(
      `REFUSING TO RUN: database name "${dbName}" does not look non-production. ` +
        'Use something like "connect_stage", "moh_stage", or a "*_test" DB.',
    );
  }
  // Belt-and-suspenders: never allow the known production DB name.
  if (dbName === "connectcomms") {
    throw new Error('REFUSING TO RUN: "connectcomms" is the production database name.');
  }

  console.log(`[safety] OK — target host="${host}" db="${dbName}" (throwaway/staging).`);
}

assertSafeTarget();

const db = new PrismaClient();
let passed = 0;
let failed = 0;
const defects: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    defects.push(`${name}${detail ? " — " + detail : ""}`);
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

async function main() {
  const slug = "T99";
  // ── Seed FK prerequisites ──────────────────────────────────────────────────
  const tenant = await db.tenant.create({ data: { name: "MOH Stage Tenant" } });
  const other = await db.tenant.create({ data: { name: "MOH Other Tenant" } });
  const prof = await db.mohProfile.create({
    data: { tenantId: tenant.id, name: "Jazz", type: "custom", vitalPbxMohClassName: "moh_jazz" },
  });
  console.log(`\n[seed] tenant=${tenant.id} other=${other.id} profile=${prof.id}`);

  // ── 1. Source-policy CRUD (PUT/GET/DELETE /voice/moh/source-policies) ────────
  console.log("\n[1] source-policy CRUD");
  const upTenant = await db.mohSourcePolicy.upsert({
    where: { tenantId_extension_source: { tenantId: tenant.id, extension: "", source: "inbound_direct" } },
    create: { tenantId: tenant.id, scope: "tenant", extension: "", source: "inbound_direct", vitalPbxMohClassName: "moh_inbound" },
    update: { vitalPbxMohClassName: "moh_inbound" },
  });
  check("create tenant-scope policy", upTenant.scope === "tenant" && upTenant.source === "inbound_direct");
  const upExt = await db.mohSourcePolicy.upsert({
    where: { tenantId_extension_source: { tenantId: tenant.id, extension: "101", source: "internal" } },
    create: { tenantId: tenant.id, scope: "extension", extension: "101", source: "internal", vitalPbxMohClassName: "moh_ext_internal" },
    update: { vitalPbxMohClassName: "moh_ext_internal" },
  });
  check("create extension-scope policy", upExt.scope === "extension" && upExt.extension === "101");
  const updated = await db.mohSourcePolicy.upsert({
    where: { tenantId_extension_source: { tenantId: tenant.id, extension: "", source: "inbound_direct" } },
    create: { tenantId: tenant.id, scope: "tenant", extension: "", source: "inbound_direct", vitalPbxMohClassName: "x" },
    update: { vitalPbxMohClassName: "moh_inbound_v2" },
  });
  check("update policy (upsert on unique key, no dup row)", updated.vitalPbxMohClassName === "moh_inbound_v2");
  const list = await db.mohSourcePolicy.findMany({ where: { tenantId: tenant.id } });
  check("list returns exactly the 2 policies", list.length === 2, `got ${list.length}`);
  let dupBlocked = false;
  try {
    await db.mohSourcePolicy.create({ data: { tenantId: tenant.id, scope: "tenant", extension: "", source: "inbound_direct", vitalPbxMohClassName: "dup" } });
  } catch {
    dupBlocked = true;
  }
  check("duplicate (tenantId,extension,source) rejected by unique index", dupBlocked);
  await db.mohSourcePolicy.delete({ where: { tenantId_extension_source: { tenantId: tenant.id, extension: "101", source: "internal" } } });
  check("delete policy", (await db.mohSourcePolicy.count({ where: { tenantId: tenant.id } })) === 1);

  // ── 2. Tenant isolation (FK + scoping) ──────────────────────────────────────
  console.log("\n[2] tenant isolation");
  let fkBlocked = false;
  try {
    await db.mohSourcePolicy.create({ data: { tenantId: "does-not-exist", scope: "tenant", extension: "", source: "outbound", vitalPbxMohClassName: "z" } });
  } catch {
    fkBlocked = true;
  }
  check("policy with unknown tenantId rejected by FK", fkBlocked);
  check("other tenant sees none of tenant's policies", (await db.mohSourcePolicy.count({ where: { tenantId: other.id } })) === 0);

  // ── 3. Global default CRUD (PUT/GET /voice/moh/global-default) ───────────────
  console.log("\n[3] global default CRUD");
  const g1 = await db.mohGlobalConfig.upsert({ where: { id: "global" }, create: { id: "global", vitalPbxMohClassName: "moh_global" }, update: { vitalPbxMohClassName: "moh_global" } });
  check("set global default (singleton id=global)", g1.id === "global" && g1.vitalPbxMohClassName === "moh_global");
  const g2 = await db.mohGlobalConfig.upsert({ where: { id: "global" }, create: { id: "global", vitalPbxMohClassName: "x" }, update: { vitalPbxMohClassName: "moh_global_v2" } });
  check("update global default in place (still singleton)", g2.vitalPbxMohClassName === "moh_global_v2" && (await db.mohGlobalConfig.count()) === 1);
  await db.mohGlobalConfig.upsert({ where: { id: "global" }, create: { id: "global", vitalPbxMohClassName: null }, update: { vitalPbxMohClassName: null } });
  check("clear global default (null allowed)", (await db.mohGlobalConfig.findUnique({ where: { id: "global" } }))!.vitalPbxMohClassName === null);

  // ── 4. Schedule targeting fields (scope/extension/callSource) ────────────────
  console.log("\n[4] schedule targeting fields");
  const sched = await db.mohScheduleConfig.create({ data: { tenantId: tenant.id, timezone: "America/New_York" } });
  const rule = await db.mohScheduleRule.create({
    data: {
      scheduleId: sched.id, profileId: prof.id, ruleType: "one_time", priority: 5,
      startAt: new Date(Date.now() - 3600e3), endAt: new Date(Date.now() + 3600e3),
      scope: "extension", extension: "101", callSource: "inbound_direct",
    },
  });
  check("schedule rule stores scope/extension/callSource", rule.scope === "extension" && rule.extension === "101" && rule.callSource === "inbound_direct");
  const legacyRule = await db.mohScheduleRule.create({ data: { scheduleId: sched.id, profileId: prof.id, ruleType: "weekly", weekday: 1, startTime: "09:00", endTime: "17:00" } });
  check("legacy rule defaults are tenant-wide/all-sources", legacyRule.scope === "tenant" && legacyRule.extension === "" && legacyRule.callSource === "");

  // ── 5. Hidden-source behavior (mobile_app, parked) ───────────────────────────
  console.log("\n[5] hidden-source behavior");
  check("mobile_app is a valid taxonomy token (DB accepts, UI hides)", normalizeMohCallSource("mobile_app") === "mobile_app");
  check("parked is a valid taxonomy token (DB accepts, UI hides)", normalizeMohCallSource("parked") === "parked");
  const hidden = await db.mohSourcePolicy.create({ data: { tenantId: tenant.id, scope: "tenant", extension: "", source: "mobile_app", vitalPbxMohClassName: "moh_mobile" } });
  check("legacy hidden-source policy persists (NOT auto-deleted)", (await db.mohSourcePolicy.findUnique({ where: { id: hidden.id } })) !== null);
  const uiSrc = fs.readFileSync(path.join(REPO_ROOT, "apps/portal/app/(platform)/pbx/moh-scheduling/page.tsx"), "utf8");
  check("UI constant hides mobile_app + parked", /UNSUPPORTED_MOH_SOURCES\s*=\s*new Set<string>\(\["mobile_app",\s*"parked"\]\)/.test(uiSrc));

  // ── 6. Diagnostics / resolution priority (GET /voice/moh/resolve) ────────────
  console.log("\n[6] diagnostics resolution priority");
  const base = { source: "inbound_direct" as const };
  check("level: extension_source wins", resolveEffectiveMohClass({ ...base, extensionSourceClass: "A", extensionDefaultClass: "B", tenantSourceClass: "C", tenantDefaultClass: "D", globalDefaultClass: "E" }).reason === "extension_source");
  check("level: extension_default", resolveEffectiveMohClass({ ...base, extensionDefaultClass: "B", tenantSourceClass: "C", tenantDefaultClass: "D", globalDefaultClass: "E" }).reason === "extension_default");
  check("level: tenant_source", resolveEffectiveMohClass({ ...base, tenantSourceClass: "C", tenantDefaultClass: "D", globalDefaultClass: "E" }).reason === "tenant_source");
  check("level: tenant_default", resolveEffectiveMohClass({ ...base, tenantDefaultClass: "D", globalDefaultClass: "E" }).reason === "tenant_default");
  check("level: global_default", resolveEffectiveMohClass({ ...base, globalDefaultClass: "E" }).reason === "global_default");
  check("level: pbx_default (nothing set → fall back)", resolveEffectiveMohClass({ ...base }).reason === "pbx_default" && resolveEffectiveMohClass({ ...base }).class === null);
  check("schedule_extension beats all static levels", resolveEffectiveMohClass({ ...base, scheduledExtensionClass: "SCHED", extensionSourceClass: "A", tenantDefaultClass: "D" }).reason === "schedule_extension");
  check("whitespace/empty candidate treated as unset", resolveEffectiveMohClass({ ...base, extensionSourceClass: "   ", tenantDefaultClass: "D" }).reason === "tenant_default");

  // ── 7. Rollback behavior at DB/API layer ─────────────────────────────────────
  console.log("\n[7] rollback (AstDB tombstone builder + key builder)");
  const targetKeys = buildTenantSourceMohKeys(slug, [
    { source: "inbound_direct", vitalPbxMohClassName: "moh_inbound", enabled: true },
    { source: "outbound", vitalPbxMohClassName: "moh_out", enabled: true },
  ]);
  check("publish builds one additive key per enabled source", targetKeys.length === 2 && targetKeys.every((k) => k.family.endsWith("/moh/src")));
  const prevKeys = buildTenantSourceMohKeys(slug, [{ source: "inbound_direct", vitalPbxMohClassName: "moh_inbound", enabled: true }]);
  const tombstones = computeSourceKeysClearForRollback(targetKeys, prevKeys);
  check("rollback tombstones ONLY the newly-added key (outbound), not pre-existing", tombstones.length === 1 && tombstones[0].key === "outbound" && tombstones[0].value === "");
  check("disabled source emits no key (fail-closed)", buildTenantSourceMohKeys(slug, [{ source: "internal", vitalPbxMohClassName: "x", enabled: false }]).length === 0);

  // ── 8. Cascade delete (tenant removal cleans policies) ───────────────────────
  console.log("\n[8] cascade + cleanup");
  await db.tenant.delete({ where: { id: tenant.id } });
  check("deleting tenant cascades its source policies", (await db.mohSourcePolicy.count({ where: { tenantId: tenant.id } })) === 0);
  await db.tenant.delete({ where: { id: other.id } });
  await db.mohGlobalConfig.deleteMany({});

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  if (defects.length) {
    console.log("DEFECTS:");
    defects.forEach((d) => console.log("  - " + d));
  }
  await db.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("FATAL", e);
  await db.$disconnect();
  process.exit(2);
});
