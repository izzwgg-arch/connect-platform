"use client";

import { useMemo, useState } from "react";
import { PageHeader } from "../../../components/PageHeader";
import { useTelephony } from "../../../contexts/TelephonyContext";
import { useSipPhone } from "../../../hooks/useSipPhone";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { apiGet } from "../../../services/apiClient";

// ── Types ─────────────────────────────────────────────────────────────────────

type PresenceState = "available" | "ringing" | "on_call" | "busy" | "away" | "dnd" | "offline";

interface TeamMember {
  id: string;
  name: string;
  extension: string;
  email?: string;
  department?: string;
  title?: string;
  avatar?: string;
  presence: PresenceState;
  callerId?: string;
}

const PRESENCE_META: Record<PresenceState, { label: string; color: string; dot: string; animate: boolean }> = {
  available: { label: "Available",  color: "var(--success)",  dot: "var(--success)",  animate: false },
  ringing:   { label: "Ringing",    color: "var(--danger)",   dot: "var(--danger)",   animate: true  },
  on_call:   { label: "On Call",    color: "var(--danger)",   dot: "var(--danger)",   animate: false },
  busy:      { label: "Busy",       color: "var(--warning)",  dot: "var(--warning)",  animate: false },
  away:      { label: "Away",       color: "var(--warning)",  dot: "var(--warning)",  animate: false },
  dnd:       { label: "Do Not Disturb", color: "var(--danger)", dot: "var(--danger)", animate: false },
  offline:   { label: "Not Registered", color: "var(--text-dim)", dot: "#555", animate: false },
};

function mapAmiPresence(
  rawState: string,
  ext: string,
  activeCalls: Set<string>,
  ringingCalls: Set<string>,
): PresenceState {
  if (ringingCalls.has(ext)) return "ringing";
  if (activeCalls.has(ext)) return "on_call";
  const s = rawState.toLowerCase();
  if (s === "not_inuse" || s === "idle" || s === "registered" || s === "0") return "available";
  if (s === "inuse" || s === "1") return "on_call";
  if (s === "ringing" || s === "2") return "ringing";
  if (s === "busy" || s === "3") return "busy";
  if (s === "away") return "away";
  if (s === "dnd") return "dnd";
  return "offline";
}

function initials(name: string): string {
  return name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

// ── Avatar ────────────────────────────────────────────────────────────────────

function Avatar({ member, size = 44 }: { member: TeamMember; size?: number }) {
  const meta = PRESENCE_META[member.presence];
  return (
    <div style={{ position: "relative", flexShrink: 0, width: size, height: size }}>
      {member.avatar ? (
        <img
          src={member.avatar}
          alt={member.name}
          style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover" }}
        />
      ) : (
        <div style={{
          width: size, height: size,
          borderRadius: "50%",
          background: "var(--panel-2)",
          border: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: size * 0.33,
          fontWeight: 700,
          color: "var(--text-dim)",
        }}>
          {initials(member.name)}
        </div>
      )}
      {/* Presence dot */}
      <span style={{
        position: "absolute",
        bottom: 1,
        right: 1,
        width: size * 0.27,
        height: size * 0.27,
        borderRadius: "50%",
        background: meta.dot,
        border: `2px solid var(--panel)`,
        animation: meta.animate ? "presence-pulse 1.2s ease-in-out infinite" : undefined,
      }} />
    </div>
  );
}

// ── Member Row ────────────────────────────────────────────────────────────────

function MemberRow({
  member,
  onCall,
  selected,
  onSelect,
}: {
  member: TeamMember;
  onCall: (ext: string) => void;
  selected: boolean;
  onSelect: (m: TeamMember) => void;
}) {
  const meta = PRESENCE_META[member.presence];
  return (
    <div
      onClick={() => onSelect(member)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 14px",
        cursor: "pointer",
        borderBottom: "1px solid var(--border)",
        background: selected ? "var(--panel-2)" : "transparent",
        transition: "background 0.12s",
      }}
      onMouseEnter={(e) => { if (!selected) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.02)"; }}
      onMouseLeave={(e) => { if (!selected) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
    >
      <Avatar member={member} size={40} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {member.name}
        </div>
        <div style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ color: meta.color, fontWeight: 500 }}>{meta.label}</span>
          <span style={{ color: "var(--text-dim)" }}>· Ext {member.extension}</span>
        </div>
      </div>
      <button
        className="icon-btn"
        onClick={(e) => { e.stopPropagation(); onCall(member.extension); }}
        title={`Call ${member.name}`}
        style={{
          width: 32, height: 32,
          borderRadius: "50%",
          background: member.presence === "available" ? "rgba(52,194,123,0.12)" : "var(--panel-2)",
          border: "1px solid var(--border)",
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 16.92v3a2 2 0 01-2.18 2 19.8 19.8 0 01-8.63-3.07A19.5 19.5 0 013.07 10.8 19.8 19.8 0 01.02 2.18 2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.9.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.34 1.85.573 2.81.7A2 2 0 0122 14h0v2.92z"/>
        </svg>
      </button>
    </div>
  );
}

// ── Detail Panel ──────────────────────────────────────────────────────────────

function MemberDetail({
  member,
  onCall,
  onClose,
}: {
  member: TeamMember;
  onCall: (ext: string) => void;
  onClose: () => void;
}) {
  const meta = PRESENCE_META[member.presence];
  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      gap: 20,
      padding: "24px 20px",
    }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button className="icon-btn" onClick={onClose} style={{ fontSize: 18 }}>✕</button>
      </div>

      {/* Profile */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center" }}>
        <Avatar member={member} size={72} />
        <div>
          <div style={{ fontSize: 18, fontWeight: 650, marginBottom: 4 }}>{member.name}</div>
          {member.title ? <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 2 }}>{member.title}</div> : null}
          {member.department ? <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{member.department}</div> : null}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{
            width: 8, height: 8, borderRadius: "50%",
            background: meta.dot,
            display: "inline-block",
            animation: meta.animate ? "presence-pulse 1.2s ease-in-out infinite" : undefined,
          }} />
          <span style={{ fontSize: 13, color: meta.color, fontWeight: 600 }}>{meta.label}</span>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button
          className="btn"
          style={{ width: "100%", background: "var(--success)", border: "none", fontSize: 14 }}
          onClick={() => onCall(member.extension)}
        >
          📞 Call Ext {member.extension}
        </button>
        {member.email ? (
          <a
            href={`mailto:${member.email}`}
            className="btn ghost"
            style={{ width: "100%", textAlign: "center", display: "block", fontSize: 14 }}
          >
            ✉ {member.email}
          </a>
        ) : null}
      </div>

      {/* Details */}
      <div style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
          <span style={{ color: "var(--text-dim)" }}>Extension</span>
          <span style={{ fontWeight: 600 }}>{member.extension}</span>
        </div>
        {member.email ? (
          <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
            <span style={{ color: "var(--text-dim)" }}>Email</span>
            <span style={{ fontWeight: 500, fontSize: 12 }}>{member.email}</span>
          </div>
        ) : null}
        {member.callerId ? (
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--text-dim)" }}>Current call</span>
            <span style={{ color: meta.color, fontWeight: 600, fontSize: 12 }}>{member.callerId}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── Presence Filter ───────────────────────────────────────────────────────────

const FILTERS: { key: PresenceState | "all"; label: string }[] = [
  { key: "all",       label: "All" },
  { key: "available", label: "Available" },
  { key: "on_call",   label: "On Call" },
  { key: "ringing",   label: "Ringing" },
  { key: "offline",   label: "Offline" },
];

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function TeamPage() {
  const telephony = useTelephony();
  const phone = useSipPhone();
  const [search, setSearch] = useState("");
  const [presenceFilter, setPresenceFilter] = useState<PresenceState | "all">("all");
  const [selected, setSelected] = useState<TeamMember | null>(null);

  // Load extensions from VitalPBX
  const extState = useAsyncResource<{ rows: Record<string, unknown>[] }>(
    () => apiGet("/voice/pbx/resources/extensions"),
    []
  );

  // Build active/ringing maps from live call data
  const { activeExts, ringingExts } = useMemo(() => {
    const active = new Set<string>();
    const ringing = new Set<string>();
    telephony.activeCalls.forEach((c) => {
      const exts = c.extensions ?? [];
      if (c.state === "up" || c.state === "held") exts.forEach((e) => active.add(e));
      else if (c.state === "ringing" || c.state === "dialing") exts.forEach((e) => ringing.add(e));
    });
    return { activeExts: active, ringingExts: ringing };
  }, [telephony.activeCalls]);

  // Merge VitalPBX extension data with AMI presence
  const members: TeamMember[] = useMemo(() => {
    const extRows = extState.status === "success" ? extState.data.rows : [];
    const extMap = extRows.map((r, i): TeamMember => {
      const ext = String(r.extension ?? r.number ?? i);
      const amiState = telephony.extensionList.find((e) => e.extension === ext);
      return {
        id: String(r.id ?? r.uuid ?? i),
        name: String(r.name ?? r.display_name ?? r.callerid ?? `Extension ${ext}`),
        extension: ext,
        email: r.email ? String(r.email) : undefined,
        department: r.department ? String(r.department) : undefined,
        title: r.title ? String(r.title) : undefined,
        presence: mapAmiPresence(
          amiState?.status ?? String(r.state ?? "offline"),
          ext,
          activeExts,
          ringingExts,
        ),
        callerId: undefined,
      };
    });

    // If no VitalPBX data yet, fall back to AMI extension list
    if (extMap.length === 0) {
      return telephony.extensionList.map((e): TeamMember => ({
        id: e.extension,
        name: e.hint || e.extension,
        extension: e.extension,
        presence: mapAmiPresence(e.status ?? "offline", e.extension, activeExts, ringingExts),
        callerId: undefined,
      }));
    }
    return extMap;
  }, [extState, telephony.extensionList, activeExts, ringingExts]);

  // Filter + sort
  const visible = useMemo(() => {
    const ORDER: Record<PresenceState, number> = {
      ringing: 0, on_call: 1, available: 2, busy: 3, away: 4, dnd: 5, offline: 6
    };
    let list = [...members];
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((m) =>
        m.name.toLowerCase().includes(q) ||
        m.extension.includes(q) ||
        (m.email ?? "").toLowerCase().includes(q) ||
        (m.department ?? "").toLowerCase().includes(q)
      );
    }
    if (presenceFilter !== "all") {
      list = list.filter((m) => m.presence === presenceFilter);
    }
    return list.sort((a, b) => ORDER[a.presence] - ORDER[b.presence] || a.name.localeCompare(b.name));
  }, [members, search, presenceFilter]);

  function handleCall(ext: string) {
    phone.setDialpadInput(ext);
    phone.dial(ext);
  }

  // Count by presence
  const counts = useMemo(() => ({
    available: members.filter((m) => m.presence === "available").length,
    on_call:   members.filter((m) => m.presence === "on_call").length,
    ringing:   members.filter((m) => m.presence === "ringing").length,
    offline:   members.filter((m) => m.presence === "offline").length,
  }), [members]);

  return (
    <div style={{ display: "flex", height: "calc(100vh - 54px)", overflow: "hidden" }}>
      {/* Left panel — member list */}
      <div style={{
        width: selected ? 320 : "100%",
        maxWidth: selected ? 320 : undefined,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        borderRight: selected ? "1px solid var(--border)" : undefined,
        overflow: "hidden",
      }}>
        {/* Search + filter header */}
        <div style={{
          padding: "10px 12px",
          borderBottom: "1px solid var(--border)",
          background: "var(--panel)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}>
          {/* Search row */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ flex: 1, position: "relative" }}>
              <input
                className="input"
                style={{ paddingLeft: 32, fontSize: 13 }}
                placeholder="Search people or enter number"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)", fontSize: 14 }}>
                🔍
              </span>
            </div>
          </div>

          {/* Presence filters */}
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setPresenceFilter(f.key)}
                style={{
                  padding: "3px 10px",
                  borderRadius: 20,
                  border: "1px solid var(--border)",
                  background: presenceFilter === f.key ? "var(--accent)" : "transparent",
                  color: presenceFilter === f.key ? "#fff" : "var(--text-dim)",
                  fontSize: 12,
                  cursor: "pointer",
                  transition: "all 0.15s",
                }}
              >
                {f.label}
                {f.key !== "all" && counts[f.key as keyof typeof counts] !== undefined ? (
                  <span style={{ marginLeft: 4, opacity: 0.7 }}>
                    {counts[f.key as keyof typeof counts]}
                  </span>
                ) : f.key === "all" ? (
                  <span style={{ marginLeft: 4, opacity: 0.7 }}>{members.length}</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        {/* Live indicator */}
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          padding: "5px 14px",
          fontSize: 11,
          color: "var(--text-dim)",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg)",
        }}>
          <span>{visible.length} of {members.length}</span>
          <span style={{ color: telephony.isLive ? "var(--success)" : "var(--warning)" }}>
            {telephony.isLive ? "● Live" : "⚠ Reconnecting"}
          </span>
        </div>

        {/* Member list */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {visible.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
              {search ? "No members match your search." : "No extensions found."}
            </div>
          ) : (
            visible.map((m) => (
              <MemberRow
                key={m.id}
                member={m}
                onCall={handleCall}
                selected={selected?.id === m.id}
                onSelect={setSelected}
              />
            ))
          )}
        </div>
      </div>

      {/* Right panel — detail */}
      {selected ? (
        <div style={{
          flex: 1,
          overflowY: "auto",
          background: "var(--panel)",
        }}>
          <MemberDetail member={selected} onCall={handleCall} onClose={() => setSelected(null)} />
        </div>
      ) : null}
    </div>
  );
}
