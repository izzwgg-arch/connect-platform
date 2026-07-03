// Pure logic for POST /mobile/dnd-status, extracted so the request-shape
// validation and the "which of the caller's own extensions can we publish
// DND for" decision are unit-testable without a DB or an HTTP client.
//
// This is the Connect-owned, mobile-app-level DND signal (apps/mobile/src/sip/dndStore.ts)
// — NOT VitalPBX's native feature-code DND. It exists solely to let
// [connect-wake-core]'s DND short-circuit (scripts/pbx/install-connect-wake-dialplan.sh)
// skip ConnectWake/grace/ringback for a swiped-away app that has DND on.

export type DndStatusParsed = { ok: true; dnd: boolean } | { ok: false; error: string };

/** Validates the mobile client's raw POST /mobile/dnd-status body. */
export function parseDndStatusBody(body: unknown): DndStatusParsed {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b["dnd"] !== "boolean") return { ok: false, error: "dnd must be a boolean" };
  return { ok: true, dnd: b["dnd"] as boolean };
}

const NUMERIC_ID_RE = /^\d{1,10}$/;

/**
 * Splits the caller's owned extension numbers into ones we CAN publish DND
 * for (numeric extNumber + a resolved numeric pbxTenantId for the caller's
 * tenant) and ones we skip, with a reason. Never throws.
 *
 * A null/non-numeric pbxTenantId (tenant has no TenantPbxLink yet, or the
 * link's pbxTenantId is empty) skips EVERY extension — matches the documented
 * "no PBX link ⇒ not an error, just an empty publish" behavior of the route.
 */
export function planDndPublishTargets(
  extNumbers: string[],
  pbxTenantId: string | null,
): { publishable: string[]; skipped: Array<{ extNumber: string; reason: string }> } {
  const publishable: string[] = [];
  const skipped: Array<{ extNumber: string; reason: string }> = [];
  const tenantLinked = typeof pbxTenantId === "string" && NUMERIC_ID_RE.test(pbxTenantId);

  for (const extNumber of extNumbers) {
    if (!tenantLinked) {
      skipped.push({ extNumber, reason: "no_pbx_tenant_link" });
      continue;
    }
    if (!NUMERIC_ID_RE.test(extNumber)) {
      skipped.push({ extNumber, reason: "non_numeric_extension" });
      continue;
    }
    publishable.push(extNumber);
  }
  return { publishable, skipped };
}

export type DndPublishPayload = {
  pbxTenantId: string;
  extension: string;
  dnd: "0" | "1";
  ts: string;
};

/** Builds the exact body sent to telephony's /telephony/internal/dnd-publish for one extension. */
export function buildDndPublishPayload(
  pbxTenantId: string,
  extNumber: string,
  dnd: boolean,
  nowMs: number,
): DndPublishPayload {
  return {
    pbxTenantId,
    extension: extNumber,
    dnd: dnd ? "1" : "0",
    ts: String(Math.floor(nowMs / 1000)),
  };
}
