// Mobile delivery API client. Mirrors apps/mobile/src/api/client.ts conventions
// (fetch + Bearer token param, API_BASE from EXPO_PUBLIC_API_BASE_URL).

import { API_BASE } from "../api/client";
import type { QueuedOp, SyncResult } from "./offlineQueue";

async function parseJson(res: Response) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export interface ScanResponse {
  ok: boolean;
  orderId?: string;
  idempotent?: boolean;
  decision?: { outcome: string; code: string; canAssign: boolean; needsConfirmation: boolean; message: string };
}

export async function scanLabel(
  token: string,
  body: { token: string; clientOpId: string; confirmReassign?: boolean },
): Promise<ScanResponse> {
  const res = await fetch(`${API_BASE}/mobile/delivery/scan`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await parseJson(res);
  if (!res.ok) throw Object.assign(new Error(json?.error || "SCAN_FAILED"), { status: res.status, body: json });
  return json as ScanResponse;
}

export async function getStopNav(token: string, orderId: string, app: "waze" | "google" = "waze"): Promise<{ url: string }> {
  const res = await fetch(`${API_BASE}/mobile/delivery/stops/${orderId}/nav?app=${app}`, { headers: { authorization: `Bearer ${token}` } });
  const json = await parseJson(res);
  if (!res.ok) throw Object.assign(new Error(json?.error || "NAV_FAILED"), { status: res.status, body: json });
  return json;
}

export async function markArrived(token: string, orderId: string, gps?: { lat: number; lng: number }): Promise<any> {
  const res = await fetch(`${API_BASE}/mobile/delivery/orders/${orderId}/arrive`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(gps || {}),
  });
  const json = await parseJson(res);
  if (!res.ok) throw Object.assign(new Error(json?.error || "ARRIVE_FAILED"), { status: res.status, body: json });
  return json;
}

export async function submitProof(token: string, orderId: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${API_BASE}/mobile/delivery/orders/${orderId}/proof`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  const json = await parseJson(res);
  if (!res.ok) throw Object.assign(new Error(json?.error || "PROOF_FAILED"), { status: res.status, body: json });
  return json;
}

export async function submitException(token: string, orderId: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${API_BASE}/mobile/delivery/orders/${orderId}/exception`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  const json = await parseJson(res);
  if (!res.ok) throw Object.assign(new Error(json?.error || "EXCEPTION_FAILED"), { status: res.status, body: json });
  return json;
}

export async function getRuns(token: string): Promise<any[]> {
  const res = await fetch(`${API_BASE}/mobile/delivery/runs`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const json = await parseJson(res);
  if (!res.ok) throw Object.assign(new Error(json?.error || "RUNS_FAILED"), { status: res.status, body: json });
  return Array.isArray(json) ? json : [];
}

/**
 * Sync a single queued op to its server endpoint and translate the response into a
 * SyncResult the pure queue understands. Phase 4 handles `scan`; `arrive`/`proof`/
 * `exception` endpoints arrive in Phases 5/9 — until then those kinds are left pending
 * (returned as a soft, non-incrementing hold) rather than failing.
 */
export async function syncOp(token: string, op: QueuedOp): Promise<SyncResult | null> {
  try {
    if (op.kind === "scan") {
      const r = await scanLabel(token, op.payload as any);
      const outcome = r.decision?.outcome;
      // Cross-tenant / already-assigned-without-confirm are conflicts the driver resolves.
      if (outcome === "wrong_tenant" || outcome === "wrong_store" || outcome === "already_assigned") {
        return { opId: op.opId, ok: false, conflict: true, error: outcome };
      }
      return { opId: op.opId, ok: true };
    }
    // Endpoint not implemented yet this phase — hold (leave pending), don't fail.
    return null;
  } catch (e: any) {
    if (e?.status === 409) return { opId: op.opId, ok: false, conflict: true, error: String(e?.body?.error || "conflict") };
    return { opId: op.opId, ok: false, error: String(e?.message || "network") };
  }
}
