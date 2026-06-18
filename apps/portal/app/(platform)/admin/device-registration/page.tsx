"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "../../../../components/PageHeader";
import { RoleGate } from "../../../../components/RoleGate";
import { apiGet } from "../../../../services/apiClient";

// ── Types ─────────────────────────────────────────────────────────────────────

type RegStatus = "REGISTERED" | "UNREACHABLE" | "UNREGISTERED" | "UNKNOWN";

interface RegDevice {
  id: string;
  model: string | null;
  manufacturer: string | null;
  osVersion: string | null;
  appVersion: string | null;
  lastSeenAt: string | null;
  keepAliveSnapshot: {
    isRunning?: boolean;
    serviceCreatedAtMs?: number;
    lastForegroundResult?: string;
    lastForegroundTypeUsed?: string;
    lastForegroundErrorClass?: string;
    // 2026-06-17 hardening additions.
    foregroundLandedAtMs?: number;
    process?: string;
    rearmCount?: number;
    batteryOptimizationIgnored?: boolean;
    // Adaptive activation gate.
    gateNeeded?: boolean;
    gateReason?: string;
    gateLatchedAtMs?: number;
    gateDropCount?: number;
  } | null;
}

interface RegRow {
  endpoint: string;
  status: RegStatus;
  rawStatus: string | null;
  tenantId: string | null;
  extNumber: string | null;
  pbxTenantNumber: string | null;
  isWebrtcDevice: boolean;
  contactUri: string | null;
  userAgent: string | null;
  roundtripUsec: string | null;
  lastRegisteredAt: string | null;
  lastUnreachableAt: string | null;
  lastUnregisteredAt: string | null;
  lastEventAt: string;
  notRegisteredForSec: number;
  extension: {
    id: string;
    extNumber: string;
    displayName: string;
    owner: { id: string; email: string; name: string } | null;
  } | null;
  devices: RegDevice[];
}

interface RegistrationsResponse {
  count: number;
  registrations: RegRow[];
}

interface RegEvent {
  id: string;
  status: RegStatus;
  rawStatus: string | null;
  contactUri: string | null;
  userAgent: string | null;
  details: Record<string, unknown> | null;
  occurredAt: string;
}

interface EventsResponse {
  endpoint: string;
  current: RegRow & Record<string, unknown>;
  events: RegEvent[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<RegStatus, string> = {
  REGISTERED: "#1a7f37",
  UNREACHABLE: "#bf8700",
  UNREGISTERED: "#cf222e",
  UNKNOWN: "#6e7781",
};

function fmtDuration(sec: number): string {
  if (!sec || sec <= 0) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function StatusPill({ status }: { status: RegStatus }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color: "#fff",
        background: STATUS_COLOR[status] || "#6e7781",
      }}
    >
      {status}
    </span>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

function DeviceRegistrationInner() {
  const [rows, setRows] = useState<RegRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webrtcOnly, setWebrtcOnly] = useState(true);
  const [statusFilter, setStatusFilter] = useState<"" | RegStatus>("");
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<EventsResponse | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("limit", "300");
      if (webrtcOnly) params.set("webrtcOnly", "1");
      if (statusFilter) params.set("status", statusFilter);
      const res = await apiGet<RegistrationsResponse>(`/admin/pbx/registrations?${params.toString()}`);
      setRows(res.registrations || []);
    } catch (e: any) {
      setError(e?.message || "Failed to load registrations");
    } finally {
      setLoading(false);
    }
  }, [webrtcOnly, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadEvents = useCallback(async (endpoint: string) => {
    setSelected(endpoint);
    setEvents(null);
    setEventsLoading(true);
    try {
      const res = await apiGet<EventsResponse>(`/admin/pbx/registrations/${encodeURIComponent(endpoint)}/events`);
      setEvents(res);
    } catch (e: any) {
      setError(e?.message || "Failed to load timeline");
    } finally {
      setEventsLoading(false);
    }
  }, []);

  const summary = useMemo(() => {
    const s = { REGISTERED: 0, UNREACHABLE: 0, UNREGISTERED: 0, UNKNOWN: 0 } as Record<RegStatus, number>;
    for (const r of rows) s[r.status] = (s[r.status] || 0) + 1;
    return s;
  }, [rows]);

  return (
    <div style={{ padding: 16, maxWidth: 1200, margin: "0 auto" }}>
      <PageHeader
        title="Device Registration"
        subtitle="Authoritative PBX-side registration state per mobile/WebRTC endpoint."
      />

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", margin: "12px 0" }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 14 }}>
          <input type="checkbox" checked={webrtcOnly} onChange={(e) => setWebrtcOnly(e.target.checked)} />
          WebRTC/mobile only
        </label>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as "" | RegStatus)}
          style={{ padding: "4px 8px" }}
        >
          <option value="">All statuses</option>
          <option value="REGISTERED">Registered</option>
          <option value="UNREACHABLE">Unreachable</option>
          <option value="UNREGISTERED">Unregistered</option>
          <option value="UNKNOWN">Unknown</option>
        </select>
        <button onClick={() => void load()} disabled={loading} style={{ padding: "4px 12px" }}>
          {loading ? "Loading…" : "Refresh"}
        </button>
        <span style={{ fontSize: 13, color: "#57606a" }}>
          ✅ {summary.REGISTERED} · ⚠️ {summary.UNREACHABLE} · ❌ {summary.UNREGISTERED} · ❔ {summary.UNKNOWN}
        </span>
      </div>

      {error && <div className="state-box" style={{ color: "#cf222e", marginBottom: 12 }}>{error}</div>}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "2px solid #d0d7de" }}>
              <th style={{ padding: "8px 6px" }}>Endpoint</th>
              <th style={{ padding: "8px 6px" }}>Status</th>
              <th style={{ padding: "8px 6px" }}>Not reg. for</th>
              <th style={{ padding: "8px 6px" }}>Ext / Owner</th>
              <th style={{ padding: "8px 6px" }}>Device(s)</th>
              <th style={{ padding: "8px 6px" }}>FGS keep-alive</th>
              <th style={{ padding: "8px 6px" }}>Last event</th>
              <th style={{ padding: "8px 6px" }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const fgs = r.devices[0]?.keepAliveSnapshot;
              // Honest health: the FGS is only truly armed when startForeground
              // actually LANDED (foregroundLandedAtMs > 0) AND it claims running.
              // A snapshot with isRunning=true but no foregroundLandedAtMs (or
              // serviceCreatedAtMs=0) is NOT healthy — that exact false-positive
              // is what hid the T25/101 S25 drop. Older app builds that don't
              // report foregroundLandedAtMs fall back to the legacy heuristic.
              const hasLandedField = fgs?.foregroundLandedAtMs !== undefined;
              // Adaptive gate: when gateNeeded===false the keep-alive FGS is
              // INTENTIONALLY off (this device delivers calls fine in the
              // background and has not observed a drop). That is the healthy
              // default — render it neutral, not as a failure.
              const gateDormant = fgs?.gateNeeded === false;
              const fgsHealthy = hasLandedField
                ? Boolean(fgs?.foregroundLandedAtMs && fgs?.isRunning && fgs?.serviceCreatedAtMs)
                : fgs?.lastForegroundResult === "ok";
              const fgsLabel = !fgs
                ? "—"
                : gateDormant
                  ? "dormant (not needed)"
                  : fgsHealthy
                    ? `ok (${fgs.lastForegroundTypeUsed || "?"})${fgs.rearmCount ? ` ×${fgs.rearmCount}` : ""}`
                    : hasLandedField && !fgs.foregroundLandedAtMs
                      ? `never foregrounded${fgs.lastForegroundErrorClass ? ` (${fgs.lastForegroundErrorClass})` : fgs.lastForegroundResult ? ` (${fgs.lastForegroundResult})` : ""}`
                      : fgs.isRunning === false
                        ? `not running${fgs.lastForegroundErrorClass ? ` (${fgs.lastForegroundErrorClass})` : ""}`
                        : (fgs.lastForegroundResult || "—");
              return (
                <tr key={r.endpoint} style={{ borderBottom: "1px solid #eaeef2" }}>
                  <td style={{ padding: "8px 6px", fontFamily: "monospace" }}>{r.endpoint}</td>
                  <td style={{ padding: "8px 6px" }}><StatusPill status={r.status} /></td>
                  <td style={{ padding: "8px 6px", color: r.notRegisteredForSec > 300 ? "#cf222e" : "#57606a" }}>
                    {fmtDuration(r.notRegisteredForSec)}
                  </td>
                  <td style={{ padding: "8px 6px" }}>
                    {r.extension ? (
                      <>
                        <strong>{r.extension.extNumber}</strong> · {r.extension.displayName}
                        {r.extension.owner && (
                          <div style={{ color: "#57606a", fontSize: 12 }}>{r.extension.owner.name}</div>
                        )}
                      </>
                    ) : (
                      <span style={{ color: "#8c959f" }}>unresolved</span>
                    )}
                  </td>
                  <td style={{ padding: "8px 6px" }}>
                    {r.devices.length === 0
                      ? <span style={{ color: "#8c959f" }}>—</span>
                      : r.devices.map((d) => (
                          <div key={d.id} style={{ fontSize: 12 }}>
                            {d.model || "?"}{d.osVersion ? ` (OS ${d.osVersion})` : ""}
                          </div>
                        ))}
                  </td>
                  <td style={{ padding: "8px 6px", fontSize: 12, color: !fgs ? "#8c959f" : gateDormant ? "#8c959f" : fgsHealthy ? "#1a7f37" : "#cf222e" }}>
                    {fgsLabel}
                    {!gateDormant && fgs?.gateNeeded && fgs?.gateReason && (
                      <div style={{ fontSize: 10, color: "#57606a" }}>latched: {fgs.gateReason}</div>
                    )}
                    {!gateDormant && fgs?.process && fgs.process.includes(":") && (
                      <div style={{ fontSize: 10, color: "#cf222e" }}>proc={fgs.process}</div>
                    )}
                    {!gateDormant && fgs?.batteryOptimizationIgnored === false && (
                      <div style={{ fontSize: 10, color: "#bf8700" }}>battery-opt ON</div>
                    )}
                  </td>
                  <td style={{ padding: "8px 6px", fontSize: 12 }}>{fmtTime(r.lastEventAt)}</td>
                  <td style={{ padding: "8px 6px" }}>
                    <button onClick={() => void loadEvents(r.endpoint)} style={{ padding: "2px 8px", fontSize: 12 }}>
                      Timeline
                    </button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && !loading && (
              <tr><td colSpan={8} style={{ padding: 16, color: "#8c959f" }}>No registrations recorded yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="state-box" style={{ marginTop: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0, fontFamily: "monospace" }}>Timeline — {selected}</h3>
            <button onClick={() => { setSelected(null); setEvents(null); }} style={{ padding: "2px 8px" }}>Close</button>
          </div>
          {eventsLoading && <div style={{ marginTop: 8 }}>Loading timeline…</div>}
          {events && (
            <ol style={{ marginTop: 8, paddingLeft: 18 }}>
              {events.events.map((e) => (
                <li key={e.id} style={{ marginBottom: 6 }}>
                  <StatusPill status={e.status} />{" "}
                  <span style={{ fontSize: 12, color: "#57606a" }}>{fmtTime(e.occurredAt)}</span>
                  {e.rawStatus && <span style={{ fontSize: 12 }}> · raw={e.rawStatus}</span>}
                  {e.contactUri && <div style={{ fontSize: 11, color: "#8c959f", fontFamily: "monospace" }}>{e.contactUri}</div>}
                </li>
              ))}
              {events.events.length === 0 && <li style={{ color: "#8c959f" }}>No transitions recorded.</li>}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

export default function DeviceRegistrationPage() {
  return (
    <RoleGate
      allow={["SUPER_ADMIN", "TENANT_ADMIN"]}
      fallback={<div className="state-box">You do not have admin access.</div>}
    >
      <DeviceRegistrationInner />
    </RoleGate>
  );
}
