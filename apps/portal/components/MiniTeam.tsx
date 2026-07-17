"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { MessageSquare, Phone, Plus, Search, User, X } from "lucide-react";
import { useTelephonySocket } from "../hooks/useTelephonySocket";
import { apiGet } from "../services/apiClient";

// Team / BLF page for the mini dialer — mirrors the mobile Team tab: the tenant
// extension directory with LIVE presence (Available / Ringing / On Call / Offline)
// driven by the same telephony socket the desk-phone BLF lamps use, plus an
// "Add BLF" option to pin extra extensions to monitor at the top.

type MiniPresence = "available" | "ringing" | "on_call" | "offline";

type TeamMember = {
  id: string;
  name: string;
  extension: string;
  email?: string | null;
  department?: string | null;
  tenantId?: string | null;
  pinned?: boolean;
};

const AVATAR_COLORS = ["#3b82f6", "#06b6d4", "#8b5cf6", "#f43f5e", "#10b981", "#f59e0b", "#ec4899", "#6366f1"];
function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}
function isUnsavedNumber(name: string): boolean {
  const s = (name || "").trim();
  if (!s) return true;
  return !/[a-zA-Z]/.test(s);
}
function initials(value: string): string {
  return (value || "?")
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase() || "?";
}
function TeamAvatar({ name, size = 44 }: { name: string; size?: number }) {
  const unsaved = isUnsavedNumber(name);
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    display: "grid",
    placeItems: "center",
    color: "#fff",
    fontSize: Math.round(size * 0.36),
    fontWeight: 700,
    letterSpacing: 0.5,
    background: unsaved ? "#64748b" : avatarColor(name),
  };
  return <span style={style}>{unsaved ? <User size={Math.round(size * 0.52)} /> : initials(name)}</span>;
}

const PIN_KEY = "cc-mini-blf-pins";
type Pin = { extension: string; name: string };
function loadPins(): Pin[] {
  try {
    const raw = typeof window !== "undefined" ? localStorage.getItem(PIN_KEY) : null;
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((p) => p && /^\d{2,6}$/.test(String(p.extension))) : [];
  } catch {
    return [];
  }
}
function savePins(pins: Pin[]) {
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify(pins));
  } catch {
    /* ignore */
  }
}

function presenceColor(p: MiniPresence): string {
  if (p === "available") return "#22c55e";
  if (p === "ringing") return "#f59e0b";
  if (p === "on_call") return "#3b82f6";
  return "var(--mn-text-3)";
}
function presenceLabel(p: MiniPresence): string {
  if (p === "on_call") return "On Call";
  return p.charAt(0).toUpperCase() + p.slice(1);
}
function presenceWeight(p: MiniPresence): number {
  return p === "available" ? 0 : p === "ringing" ? 1 : p === "on_call" ? 2 : 3;
}

function isDisplayable(name: string, extension: string): boolean {
  if (!/^\d{2,6}$/.test(extension)) return false;
  const n = (name || "").trim().toLowerCase();
  return !(
    n === "pbx user" ||
    /^pbx user\s+\d+$/.test(n) ||
    n.includes("invite lifecycle") ||
    n.includes("provisioning") ||
    n.includes("smoke") ||
    n.includes("system") ||
    n === "voice user" ||
    /^voice user\s+\d+$/.test(n)
  );
}

export function MiniTeam({
  onCall,
  onMessage,
  tenantId,
}: {
  onCall: (extension: string) => void;
  onMessage: (member: TeamMember) => void;
  tenantId: string | null;
}) {
  const { calls, extensions } = useTelephonySocket();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | MiniPresence>("all");
  const [pins, setPins] = useState<Pin[]>(loadPins);
  const [adding, setAdding] = useState(false);
  const [addExt, setAddExt] = useState("");

  useEffect(() => {
    let alive = true;
    apiGet<{ rows?: Array<Record<string, unknown>> }>("/voice/pbx/resources/extensions")
      .then((res) => {
        if (!alive) return;
        const rows = Array.isArray(res?.rows) ? res.rows : [];
        const mapped = rows
          .map((row): TeamMember | null => {
            const extension = String(
              row.extension ?? row.extNumber ?? row.ext_number ?? row.number ?? row.sipExtension ?? "",
            ).trim();
            if (!/^\d{2,6}$/.test(extension)) return null;
            const name = String(
              row.displayName ?? row.display_name ?? row.name ?? row.callerId ?? `Extension ${extension}`,
            ).trim();
            return {
              id: String(row.connectExtensionId ?? row.id ?? extension),
              name,
              extension,
              email: (row.email as string) ?? (row.assignedUser as string) ?? null,
              department: (row.department as string) ?? (row.team as string) ?? null,
              tenantId: (row.tenantId as string) ?? (row.tenant_id as string) ?? null,
            };
          })
          .filter((m): m is TeamMember => Boolean(m) && isDisplayable(m!.name, m!.extension));
        setMembers(mapped);
        setLoading(false);
      })
      .catch(() => {
        if (alive) {
          setError("Could not load team.");
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const livePresence = useMemo(() => {
    return (extension: string, tId: string | null): MiniPresence => {
      let onCall = false;
      let ringing = false;
      for (const call of calls.values()) {
        const belongs = !tId || !call.tenantId || call.tenantId === tId;
        if (!belongs) continue;
        if (!(call.extensions || []).includes(extension)) continue;
        if (call.state === "ringing" || call.state === "dialing") ringing = true;
        else if (call.state === "up" || call.state === "held") onCall = true;
      }
      let hint = "";
      for (const ext of extensions.values()) {
        if (ext.extension === extension && (!tId || !ext.tenantId || ext.tenantId === tId)) {
          hint = String(ext.status || "").toLowerCase();
          break;
        }
      }
      if (ringing || hint === "ringing") return "ringing";
      if (onCall || hint === "inuse" || hint === "busy" || hint === "onhold") return "on_call";
      if (hint === "idle") return "available";
      return "offline";
    };
  }, [calls, extensions]);

  const enriched = useMemo(() => {
    const dirExts = new Set(members.map((m) => m.extension));
    const pinMembers: TeamMember[] = pins
      .filter((p) => !dirExts.has(p.extension))
      .map((p) => ({ id: `pin:${p.extension}`, name: p.name || p.extension, extension: p.extension, tenantId, pinned: true }));
    const merged: TeamMember[] = [
      ...pinMembers,
      ...members.map((m) => ({ ...m, pinned: pins.some((p) => p.extension === m.extension) })),
    ];
    return merged.map((m) => ({ ...m, presence: livePresence(m.extension, m.tenantId ?? tenantId) }));
  }, [members, pins, tenantId, livePresence]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return enriched
      .filter((m) => filter === "all" || m.presence === filter)
      .filter(
        (m) =>
          !q ||
          m.name.toLowerCase().includes(q) ||
          m.extension.includes(q) ||
          (m.email || "").toLowerCase().includes(q),
      )
      .sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
        const wa = presenceWeight(a.presence);
        const wb = presenceWeight(b.presence);
        if (wa !== wb) return wa - wb;
        return (parseInt(a.extension, 10) || 0) - (parseInt(b.extension, 10) || 0);
      });
  }, [enriched, filter, query]);

  const addPin = () => {
    const e = addExt.trim();
    if (!/^\d{2,6}$/.test(e)) return;
    const next = [...pins.filter((p) => p.extension !== e), { extension: e, name: "" }];
    setPins(next);
    savePins(next);
    setAddExt("");
    setAdding(false);
  };
  const removePin = (extension: string) => {
    const next = pins.filter((p) => p.extension !== extension);
    setPins(next);
    savePins(next);
  };

  const chips: Array<["all" | MiniPresence, string]> = [
    ["all", "All"],
    ["available", "Available"],
    ["on_call", "On Call"],
    ["ringing", "Ringing"],
    ["offline", "Offline"],
  ];

  return (
    <div className="mt-screen">
      <div className="mt-header">
        <div className="mt-title">Team</div>
        <button className="mt-add" onClick={() => setAdding((a) => !a)} title="Add BLF">
          <Plus size={18} />
        </button>
      </div>

      {adding && (
        <div className="mt-add-row">
          <input
            value={addExt}
            onChange={(e) => setAddExt(e.target.value.replace(/[^\d]/g, ""))}
            placeholder="Extension to monitor"
            onKeyDown={(e) => {
              if (e.key === "Enter") addPin();
            }}
            autoFocus
          />
          <button className="mt-add-go" onClick={addPin} disabled={!/^\d{2,6}$/.test(addExt.trim())}>
            Add BLF
          </button>
        </div>
      )}

      <div className="mt-search">
        <Search size={16} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or extension" />
      </div>

      <div className="mt-chips">
        {chips.map(([key, label]) => (
          <button key={key} className={"mt-chip" + (filter === key ? " active" : "")} onClick={() => setFilter(key)}>
            {label}
          </button>
        ))}
      </div>

      <div className="mt-list">
        {loading ? (
          <p className="mt-empty">Loading team…</p>
        ) : error ? (
          <p className="mt-empty">{error}</p>
        ) : visible.length === 0 ? (
          <p className="mt-empty">No team members found.</p>
        ) : (
          visible.map((m) => {
            const color = presenceColor(m.presence);
            return (
              <article className="mt-card" key={m.id}>
                <span className="mt-av-wrap">
                  <TeamAvatar name={m.name} size={44} />
                  <span className="mt-dot" style={{ background: color }} />
                </span>
                <div className="mt-main">
                  <strong>{m.name}</strong>
                  <span className="mt-meta">
                    Ext {m.extension}
                    {m.email ? ` · ${m.email}` : m.department ? ` · ${m.department}` : ""}
                  </span>
                  <span className="mt-pill" style={{ color, borderColor: `${color}66`, background: `${color}1f` }}>
                    <i style={{ background: color }} />
                    {presenceLabel(m.presence)}
                  </span>
                </div>
                <div className="mt-actions">
                  {m.pinned && (
                    <button className="mt-unpin" onClick={() => removePin(m.extension)} title="Remove BLF">
                      <X size={13} />
                    </button>
                  )}
                  <button className="mt-msg" onClick={() => onMessage(m)} title="Message">
                    <MessageSquare size={15} />
                  </button>
                  <button className="mt-call" onClick={() => onCall(m.extension)} title="Call">
                    <Phone size={16} />
                  </button>
                </div>
              </article>
            );
          })
        )}
      </div>

      <style jsx>{`
        .mt-screen { display: flex; flex-direction: column; height: 100%; min-height: 0; }
        .mt-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 16px 8px; }
        .mt-title { font-size: 24px; font-weight: 800; letter-spacing: -0.5px; color: var(--mn-text); }
        .mt-add { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; border: 0; background: #3b82f6; color: #fff; cursor: pointer; box-shadow: 0 6px 16px rgba(59,130,246,0.35); flex-shrink: 0; }
        .mt-add:hover { filter: brightness(1.05); }
        .mt-add-row { display: flex; gap: 8px; margin: 0 14px 10px; }
        .mt-add-row input { flex: 1; min-width: 0; height: 40px; border-radius: 12px; border: 0.5px solid var(--mn-border); background: var(--mn-surface-2); color: var(--mn-text); padding: 0 12px; font-size: 14px; outline: none; }
        .mt-add-go { height: 40px; padding: 0 14px; border: 0; border-radius: 12px; background: #3b82f6; color: #fff; font-size: 13px; font-weight: 700; cursor: pointer; flex-shrink: 0; }
        .mt-add-go:disabled { background: var(--mn-border); color: var(--mn-text-3); cursor: default; }
        .mt-search { display: flex; align-items: center; gap: 10px; margin: 0 14px 10px; height: 44px; padding: 0 14px; border-radius: 16px; border: 0.5px solid var(--mn-border); background: var(--mn-surface-2); color: var(--mn-text-3); }
        .mt-search input { flex: 1; min-width: 0; border: 0; background: transparent; outline: none; color: var(--mn-text); font-size: 14px; font-weight: 500; }
        .mt-search input::placeholder { color: var(--mn-text-3); }
        .mt-chips { display: flex; gap: 6px; margin: 0 14px 8px; overflow-x: auto; scrollbar-width: none; }
        .mt-chips::-webkit-scrollbar { display: none; }
        .mt-chip { flex-shrink: 0; min-height: 32px; padding: 0 12px; border-radius: 16px; border: 0.5px solid var(--mn-border); background: var(--mn-surface-2); color: var(--mn-text-2); font-size: 12px; font-weight: 800; cursor: pointer; }
        .mt-chip.active { border-color: rgba(59,130,246,0.5); background: #3b82f6; color: #fff; }
        .mt-list { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 0 12px; }
        .mt-card { display: flex; align-items: center; gap: 12px; padding: 12px; margin: 0 12px 10px; border-radius: 18px; border: 0.5px solid var(--mn-border); background: var(--mn-surface); min-height: 76px; box-sizing: border-box; }
        .mt-av-wrap { position: relative; flex-shrink: 0; }
        .mt-dot { position: absolute; right: -1px; bottom: -1px; width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--mn-surface); box-sizing: border-box; }
        .mt-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
        .mt-main strong { font-size: 15px; font-weight: 800; letter-spacing: -0.15px; color: var(--mn-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .mt-meta { font-size: 12px; font-weight: 600; color: var(--mn-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0.85; }
        .mt-pill { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border-radius: 999px; border: 1px solid transparent; font-size: 10.5px; font-weight: 800; letter-spacing: 0.2px; margin-top: 1px; }
        .mt-pill i { width: 6px; height: 6px; border-radius: 50%; display: block; }
        .mt-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
        .mt-unpin { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; border: 0; background: rgba(148,163,184,0.14); color: var(--mn-text-3); cursor: pointer; }
        .mt-unpin:hover { background: rgba(239,68,68,0.18); color: #ef4444; }
        .mt-msg { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; border: 1px solid rgba(6,182,212,0.33); background: rgba(6,182,212,0.14); color: #22d3ee; cursor: pointer; }
        .mt-msg:hover { background: rgba(6,182,212,0.22); }
        .mt-call { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; border: 0; background: #3b82f6; color: #fff; cursor: pointer; box-shadow: 0 4px 12px rgba(59,130,246,0.35); }
        .mt-call:hover { filter: brightness(1.05); }
        .mt-empty { text-align: center; color: var(--mn-text-3); font-size: 13px; padding: 40px 16px; }
      `}</style>
    </div>
  );
}
