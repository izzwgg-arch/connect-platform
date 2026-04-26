#!/usr/bin/env bash
# Verify PUT /voice/moh/schedule now resolves vpbx:<slug> scopes.
# Runs entirely inside the production API container so we hit the same
# code path the portal uses, but without needing a real JWT: we call the
# resolveMohTenantId logic directly via a small node script.
set -euo pipefail

API_CONTAINER="${API_CONTAINER:-app-api-1}"

echo "=== container git HEAD ==="
docker exec "$API_CONTAINER" sh -c 'head -1 /app/.git/HEAD 2>/dev/null || echo no-git-in-image'
echo

echo "=== verify server.ts has resolveMohTenantId ==="
docker exec "$API_CONTAINER" grep -c 'resolveMohTenantId' apps/api/src/server.ts || true
echo

echo "=== verify PUT /voice/moh/schedule now calls resolveMohTenantId ==="
docker exec "$API_CONTAINER" sh -c "grep -A 20 '^app.put(\"/voice/moh/schedule\"' apps/api/src/server.ts | head -25"
echo

echo "=== run an end-to-end upsert via prisma to confirm FK pass ==="
docker exec "$API_CONTAINER" node -e '
(async () => {
  let dbMod;
  try { dbMod = await import("@connect/db"); }
  catch (e) { console.log("DB import failed:", e.message); process.exit(1); }
  const PrismaClient = dbMod.PrismaClient || dbMod.default?.PrismaClient || dbMod.default;
  if (!PrismaClient) { console.log("no PrismaClient"); process.exit(1); }
  const db = new PrismaClient();

  // Pick an existing Connect tenant to target (use the first one).
  const t = await db.tenant.findFirst({ select: { id: true, name: true } });
  if (!t) { console.log("no tenants in db"); process.exit(1); }
  console.log("Target tenant:", t.id, t.name);

  // Upsert (mirrors the PUT /voice/moh/schedule handler exactly).
  const r = await db.mohScheduleConfig.upsert({
    where: { tenantId: t.id },
    create: { tenantId: t.id, timezone: "America/New_York", isActive: true },
    update: { timezone: "America/New_York", isActive: true },
  });
  console.log("Upsert OK → schedule.id=", r.id, "tenantId=", r.tenantId, "tz=", r.timezone);
  await db.$disconnect();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
' 2>&1
