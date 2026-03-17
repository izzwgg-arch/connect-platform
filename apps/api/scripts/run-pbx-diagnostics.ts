/**
 * Run PBX diagnostics for a tenant (link → decrypt → reach CDR).
 * Usage: pnpm exec tsx scripts/run-pbx-diagnostics.ts <tenantId>
 * Run from apps/api with same env as API (DATABASE_URL, CREDENTIALS_MASTER_KEY).
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import { VitalPbxClient } from "@connect/integrations";

function loadEnv(): void {
  const dir = resolve(process.cwd());
  for (const p of [resolve(dir, ".env"), resolve(dir, "../.env")]) {
    if (existsSync(p)) {
      const content = readFileSync(p, "utf8");
      for (const line of content.split("\n")) {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (m && process.env[m[1]] === undefined) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
        }
      }
      break;
    }
  }
}

async function run(tenantId: string): Promise<void> {
  const link = await db.tenantPbxLink.findUnique({
    where: { tenantId },
    include: { pbxInstance: true }
  });

  if (!link) {
    console.log(JSON.stringify({
      step: "link",
      ok: false,
      message: "No PBX link configured for this tenant.",
      hasLink: false,
      isEnabled: false,
      baseUrlHost: null,
      code: "PBX_NOT_LINKED"
    }, null, 2));
    return;
  }
  if (!link.pbxInstance.isEnabled) {
    let baseUrlHost: string | null = null;
    try {
      baseUrlHost = new URL(link.pbxInstance.baseUrl).hostname;
    } catch { /* ignore */ }
    console.log(JSON.stringify({
      step: "link",
      ok: false,
      message: "PBX instance is disabled.",
      hasLink: true,
      isEnabled: false,
      baseUrlHost,
      code: "PBX_INSTANCE_DISABLED"
    }, null, 2));
    return;
  }

  let baseUrlHost: string | null = null;
  try {
    baseUrlHost = new URL(link.pbxInstance.baseUrl).hostname;
  } catch {
    console.log(JSON.stringify({
      step: "link",
      ok: false,
      message: "Invalid PBX base URL format.",
      hasLink: true,
      isEnabled: true,
      baseUrlHost: null,
      code: "PBX_INVALID_BASE_URL"
    }, null, 2));
    return;
  }

  let auth: { token: string; secret?: string };
  try {
    auth = decryptJson<{ token: string; secret?: string }>(link.pbxInstance.apiAuthEncrypted);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to decrypt PBX credentials.";
    console.log(JSON.stringify({
      step: "decrypt",
      ok: false,
      message,
      baseUrlHost,
      code: "PBX_DECRYPT_FAILED"
    }, null, 2));
    return;
  }
  if (!auth?.token?.trim()) {
    console.log(JSON.stringify({
      step: "decrypt",
      ok: false,
      message: "PBX API token is missing after decrypt.",
      baseUrlHost,
      code: "PBX_MISSING_TOKEN"
    }, null, 2));
    return;
  }

  const pbxTenantId = link.pbxTenantId || undefined;
  const pbxTimezone = process.env.PBX_TIMEZONE?.trim() || undefined;
  try {
    const client = new VitalPbxClient({
      baseUrl: link.pbxInstance.baseUrl,
      apiToken: auth.token,
      apiSecret: auth.secret,
      timeoutMs: Number(process.env.PBX_TIMEOUT_MS || 10000)
    });
    const cdrToday = await client.getCdrToday(pbxTenantId, { timezone: pbxTimezone });
    console.log(JSON.stringify({
      step: "ok",
      ok: true,
      message: "PBX reachable; today KPIs from CDR.",
      baseUrlHost,
      pbxTenantId: link.pbxTenantId ?? null,
      timezone: pbxTimezone ?? "UTC",
      incomingToday: cdrToday.incoming,
      outgoingToday: cdrToday.outgoing,
      internalToday: cdrToday.internal,
      missedToday: cdrToday.missed,
      answeredToday: cdrToday.answered,
      callsToday: cdrToday.total,
      code: "OK"
    }, null, 2));
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code || "PBX_UNAVAILABLE";
    const message = err instanceof Error ? err.message : "VitalPBX request failed.";
    console.log(JSON.stringify({
      step: "reach",
      ok: false,
      message,
      baseUrlHost,
      pbxTenantId: link.pbxTenantId ?? null,
      code
    }, null, 2));
  }
}

const tenantId = process.argv[2];
loadEnv();

if (!tenantId) {
  db.tenantPbxLink.findMany({ select: { tenantId: true }, distinct: ["tenantId"] })
    .then((rows) => {
      if (rows.length === 0) {
        console.error("No tenants with a PBX link found.");
        process.exit(1);
      }
      console.log("Tenants with a PBX link (use one as argument):");
      rows.forEach((r) => console.log(" ", r.tenantId));
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
  return;
}

run(tenantId)
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
