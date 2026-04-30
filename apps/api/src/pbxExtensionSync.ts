import type { PrismaClient } from "@connect/db";
import type { VitalPbxClient } from "@connect/integrations";
import { encryptJson, hasCredentialsMasterKey } from "@connect/security";
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";

/**
 * Fetch the set of profile_ids that are classified as WebRTC in VitalPBX for the given tenant.
 * Returns an empty set on error (so sync falls back gracefully).
 */
async function fetchWebrtcProfileIds(client: VitalPbxClient, vitalTenantId: string): Promise<Set<string>> {
  try {
    const result = await (client as any).callEndpoint("deviceProfiles.webrtc", { tenant: vitalTenantId });
    const rows: any[] = Array.isArray(result?.data) ? result.data : (result?.data?.result ?? result?.data?.rows ?? []);
    const ids = new Set<string>();
    for (const p of rows) {
      const id = p.profile_id ?? p.id;
      if (id != null) ids.add(String(id));
    }
    return ids;
  } catch {
    return new Set();
  }
}

export interface ExtensionSyncTenantResult {
  vitalTenantId: string;
  displayName: string | null;
  connectTenantId: string | null;
  extensionsFound: number;
  extensionsUpserted: number;
  skipped: boolean;
  skipReason?: string;
  errors: string[];
}

export interface ExtensionSyncResult {
  pbxInstanceId: string;
  tenantResults: ExtensionSyncTenantResult[];
  totalExtensions: number;
  totalUpserted: number;
  totalSkipped: number;
  totalErrors: number;
}

/**
 * Sync VitalPBX extensions into Connect for one PBX instance.
 *
 * For each PbxTenantDirectory entry:
 *   1. Call GET /api/v2/extensions with `tenant` header = vitalTenantId (numeric).
 *   2. Map vitalTenantId → Connect tenantId via TenantPbxLink.pbxTenantId.
 *   3. Upsert Extension rows (tenantId + extNumber are the natural key).
 *   4. Upsert PbxExtensionLink rows (pbxExtensionId + SIP username from VitalPBX).
 *
 * Tenants with no TenantPbxLink are skipped (not mapped to a Connect tenant yet).
 *
 * @param options.vitalTenantId - if provided, sync only that one VitalPBX tenant
 */
export async function syncExtensionsFromPbx(
  db: PrismaClient,
  pbxInstanceId: string,
  client: VitalPbxClient,
  options?: { vitalTenantId?: string },
): Promise<ExtensionSyncResult> {
  // 1. Load all VitalPBX tenant directory entries for this instance
  const tenantDirs = await db.pbxTenantDirectory.findMany({
    where: {
      pbxInstanceId,
      ...(options?.vitalTenantId ? { vitalTenantId: options.vitalTenantId } : {}),
    },
    orderBy: { vitalTenantId: "asc" },
  });

  // 2. Build vitalTenantId → Connect tenantId map (numeric PBX id → Connect UUID)
  const pbxLinks = await db.tenantPbxLink.findMany({
    where: { pbxInstanceId },
  });
  const vitalToConnect = new Map<string, string>();
  for (const link of pbxLinks) {
    if (link.pbxTenantId) {
      vitalToConnect.set(link.pbxTenantId, link.tenantId);
    }
  }

  const result: ExtensionSyncResult = {
    pbxInstanceId,
    tenantResults: [],
    totalExtensions: 0,
    totalUpserted: 0,
    totalSkipped: 0,
    totalErrors: 0,
  };

  for (const td of tenantDirs) {
    // Try numeric vitalTenantId first (canonical), then fall back to tenantSlug
    // (handles tenants whose TenantPbxLink.pbxTenantId was stored as the name rather than numeric id)
    const connectTenantId =
      vitalToConnect.get(td.vitalTenantId) ?? vitalToConnect.get(td.tenantSlug) ?? null;

    if (!connectTenantId) {
      result.totalSkipped++;
      result.tenantResults.push({
        vitalTenantId: td.vitalTenantId,
        displayName: td.displayName,
        connectTenantId: null,
        extensionsFound: 0,
        extensionsUpserted: 0,
        skipped: true,
        skipReason: "no TenantPbxLink mapping for this vitalTenantId or tenantSlug",
        errors: [],
      });
      continue;
    }

    const tenantResult: ExtensionSyncTenantResult = {
      vitalTenantId: td.vitalTenantId,
      displayName: td.displayName,
      connectTenantId,
      extensionsFound: 0,
      extensionsUpserted: 0,
      skipped: false,
      errors: [],
    };

    try {
      // 3a. Fetch WebRTC profile IDs for this tenant (used to identify WebRTC-capable devices)
      const webrtcProfileIds = await fetchWebrtcProfileIds(client, td.vitalTenantId);

      // 3b. Fetch extensions from VitalPBX using numeric vitalTenantId as tenant header
      const extensions = await client.listExtensions(td.vitalTenantId);
      tenantResult.extensionsFound = extensions.length;
      result.totalExtensions += extensions.length;

      for (const ext of extensions) {
        const pbxExtensionId = String(
          ext.extension_id ?? ext.id ?? "",
        ).trim();
        const extNumber = String(
          ext.extension ?? ext.extensionNumber ?? ext.user ?? "",
        ).trim();
        const displayName = String(
          ext.name ?? ext.callerName ?? ext.caller_id_name ?? extNumber,
        ).trim();
        // VitalPBX returns email as "email_addresses" (array or string), "email", "voicemail_email", or "user_email"
        const rawEmail =
          ext.email_addresses ?? ext.emailAddresses ??
          ext.email ?? ext.voicemail_email ?? ext.user_email ?? null;
        const pbxUserEmail: string | null = (() => {
          if (!rawEmail) return null;
          if (Array.isArray(rawEmail)) {
            const first = rawEmail.find((e: any) => typeof e === "string" && e.trim());
            return first ? String(first).trim() : null;
          }
          const s = String(rawEmail).trim();
          return s || null;
        })();

        // Determine the active device:
        // Prefer the device with a WebRTC profile (profile_id in webrtcProfileIds).
        // Fall back to devices[0] if no WebRTC device found.
        const devices: any[] = Array.isArray(ext.devices) ? ext.devices : [];
        const webrtcDevice = webrtcProfileIds.size > 0
          ? devices.find((d: any) => webrtcProfileIds.has(String(d.profile_id)))
          : null;
        const activeDevice = webrtcDevice ?? devices[0] ?? null;

        // SIP username: use the device's "user" field (e.g. "103_1"), NOT the plain extension number.
        // The device user is what VitalPBX uses as the PJSIP endpoint/auth id for registration.
        const pbxSipUsername = activeDevice?.user
          ? String(activeDevice.user).trim()
          : extNumber;
        const pbxDeviceName: string | null = activeDevice?.device_name
          ? String(activeDevice.device_name).trim()
          : null;
        const webrtcEnabled: boolean = !!webrtcDevice;
        const pbxDeviceIdFromSync: string | null = activeDevice?.device_id != null
          ? String(activeDevice.device_id)
          : null;

        // VitalPBX returns devices[].secret — the SIP password in plain text
        // Use the active (WebRTC-preferred) device's secret.
        const rawSecret: string | null = (() => {
          const s = activeDevice?.secret ?? activeDevice?.password ?? activeDevice?.sip_password ?? null;
          return typeof s === "string" && s.trim() ? s.trim() : null;
        })();
        const sipPasswordEncrypted: string | null =
          rawSecret && hasCredentialsMasterKey() ? encryptJson(rawSecret) : null;

        if (!pbxExtensionId || !extNumber) continue;

        try {
          // 4a. Upsert the Connect Extension record
          const connectExt = await db.extension.upsert({
            where: { tenantId_extNumber: { tenantId: connectTenantId, extNumber } },
            create: {
              tenantId: connectTenantId,
              extNumber,
              displayName: displayName || extNumber,
              pbxUserEmail,
              status: "ACTIVE",
            },
            update: {
              displayName: displayName || extNumber,
              pbxUserEmail,
              status: "ACTIVE",
              updatedAt: new Date(),
            },
          });

          // 4b. Upsert PbxExtensionLink — stores WebRTC device identity and encrypted SIP password.
          // Always mirror the PBX truth for webrtcEnabled. If VitalPBX only exposes a
          // desk-phone / mobile device (no WebRTC profile), we must NOT claim WebRTC is
          // enabled — otherwise the softphone will attempt to register and fail.
          await db.pbxExtensionLink.upsert({
            where: { extensionId: connectExt.id },
            create: {
              tenantId: connectTenantId,
              extensionId: connectExt.id,
              pbxExtensionId,
              pbxSipUsername,        // device's SIP auth username (e.g. "103_1")
              pbxDeviceName: pbxDeviceName ?? undefined,
              webrtcEnabled,
              pbxDeviceId: pbxDeviceIdFromSync ?? undefined,
              isSuspended: false,
              ...(sipPasswordEncrypted ? { sipPasswordEncrypted, sipPasswordIssuedAt: new Date() } : {}),
            },
            update: {
              pbxExtensionId,
              pbxSipUsername,
              pbxDeviceName: pbxDeviceName ?? undefined,
              webrtcEnabled,
              pbxDeviceId: pbxDeviceIdFromSync ?? undefined,
              ...(sipPasswordEncrypted ? { sipPasswordEncrypted, sipPasswordIssuedAt: new Date() } : {}),
              updatedAt: new Date(),
            },
          });

          // 4c. Auto-provision a Connect user from the PBX email (if not already assigned)
          if (pbxUserEmail && !connectExt.ownerUserId) {
            try {
              // Find an existing user with this email (could be in any tenant)
              const existingUser = await db.user.findUnique({ where: { email: pbxUserEmail } });
              let userId: string | null = null;

              if (existingUser) {
                // Only link if they're in the same tenant
                if (existingUser.tenantId === connectTenantId) {
                  userId = existingUser.id;
                }
                // Different tenant: skip — don't hijack another tenant's user
              } else {
                // Create a new Connect account for this PBX user.
                // Use a random unguessable password — they must reset to log in.
                const tempPassword = randomBytes(24).toString("base64url");
                const passwordHash = await bcrypt.hash(tempPassword, 10);
                const newUser = await db.user.create({
                  data: {
                    tenantId: connectTenantId,
                    email: pbxUserEmail,
                    passwordHash,
                    role: "USER",
                  },
                });
                userId = newUser.id;
              }

              if (userId) {
                await db.extension.update({
                  where: { id: connectExt.id },
                  data: { ownerUserId: userId },
                });
              }
            } catch {
              // Non-fatal: best-effort user provisioning
            }
          }

          tenantResult.extensionsUpserted++;
          result.totalUpserted++;
        } catch (err: any) {
          const msg = `ext ${extNumber}: ${err?.message ?? String(err)}`;
          tenantResult.errors.push(msg);
          result.totalErrors++;
        }
      }
    } catch (err: any) {
      const msg = `fetch failed: ${err?.message ?? String(err)}`;
      tenantResult.errors.push(msg);
      tenantResult.skipped = true;
      tenantResult.skipReason = "VitalPBX fetch error";
      result.totalSkipped++;
    }

    result.tenantResults.push(tenantResult);
  }

  return result;
}
