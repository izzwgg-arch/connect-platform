/**
 * One-shot script: fetch the current SIP password for a specific device from VitalPBX
 * and update the sipPasswordEncrypted in the Connect DB so the mobile app can register.
 *
 * Usage:
 *   tsx scripts/fix-sip-password-from-pbx.ts <pbxExtensionLinkId> [--dry-run]
 *
 * Example:
 *   tsx scripts/fix-sip-password-from-pbx.ts cmnmd7orv003vp9b0q1xx79bc
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { db } from "@connect/db";
import { decryptJson, encryptJson, hasCredentialsMasterKey } from "@connect/security";
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

async function main(): Promise<void> {
  loadEnv();

  const linkId = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");

  if (!linkId) {
    console.error("Usage: tsx scripts/fix-sip-password-from-pbx.ts <pbxExtensionLinkId> [--dry-run]");
    process.exit(2);
  }

  if (!hasCredentialsMasterKey()) {
    console.error("CREDENTIALS_MASTER_KEY is not set or invalid — cannot encrypt/decrypt credentials.");
    process.exit(1);
  }

  // 1. Load the PbxExtensionLink
  const extLink = await db.pbxExtensionLink.findUnique({
    where: { id: linkId },
    include: { extension: { select: { tenantId: true } } }
  });

  if (!extLink) {
    console.error(`PbxExtensionLink not found: ${linkId}`);
    process.exit(1);
  }

  const tenantId = extLink.tenantId;
  const tenantPbxLink = await db.tenantPbxLink.findUnique({
    where: { tenantId },
    include: { pbxInstance: true }
  });
  if (!tenantPbxLink?.pbxInstance) {
    console.error("No PBX link/instance found for this extension's tenant.");
    process.exit(1);
  }

  console.log("Extension link:", linkId);
  console.log("  pbxSipUsername:", extLink.pbxSipUsername);
  console.log("  pbxDeviceName:", (extLink as any).pbxDeviceName);
  console.log("  pbxDeviceId:", (extLink as any).pbxDeviceId);
  console.log("  pbxExtensionId:", extLink.pbxExtensionId);
  console.log("  provisionStatus:", (extLink as any).provisionStatus);
  console.log("  sipPasswordIssuedAt:", (extLink as any).sipPasswordIssuedAt);
  console.log("  Tenant PBX link status:", tenantPbxLink.status, "| lastError:", tenantPbxLink.lastError);
  console.log("  PBX tenant ID:", tenantPbxLink.pbxTenantId, "code:", tenantPbxLink.pbxTenantCode);
  console.log("  PBX baseUrl:", tenantPbxLink.pbxInstance.baseUrl);
  console.log("");

  // 2. Decrypt PBX API credentials
  let auth: { token: string; secret?: string };
  try {
    auth = decryptJson<{ token: string; secret?: string }>(tenantPbxLink.pbxInstance.apiAuthEncrypted);
  } catch (err) {
    console.error("Failed to decrypt PBX API credentials:", err);
    process.exit(1);
  }

  // 3. Create VitalPBX client
  const client = new VitalPbxClient({
    baseUrl: tenantPbxLink.pbxInstance.baseUrl,
    apiToken: auth.token,
    apiSecret: auth.secret,
    timeoutMs: 15000,
  });

  const pbxDeviceId = (extLink as any).pbxDeviceId;
  const pbxTenantId = tenantPbxLink.pbxTenantId || undefined;

  if (!pbxDeviceId) {
    console.error("No pbxDeviceId stored — cannot fetch device from VitalPBX.");
    console.log("You may need to run the extension sync first, or set the password manually via:");
    console.log("  POST /admin/extensions/:extensionId/sip-password");
    process.exit(1);
  }

  // 4. Try various VitalPBX API paths to get the device with its secret
  const pbxExtensionId = extLink.pbxExtensionId;
  console.log(`Attempting to retrieve device ${pbxDeviceId} secret from VitalPBX (tenant ${pbxTenantId ?? "global"})...`);
  let device: any = null;

  // 4a. List all extensions for the tenant (same path as pbxExtensionSync uses)
  try {
    const extensions = await client.listExtensions(pbxTenantId);
    console.log(`  extensions.list returned ${extensions.length} extensions for tenant ${pbxTenantId}.`);
    const matchExt = extensions.find((e: any) => String(e.extension_id ?? e.id) === String(pbxExtensionId));
    if (matchExt) {
      const devices: any[] = Array.isArray(matchExt.devices) ? matchExt.devices : [];
      console.log(`  Extension ${pbxExtensionId} has ${devices.length} device(s).`);
      device = devices.find((d: any) => String(d.device_id ?? d.id) === String(pbxDeviceId))
        ?? devices.find((d: any) => {
          const u = String(d.user ?? d.device_name ?? "").trim();
          return u === extLink.pbxSipUsername || u === (extLink as any).pbxDeviceName;
        })
        ?? devices[0];
      if (device) {
        const safe = { ...device };
        if (safe.secret) safe.secret = safe.secret.slice(0, 4) + "***";
        if (safe.password) safe.password = safe.password.slice(0, 4) + "***";
        if (safe.sip_password) safe.sip_password = safe.sip_password.slice(0, 4) + "***";
        console.log("  Matched device:", JSON.stringify(safe, null, 2));
      } else {
        console.log("  No matching device found in extension.");
      }
    } else {
      console.log(`  Extension ${pbxExtensionId} not found in VitalPBX listing for tenant ${pbxTenantId}.`);
    }
  } catch (err: any) {
    console.error("  extensions.list failed:", err?.message ?? err);
  }

  // 4b. Try getExtensionDevices if 4a didn't find it
  if (!device) {
    try {
      const devices = await client.getExtensionDevices(pbxExtensionId ?? "", pbxTenantId);
      console.log(`  extensions.devices returned ${devices.length} device(s).`);
      device = devices.find((d: any) => String(d.device_id ?? d.id) === String(pbxDeviceId)) ?? devices[0];
      if (device) {
        const safe = { ...device };
        if (safe.secret) safe.secret = safe.secret.slice(0, 4) + "***";
        console.log("  Device found via extensions.devices:", JSON.stringify(safe, null, 2));
      }
    } catch (err: any) {
      console.error("  getExtensionDevices failed:", err?.message ?? err);
    }
  }

  const rawSecret: string | null = (() => {
    const s = device?.secret ?? device?.password ?? device?.sip_password ?? null;
    return typeof s === "string" && s.trim() ? s.trim() : null;
  })();

  if (!rawSecret) {
    console.error("VitalPBX device has no secret/password field in its response.");
    console.log("The device may not support password retrieval via API.");
    console.log("Option: Use VitalPBX admin panel to get/reset the device password, then call:");
    console.log("  POST /admin/extensions/:extensionId/sip-password  { sipPassword: \"<new-password>\" }");
    process.exit(1);
  }

  // 5. Compare with stored password
  let storedPassword: string | null = null;
  if ((extLink as any).sipPasswordEncrypted) {
    try {
      storedPassword = decryptJson<string>((extLink as any).sipPasswordEncrypted);
    } catch {
      console.warn("Warning: could not decrypt stored sipPasswordEncrypted (may be corrupted).");
    }
  }

  if (storedPassword === rawSecret) {
    console.log("✓ Stored password matches VitalPBX — no update needed.");
    console.log("  The SIP registration failure may have another cause.");
    console.log("  Check: is the PJSIP endpoint T25_101_1 actually active on the PBX?");
    process.exit(0);
  }

  console.log("Password MISMATCH detected:");
  console.log("  Stored:", storedPassword ? storedPassword.slice(0, 4) + "..." : "(null)");
  console.log("  VitalPBX:", rawSecret.slice(0, 4) + "...");
  console.log("");

  if (dryRun) {
    console.log("DRY RUN — would update sipPasswordEncrypted but skipping actual DB write.");
    process.exit(0);
  }

  // 6. Update the DB
  const encrypted = encryptJson(rawSecret);
  await db.pbxExtensionLink.update({
    where: { id: linkId },
    data: {
      sipPasswordEncrypted: encrypted,
      sipPasswordIssuedAt: new Date(),
    } as any,
  });

  console.log("✓ sipPasswordEncrypted updated in DB with fresh password from VitalPBX.");
  console.log("  The user should now tap 'Re-register' in the mobile app Settings,");
  console.log("  or call POST /voice/me/reset-sip-password to get new provisioning credentials.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
