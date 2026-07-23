// Tenant delivery settings — feature flag + config. Mirrors the CrmTenantSettings pattern.
import { db } from "@connect/db";

export const DELIVERY_SETTINGS_DEFAULTS = {
  enabled: false,
  mapReveal: "PROGRESSIVE", // PROGRESSIVE | FULL | NONE
  exactPinStopsAway: 1,
  verifyTier: "TIERED", // TIERED | STRICT | LIGHT
  voiceMode: "PRERECORDED_NUMBER_PLAYBACK", // | TTS | COARSE
  retentionDays: 30,
  notifyOutForDelivery: true,
  notifyDelayed: true,
  notifyDelivered: true,
  notifyApproaching: false,
} as const;

export async function getDeliverySettings(tenantId: string) {
  const row = await db.deliveryTenantSettings.findUnique({ where: { tenantId } });
  return row ?? { tenantId, ...DELIVERY_SETTINGS_DEFAULTS };
}

export async function isDeliveryEnabled(tenantId: string): Promise<boolean> {
  const row = await db.deliveryTenantSettings.findUnique({ where: { tenantId }, select: { enabled: true } });
  return Boolean(row?.enabled);
}
