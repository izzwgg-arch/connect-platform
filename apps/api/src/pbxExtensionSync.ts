import type { PrismaClient } from "@connect/db";
import type { VitalPbxClient } from "@connect/integrations";
import { encryptJson, hasCredentialsMasterKey } from "@connect/security";
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";

// ── Auto-apply cooldown ───────────────────────────────────────────────────────
// When a sync detects a WebRTC endpoint that has never gone live (the "device
// exists in VitalPBX's DB but was never pushed into the running Asterisk config"
// gap), we automatically run VitalPBX "Apply Changes" so the endpoint becomes
// registerable without a human clicking the button. To avoid reloading Asterisk
// repeatedly for a tenant that stays un-live (e.g. a phantom device, or a phone
// that simply hasn't been scanned yet), we rate-limit auto-apply per tenant.
const AUTO_APPLY_COOLDOWN_MS = 10 * 60 * 1000;
const AUTO_APPLY_LAST_AT = new Map<string, number>();

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
  extensionsDeactivated: number;
  autoProvisioned: boolean;
  skipped: boolean;
  skipReason?: string;
  errors: string[];
  /** True when this sync auto-triggered VitalPBX "Apply Changes" for the tenant. */
  appliedChanges?: boolean;
  /** Non-null when an auto-apply was attempted but failed (incl. "nothing to apply"). */
  applyError?: string | null;
}

export interface ExtensionSyncResult {
  pbxInstanceId: string;
  tenantResults: ExtensionSyncTenantResult[];
  totalExtensions: number;
  totalUpserted: number;
  totalDeactivated: number;
  totalSkipped: number;
  totalErrors: number;
  totalAutoProvisioned: number;
  /** Number of tenants for which auto-apply (VitalPBX "Apply Changes") fired. */
  totalAppliedChanges: number;
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
 * @param options.applyChangesForUnliveWebrtc - when true (admin-initiated refresh /
 *   per-user provisioning only — never the periodic warm cycle), automatically run
 *   VitalPBX "Apply Changes" for any tenant whose WebRTC endpoint has never gone
 *   live, so a freshly-scanned phone can register without a manual Apply click.
 */
export async function syncExtensionsFromPbx(
  db: PrismaClient,
  pbxInstanceId: string,
  client: VitalPbxClient,
  options?: { vitalTenantId?: string; applyChangesForUnliveWebrtc?: boolean },
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
    totalDeactivated: 0,
    totalSkipped: 0,
    totalErrors: 0,
    totalAutoProvisioned: 0,
    totalAppliedChanges: 0,
  };

  for (const td of tenantDirs) {
    // Try numeric vitalTenantId first (canonical), then fall back to tenantSlug
    // (handles tenants whose TenantPbxLink.pbxTenantId was stored as the name rather than numeric id)
    let connectTenantId =
      vitalToConnect.get(td.vitalTenantId) ?? vitalToConnect.get(td.tenantSlug) ?? null;

    let autoProvisioned = false;
    if (!connectTenantId) {
      // Auto-provision a Connect Tenant + TenantPbxLink for this PBX tenant so that
      // every Refresh PBX brings in ALL extensions, not just those for pre-linked tenants.
      try {
        const displayName =
          td.displayName ||
          String(td.tenantSlug || "").replace(/[_-]/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()) ||
          `PBX Tenant ${td.vitalTenantId}`;
        const provisioned = await db.$transaction(async (tx) => {
          const t = await (tx as any).tenant.create({
            data: { name: displayName, kind: "CUSTOMER", isApproved: true },
          });
          await (tx as any).tenantPbxLink.create({
            data: {
              tenantId: t.id,
              pbxInstanceId,
              pbxTenantId: td.vitalTenantId,
              pbxTenantCode: (td as any).tenantCode ?? null,
              status: "LINKED",
            },
          });
          return t;
        });
        connectTenantId = String(provisioned.id);
        vitalToConnect.set(td.vitalTenantId, connectTenantId as string);
        autoProvisioned = true;
        result.totalAutoProvisioned++;
      } catch (provisionErr: any) {
        result.totalSkipped++;
        result.tenantResults.push({
          vitalTenantId: td.vitalTenantId,
          displayName: td.displayName,
          connectTenantId: null,
          extensionsFound: 0,
          extensionsUpserted: 0,
          extensionsDeactivated: 0,
          autoProvisioned: false,
          skipped: true,
          skipReason: `auto-provision failed: ${provisionErr?.message ?? String(provisionErr)}`,
          errors: [],
        });
        continue;
      }
    }

    // connectTenantId is guaranteed non-null here: it was either already set at
    // the top of the loop, or the auto-provision block just set it (the failure
    // path always uses `continue` to skip to the next tenant).
    const resolvedTenantId: string = connectTenantId as string;

    const tenantResult: ExtensionSyncTenantResult = {
      vitalTenantId: td.vitalTenantId,
      displayName: td.displayName,
      connectTenantId: resolvedTenantId,
      extensionsFound: 0,
      extensionsUpserted: 0,
      extensionsDeactivated: 0,
      autoProvisioned,
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

      let syncFoundWebrtcExtension = false;
      // WebRTC endpoint names (e.g. "T34_101_1") seen this pass — used to check
      // live registration and decide whether an auto-apply is warranted.
      const webrtcEndpointNames: string[] = [];
      // Track extension numbers seen in this sync pass so we can deactivate any
      // that VitalPBX no longer returns (i.e. they were deleted on the PBX side).
      const seenExtNumbers = new Set<string>();

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
          // Always store emails in their canonical lowercased form. Login flow
          // lowercases the typed email before lookup; without this normalize
          // step, users imported with mixed-case PBX emails (e.g.
          // "Relaxtires@gmail.com") can never log in because Postgres
          // `String @unique` is case-sensitive.
          const norm = (v: unknown): string | null => {
            if (typeof v !== "string") return null;
            const t = v.trim().toLowerCase();
            return t || null;
          };
          if (Array.isArray(rawEmail)) {
            for (const candidate of rawEmail) {
              const n = norm(candidate);
              if (n) return n;
            }
            return null;
          }
          return norm(rawEmail);
        })();

        // Determine the active device. Tenant rule: WebRTC devices are named
        // with a trailing "_1" suffix (e.g. "T7_101_1"). Non-WebRTC devices
        // (desk / mobile) use the bare extension (e.g. "T7_101").
        //
        // Detection order:
        //   1. Prefer a trailing "_1" device only when its profile is WebRTC
        //      (or when profile discovery failed and we have no better signal).
        //   2. Fall back to any device whose profile_id matches a VitalPBX
        //      "WebRTC" device profile.
        //   3. Fall back to devices[0] so desk-phone extensions keep syncing.
        //
        // The suffix alone is not enough: a bad VitalPBX CSV import can create
        // "102_1" as a normal PJSIP/UDP device. Marking that as WebRTC makes
        // Connect say "synced" while the softphone stays stuck connecting.
        const devices: any[] = Array.isArray(ext.devices) ? ext.devices : [];
        const endsWithWebrtcSuffix = (d: any): boolean => {
          const u = String(d?.user ?? "").trim();
          const n = String(d?.device_name ?? "").trim();
          return /_1$/.test(u) || /_1$/.test(n);
        };
        const profileIsWebrtc = (d: any): boolean => webrtcProfileIds.has(String(d?.profile_id));
        const suffixWebrtcDevice = devices.find(endsWithWebrtcSuffix) ?? null;
        const webrtcDevice =
          (suffixWebrtcDevice && (webrtcProfileIds.size === 0 || profileIsWebrtc(suffixWebrtcDevice))
            ? suffixWebrtcDevice
            : null) ??
          (webrtcProfileIds.size > 0
            ? devices.find(profileIsWebrtc)
            : null) ??
          null;
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
        if (webrtcEnabled) {
          syncFoundWebrtcExtension = true;
          const endpointName = pbxDeviceName || pbxSipUsername;
          if (endpointName) webrtcEndpointNames.push(endpointName);
        }
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
        seenExtNumbers.add(extNumber);

        try {
          // 4a. Upsert the Connect Extension record
          const connectExt = await db.extension.upsert({
            where: { tenantId_extNumber: { tenantId: resolvedTenantId, extNumber } },
            create: {
              tenantId: resolvedTenantId,
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
              tenantId: resolvedTenantId,
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
                if (existingUser.tenantId === resolvedTenantId) {
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
                    tenantId: resolvedTenantId,
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
      // 5. Deactivate extensions that VitalPBX no longer returns for this tenant.
      //    Only applies when VitalPBX returned at least one extension (guards against
      //    an empty response from a transient API error wiping out real extensions).
      if (seenExtNumbers.size > 0) {
        try {
          const deactivated = await db.extension.updateMany({
            where: {
              tenantId: resolvedTenantId,
              status: "ACTIVE",
              extNumber: { notIn: Array.from(seenExtNumbers) },
            },
            data: { status: "INACTIVE", updatedAt: new Date() },
          });
          if (deactivated.count > 0) {
            tenantResult.extensionsDeactivated = deactivated.count;
            result.totalDeactivated += deactivated.count;
          }
        } catch {
          // Non-fatal — stale extensions will simply remain until the next sync
        }
      }

      // 6. Auto-enable WebRTC on the tenant if it isn't already and we confirmed
      //    at least one WebRTC-capable extension exists on the PBX.  This prevents
      //    new tenants from being silently stuck: phone "not registered" / no QR code
      //    because Tenant.webrtcEnabled defaulted to false even though the PBX side
      //    is fully wired up.
      if (syncFoundWebrtcExtension) {
        try {
          const tenantRow = await db.tenant.findUnique({
            where: { id: resolvedTenantId },
            select: { webrtcEnabled: true, sipWsUrl: true, sipDomain: true },
          });
          if (tenantRow && !tenantRow.webrtcEnabled) {
            // Derive defaults from the PBX_WS_ENDPOINT env var (e.g. wss://host:8089/ws)
            // so the tenant immediately gets working SIP credentials without manual setup.
            const rawWsEndpoint = process.env.PBX_WS_ENDPOINT?.trim() || null;
            const derivedDomain = rawWsEndpoint
              ? (() => { try { return new URL(rawWsEndpoint.replace(/^wss?:\/\//, "https://")).hostname; } catch { return null; } })()
              : null;
            await db.tenant.update({
              where: { id: resolvedTenantId },
              data: {
                webrtcEnabled: true,
                ...(!tenantRow.sipWsUrl && rawWsEndpoint ? { sipWsUrl: rawWsEndpoint } : {}),
                ...(!tenantRow.sipDomain && derivedDomain ? { sipDomain: derivedDomain } : {}),
              },
            });
          }
        } catch {
          // Non-fatal — tenant will work once an admin manually enables WebRTC
        }
      }

      // 7. Auto-apply VitalPBX "Apply Changes" when this tenant has a WebRTC
      //    endpoint that has NEVER gone live. This closes the recurring "new
      //    tenant: SIP synced, phone won't register" gap: VitalPBX holds the
      //    `_1` device in its config DB, but it is only pushed into the running
      //    Asterisk config (so it becomes registerable) when "Apply Changes"
      //    regenerates + reloads. Nothing in the provisioning pipeline triggered
      //    that automatically before. We only apply when an endpoint is genuinely
      //    un-live (so healthy tenants are never needlessly reloaded), the caller
      //    opted in (admin refresh / per-user sync — never the warm cycle), and
      //    not more often than the per-tenant cooldown.
      if (
        options?.applyChangesForUnliveWebrtc &&
        syncFoundWebrtcExtension &&
        webrtcEndpointNames.length > 0
      ) {
        try {
          const regs = await db.pbxEndpointRegistration.findMany({
            where: { endpoint: { in: webrtcEndpointNames } },
            select: { endpoint: true, status: true, lastRegisteredAt: true },
          });
          const everLive = new Map<string, boolean>();
          for (const r of regs) {
            const live =
              String(r.status ?? "").trim().toUpperCase() === "REGISTERED" ||
              r.lastRegisteredAt != null;
            everLive.set(r.endpoint, live);
          }
          const hasNeverLiveEndpoint = webrtcEndpointNames.some(
            (name) => !everLive.get(name),
          );
          const cooldownKey = `${pbxInstanceId}:${td.vitalTenantId}`;
          const lastAppliedAt = AUTO_APPLY_LAST_AT.get(cooldownKey) ?? 0;
          const cooldownPassed = Date.now() - lastAppliedAt >= AUTO_APPLY_COOLDOWN_MS;
          if (hasNeverLiveEndpoint && cooldownPassed) {
            AUTO_APPLY_LAST_AT.set(cooldownKey, Date.now());
            try {
              await client.syncTenant(td.vitalTenantId);
              tenantResult.appliedChanges = true;
              tenantResult.applyError = null;
              result.totalAppliedChanges++;
            } catch (applyErr: any) {
              // "Invalid Operation" = VitalPBX had nothing queued to apply (the
              // device is in its DB but no pending change to flush). Non-fatal:
              // the truthful health warning still surfaces so the admin knows to
              // re-save the device in VitalPBX. Any other error is recorded too.
              tenantResult.appliedChanges = false;
              tenantResult.applyError = String(applyErr?.message ?? applyErr);
            }
          }
        } catch {
          // Non-fatal — registration lookup failed; skip auto-apply this pass.
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
