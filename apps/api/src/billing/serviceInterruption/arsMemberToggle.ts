/**
 * Switching a tenant's outbound route members on and off, through the panel's
 * own route-selection form.
 *
 * ⛔⛔ `members[N][enabled]` IS A CHECKBOX. A real browser OMITS an unchecked
 * box, and the panel reads *field present* as *ticked* whatever the value —
 * so posting `enabled=0` or `enabled=no` would switch the member ON. Disabling
 * means REMOVING the pair. This is the identical trap already recorded for
 * `autofill`/`autopause` in `pbx/teamBuilder.ts:228` ("that is how a trunk got
 * disabled during onboarding"). Getting it backwards means the cutoff reports
 * success and does nothing.
 *
 * ⛔⛔ THE FORM IS A FULL REPLACE. Every member must be posted back or it is
 * DELETED. So this never rebuilds the form — it loads the real one, edits the
 * pairs, and posts them back, exactly as `pbxTenantBuild` does for extensions.
 * A tenant's outbound routing is not something to reconstruct from memory.
 *
 * ⛔ ARS rows live under `tenant_id 1`, so this works in the MAIN tenant
 * context, not the customer's — in the customer's context the route select
 * offers 1 option instead of 56.
 *
 * ⛔⛔ AND THE REGEN AFTERWARDS MUST ALSO RUN IN THE MAIN TENANT.
 * Flipping the flag changes `ombu_ars_members` only. Asterisk routes from the
 * generated dialplan, and `ARS-<id>` / `trk-group-<id>` are rendered into
 * `extensions__50-1-dialplan.conf` — TENANT 1's file — because every outbound
 * route and route selection lives under `tenant_id 1`.
 *
 * Proven live on Loopcom Demo, 2026-08-18: disabling the member and
 * regenerating the CUSTOMER's tenant left `8455551234@T102_ARS-all` resolving
 * happily through `trk-group-123`. The customer could still dial out while the
 * database said "disabled" — a cutoff that silently does nothing. Regenerating
 * the MAIN tenant instead produced "There is no existence of
 * 8455551234@T102_ARS-all", and restoring put the include straight back.
 *
 * ⛔ So `applyArsRegen` below is the ONLY sanctioned way to make an ARS change
 * take effect. Never regenerate the customer's own tenant for this.
 */

import {
  type PanelSession,
  applyChanges,
  assertSaved,
  dropPairs,
  parseFormPairs,
  upsertPair,
} from "../../onboarding/panelClient";

export type MemberRow = { index: number; outboundRouteId: string; enabled: boolean };

/** Read the members out of a loaded ARS edit form, with their form indexes. */
export function readMemberRows(pairs: Array<[string, string]>): MemberRow[] {
  const byIndex = new Map<number, { outboundRouteId?: string; enabled: boolean }>();
  for (const [k, v] of pairs) {
    const m = /^members\[(\d+)\]\[(outbound_route_id|enabled)\]$/.exec(k);
    if (!m) continue; // skips the {{row-count-placeholder}} template row
    const i = Number(m[1]);
    const slot = byIndex.get(i) ?? { enabled: false };
    if (m[2] === "outbound_route_id") slot.outboundRouteId = v;
    // Presence is what counts — the value may be "1" or "yes" depending on
    // whether the form was rendered for add or for edit.
    if (m[2] === "enabled") slot.enabled = true;
    byIndex.set(i, slot);
  }
  return [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, s]) => s.outboundRouteId)
    .map(([index, s]) => ({ index, outboundRouteId: s.outboundRouteId!, enabled: s.enabled }));
}

export type ToggleResult = { pairs: Array<[string, string]>; changed: MemberRow[] };

/**
 * Turn the named routes on or off within one loaded form.
 * Members not named keep whatever state the form already had.
 */
export function toggleMembers(
  formPairs: Array<[string, string]>,
  change: { outboundRouteIds: Set<string>; enabled: boolean },
): ToggleResult {
  let pairs = formPairs.map(([k, v]) => [k, v] as [string, string]);
  const rows = readMemberRows(pairs);
  const changed: MemberRow[] = [];

  for (const row of rows) {
    if (!change.outboundRouteIds.has(row.outboundRouteId)) continue;
    if (row.enabled === change.enabled) continue; // already right — leave it
    if (change.enabled) {
      upsertPair(pairs, `members[${row.index}][enabled]`, "1");
    } else {
      // ⛔ REMOVE it. Setting it to "0" would tick the box.
      pairs = dropPairs(pairs, `members[${row.index}][enabled]`);
    }
    changed.push({ ...row, enabled: change.enabled });
  }

  // The template row must never be submitted as a real member.
  pairs = pairs.filter(([k]) => !k.includes("{{row-count-placeholder}}"));
  upsertPair(pairs, "mode", "edit");
  upsertPair(pairs, "method", "put");
  return { pairs, changed };
}

export class ArsToggleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArsToggleError";
  }
}

/**
 * Load one route selection, flip the named members, post it back.
 * Returns what actually changed, so an interruption records exactly the
 * members it switched off and the restore puts back exactly those.
 */
export async function setMembersEnabled(
  s: PanelSession,
  params: {
    mainTenantPath: string;
    arsId: string;
    outboundRouteIds: string[];
    enabled: boolean;
  },
): Promise<MemberRow[]> {
  if (params.outboundRouteIds.length === 0) return [];
  s.setTenant(params.mainTenantPath);

  const html = await s.loadForm("ars", "edit", params.arsId);
  const pairs = parseFormPairs(html);

  // ⛔ Refuse a form that did not load the row. A blank add-form posted back
  // would replace the customer's whole route selection with nothing.
  const mode = pairs.find(([k]) => k === "mode")?.[1];
  const arsId = pairs.find(([k]) => k === "ars_id")?.[1];
  if (mode !== "edit" || arsId !== params.arsId) {
    throw new ArsToggleError(
      `Route selection ${params.arsId} did not load for editing (mode=${mode}, ars_id=${arsId}). ` +
        `Refusing to post — this form is a full replace and would delete the tenant's outbound routes.`,
    );
  }
  const before = readMemberRows(pairs);
  if (before.length === 0) {
    throw new ArsToggleError(
      `Route selection ${params.arsId} loaded with no members. Refusing to post a form that would ` +
        `delete whatever is really there.`,
    );
  }

  const { pairs: next, changed } = toggleMembers(pairs, {
    outboundRouteIds: new Set(params.outboundRouteIds),
    enabled: params.enabled,
  });

  // Every member that was there must still be there.
  const after = readMemberRows(next);
  if (after.length !== before.length) {
    throw new ArsToggleError(
      `Refusing to post: ${before.length} members went in, ${after.length} came out.`,
    );
  }

  if (changed.length === 0) return [];
  assertSaved("ars-member-toggle", await s.post(next));
  return changed;
}

/**
 * Make an ARS member change take effect.
 *
 * ⛔ Regenerates the MAIN tenant — see the header. Regenerating the customer's
 * own tenant is a no-op for route selections and leaves them dialling out.
 * ⛔ An apply wipes the Connect doorway off regenerated routes, so the caller
 * MUST re-bake immediately after (`rebakeConnectRoutesAfterRegen`), for every
 * Connect-mode tenant, not just the one being cut off — an apply flushes other
 * tenants' pending changes too.
 */
export async function applyArsRegen(
  s: PanelSession,
  params: { mainTenantPath: string },
): Promise<void> {
  s.setTenant(params.mainTenantPath);
  await applyChanges(s, "ars-member-toggle");
}
