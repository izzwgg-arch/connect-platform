"use client";

import { useMemo, useState } from "react";
import { useTelephony } from "../contexts/TelephonyContext";
import { useAppContext } from "../hooks/useAppContext";
import { callsForTenant } from "../services/liveCallState";

// ── Types ─────────────────────────────────────────────────────────────────────

type PresenceState = "registered" | "ringing" | "active" | "offline" | "busy";

interface ExtensionTile {
  extension: string;
  displayName: string;
  state: PresenceState;
  callerId?: string;
  durationSec?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapAmiState(rawState: string, activeCalls: Set<string>, ringingCalls: Set<string>): PresenceState {
  if (ringingCalls.has(rawState)) return "ringing";
  if (activeCalls.has(rawState)) return "active";
  const s = String(rawState ?? "").toLowerCase();
  if (s === "not_inuse" || s === "idle" || s === "registered" || s === "0") return "registered";
  if (s === "inuse" || s === "1") return "active";
  if (s === "ringing" || s === "2") return "ringing";
  if (s === "busy" || s === "3") return "busy";
  if (s === "unavailable" || s === "5" || s === "unregistered") return "offline";
  return "offline";
}

const STATE_STYLES: Record<PresenceState, { bg: string; dot: string; label: string; animate: boolean }> = {
  registered: { bg: "rgba(52,194,123,0.10)", dot: "var(--success)",  label: "Available", animate: false },
  ringing:    { bg: "rgba(234,96,104,0.12)", dot: "var(--danger)",   label: "Ringing",   animate: true  },
  active:     { bg: "rgba(234,96,104,0.18)", dot: "var(--danger)",   label: "On Call",   animate: false },
  busy:       { bg: "rgba(240,182,85,0.12)", dot: "var(--warning)",  label: "Busy",      animate: false },
  offline:    { bg: "rgba(142,160,178,0.08)", dot: "var(--text-dim)", label: "Offline",  animate: false },
};

// ── Tile ──────────────────────────────────────────────────────────────────────

function ExtensionTileCard({ tile, onCall }: { tile: ExtensionTile; onCall?: (ext: string) => void }) {
  const style = STATE_STYLES[tile.state];

  return (
    <div
      style={{
        background: style.bg,
        border: `1px solid var(--border)`,
        borderRadius: 10,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        minWidth: 0,
        position: "relative",
        cursor: onCall ? "pointer" : "default",
        transition: "background 0.2s",
      }}
      title={onCall ? `Call ${tile.extension}` : undefined}
      onClick={onCall ? () => onCall(tile.extension) : undefined}
    >
      {/* Presence dot */}
      <div style={{
        position: "absolute",
        top: 10,
        right: 10,
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: style.dot,
        boxShadow: `0 0 0 2px var(--panel)`,
        animation: style.animate ? "presence-pulse 1.2s ease-in-out infinite" : undefined,
      }} />

      {/* Extension avatar */}
      <div style={{
        width: 36,
        height: 36,
        borderRadius: 8,
        background: "var(--panel-2)",
        border: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 13,
        fontWeight: 700,
        color: "var(--text-dim)",
        letterSpacing: "0.5px",
      }}>
        {tile.displayName ? tile.displayName.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase() : tile.extension.slice(0, 3)}
      </div>

      {/* Name + ext */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {tile.displayName || tile.extension}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Ext {tile.extension}</div>
      </div>

      {/* State */}
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <span style={{ fontSize: 11, color: style.dot, fontWeight: 600 }}>{style.label}</span>
        {tile.callerId && tile.state !== "registered" && tile.state !== "offline" ? (
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>· {tile.callerId}</span>
        ) : null}
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

interface PresenceGridProps {
  /** Called when user clicks a tile — passes extension number to dial */
  onDial?: (extension: string) => void;
  /** Filter to specific extensions */
  filter?: string[];
  /** Max tiles to show (0 = unlimited) */
  limit?: number;
  /** Show offline extensions */
  showOffline?: boolean;
}

export function PresenceGrid({
  onDial,
  filter,
  limit = 0,
  showOffline = true,
}: PresenceGridProps) {
  const telephony = useTelephony();
  const { adminScope, tenantId } = useAppContext();
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<PresenceState | "all">("all");
  const scopedCalls = useMemo(
    () =>
      callsForTenant(
        telephony.activeCalls,
        adminScope === "GLOBAL" ? null : tenantId,
        telephony.extensionList.map((entry) => ({ extension: entry.extension, tenantId: entry.tenantId })),
      ),
    [adminScope, telephony.activeCalls, telephony.extensionList, tenantId],
  );

  // Build active/ringing sets from live calls
  const { activeExtensions, ringingExtensions } = useMemo(() => {
    const active = new Set<string>();
    const ringing = new Set<string>();
    scopedCalls.forEach((call) => {
      const exts = call.extensions ?? [];
      if (call.state === "up" || call.state === "held") {
        exts.forEach((e) => active.add(e));
      } else if (call.state === "ringing" || call.state === "dialing") {
        exts.forEach((e) => ringing.add(e));
      }
    });
    return { activeExtensions: active, ringingExtensions: ringing };
  }, [scopedCalls]);

  const tiles: ExtensionTile[] = useMemo(() => {
    const extMap = (telephony.extensionList ?? []).filter(
      (ext) => adminScope === "GLOBAL" || !ext.tenantId || ext.tenantId === tenantId,
    );
    let entries = extMap.map((ext): ExtensionTile => ({
      extension: ext.extension,
      displayName: ext.hint || ext.extension,
      state: mapAmiState(ext.status ?? "offline", activeExtensions, ringingExtensions),
      callerId: undefined,
    }));

    if (filter?.length) {
      entries = entries.filter((e) => filter.includes(e.extension));
    }

    if (!showOffline) {
      entries = entries.filter((e) => e.state !== "offline");
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      entries = entries.filter((e) =>
        e.extension.includes(q) || (e.displayName ?? "").toLowerCase().includes(q)
      );
    }

    if (stateFilter !== "all") {
      entries = entries.filter((e) => e.state === stateFilter);
    }

    // Sort: active/ringing first, then registered, then offline
    const ORDER: Record<PresenceState, number> = { ringing: 0, active: 1, busy: 2, registered: 3, offline: 4 };
    entries.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.extension.localeCompare(b.extension));

    if (limit > 0) entries = entries.slice(0, limit);

    return entries;
  }, [
    telephony.extensionList, adminScope, tenantId, activeExtensions, ringingExtensions,
    filter, showOffline, search, stateFilter, limit,
  ]);

  const counts = useMemo(() => {
    return {
      total: tiles.length,
      active:     tiles.filter((t) => t.state === "active").length,
      ringing:    tiles.filter((t) => t.state === "ringing").length,
      registered: tiles.filter((t) => t.state === "registered").length,
      offline:    tiles.filter((t) => t.state === "offline").length,
    };
  }, [tiles]);

  const isLive = telephony.isLive;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Header bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <input
          className="input"
          style={{ width: 200, flexShrink: 0 }}
          placeholder="Search extensions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="select"
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value as PresenceState | "all")}
          style={{ width: 150 }}
        >
          <option value="all">All States</option>
          <option value="registered">Available</option>
          <option value="ringing">Ringing</option>
          <option value="active">On Call</option>
          <option value="busy">Busy</option>
          <option value="offline">Offline</option>
        </select>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8, fontSize: 12, flexWrap: "wrap" }}>
          {counts.active > 0 ? (
            <span style={{ color: "var(--danger)", fontWeight: 600 }}>
              {counts.active} on call
            </span>
          ) : null}
          {counts.ringing > 0 ? (
            <span style={{ color: "var(--danger)", fontWeight: 600 }}>
              {counts.ringing} ringing
            </span>
          ) : null}
          <span style={{ color: "var(--success)" }}>{counts.registered} available</span>
          <span style={{ color: "var(--text-dim)" }}>{counts.offline} offline</span>
          {!isLive ? (
            <span style={{ color: "var(--warning)", fontSize: 11 }}>⚠ Reconnecting…</span>
          ) : null}
        </div>
      </div>

      {/* Grid */}
      {tiles.length === 0 ? (
        <div className="state-box" style={{ padding: 24, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
          {search || stateFilter !== "all"
            ? "No extensions match the current filter."
            : isLive
              ? "No extension state data yet — waiting for AMI events."
              : "Connecting to telephony service…"}
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
            gap: 10,
          }}
        >
          {tiles.map((tile) => (
            <ExtensionTileCard key={tile.extension} tile={tile} onCall={onDial} />
          ))}
        </div>
      )}
    </div>
  );
}
