import type { Db } from "../db.js";
import { canSee, canonicalPair, type Degree } from "../policy/graph.js";
import { DEFAULT_VISIBILITY } from "../policy/graph.js";

/**
 * Pure profile-visibility decisions. Routes fetch PrivacySetting rows +
 * degree/sameOrganization and hand them here — nobody re-derives a rule
 * inline (CONVENTIONS §3).
 */

export type Visibility = "PUBLIC" | "CONNECTIONS" | "ORGANIZATION" | "PRIVATE";
export const PROFILE_SECTIONS = Object.keys(DEFAULT_VISIBILITY);
export type ConnectionState = "none" | "pending_out" | "pending_in" | "connected";

/** Stored rows override the category defaults; anything unset keeps the default. */
export function effectiveVisibility(rows: Array<{ category: string; visibility: string }>): Record<string, Visibility> {
  const out: Record<string, Visibility> = { ...DEFAULT_VISIBILITY } as Record<string, Visibility>;
  for (const r of rows) {
    if (r.category in out) out[r.category] = r.visibility as Visibility;
  }
  return out;
}

/** One boolean per category for this viewer — the "sections" map the web renders from. */
export function sectionVisibility(vis: Record<string, Visibility>, ctx: { degree: Degree; sameOrganization: boolean }): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const key of Object.keys(vis)) out[key] = canSee(vis[key], ctx);
  return out;
}

export async function connectionStatusBetween(db: Db, viewerId: string | null, targetId: string): Promise<ConnectionState> {
  if (!viewerId || viewerId === targetId) return "none";
  const pair = canonicalPair(viewerId, targetId);
  const row = await db.connection.findUnique({ where: { aId_bId: pair }, select: { status: true, requesterId: true } });
  if (!row) return "none";
  if (row.status === "ACTIVE") return "connected";
  if (row.status === "PENDING") return row.requesterId === viewerId ? "pending_out" : "pending_in";
  return "none"; // WITHDRAWN/IGNORED/REMOVED — a fresh request is allowed again.
}

/** A connection can always message; a stranger only if the target still accepts requests. */
export function canMessagePerson(opts: { viewerPresent: boolean; connectionStatus: ConnectionState; messageRequestsAllowed: boolean }): boolean {
  if (!opts.viewerPresent) return false;
  if (opts.connectionStatus === "connected") return true;
  return opts.messageRequestsAllowed;
}

/** Calling/video reuses Loopcom Direct plumbing — both sides must actually have a Loopcom line. */
export function canCallPerson(viewerTenantId: string | null | undefined, targetTenantId: string | null | undefined): boolean {
  return !!viewerTenantId && !!targetTenantId;
}
