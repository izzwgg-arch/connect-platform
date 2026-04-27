"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Copy,
  LayoutGrid,
  LayoutList,
  MessageSquare,
  MoreHorizontal,
  Phone,
  Search,
  User,
  Wifi,
  WifiOff,
  X,
  Check,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useAppContext } from "../../../hooks/useAppContext";
import { useTelephony } from "../../../contexts/TelephonyContext";
import { useSipPhone } from "../../../hooks/useSipPhone";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { useDebouncedValue } from "../../../hooks/useDebouncedValue";
import { loadPbxResource } from "../../../services/pbxData";
import { callsForTenant as scopeLiveCallsForTenant, extensionSetsFromCalls } from "../../../services/liveCallState";

// ── Types ──────────────────────────────────────────────────────────────────────

type PresenceState = "available" | "ringing" | "on_call" | "busy" | "away" | "dnd" | "offline";

interface TeamMember {
  id: string;
  name: string;
  extension: string;
  email?: string;
  department?: string;
  title?: string;
  presence: PresenceState;
  callerId?: string;
}

const PRESENCE_META: Record<PresenceState, { label: string; color: string; dotColor: string; animate: boolean }> = {
  available: { label: "Available",      color: "var(--success)",  dotColor: "var(--success)",  animate: false },
  ringing:   { label: "Ringing",        color: "var(--warning)",  dotColor: "var(--warning)",  animate: true  },
  on_call:   { label: "On Call",        color: "var(--danger)",   dotColor: "var(--danger)",   animate: true  },
  busy:      { label: "Busy",           color: "var(--warning)",  dotColor: "var(--warning)",  animate: false },
  away:      { label: "Away",           color: "var(--warning)",  dotColor: "var(--warning)",  animate: false },
  dnd:       { label: "Do Not Disturb", color: "var(--danger)",   dotColor: "var(--danger)",   animate: false },
  offline:   { label: "Offline",        color: "var(--text-dim)", dotColor: "#555e6e",         animate: false },
};

const PRESENCE_ORDER: Record<PresenceState, number> = {
  ringing: 0, on_call: 1, available: 2, busy: 3, away: 4, dnd: 5, offline: 6,
};

function mapAmiPresence(
  rawState: string,
  ext: string,
  activeCalls: Set<string>,
  ringingCalls: Set<string>,
): PresenceState {
  // Live-call state is the single source of truth for On Call / Ringing — the
  // same rule the Dashboard + BLF panel use. AMI hints without a matching
  // live call are treated as "available" (or offline when unknown) so the
  // three surfaces never disagree.
  if (ringingCalls.has(ext)) return "ringing";
  if (activeCalls.has(ext)) return "on_call";
  const s = (rawState || "").toLowerCase();
  if (s === "not_inuse" || s === "idle" || s === "registered" || s === "0") return "available";
  if (s === "away") return "away";
  if (s === "dnd") return "dnd";
  if (s === "inuse" || s === "busy" || s === "onhold" || s === "ringing" ||
      s === "1" || s === "2" || s === "3") {
    // AMI says busy but we don't see a live call for this extension. Don't
    // show a phantom On-Call; fall back to Available.
    return "available";
  }
  return "offline";
}

function mkInitials(name: string): string {
  return name.trim().split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase() || "??";
}

function readString(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function normalizeTenantName(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase();
}

function rowTenantMatches(row: Record<string, unknown>, tenantId: string | null | undefined, tenantName: string | null | undefined): boolean {
  if (!tenantId) return false;

  const selectedTenantName = normalizeTenantName(tenantName);
  const rowTenantName = normalizeTenantName(readString(row, ["tenantName", "tenant_name", "tenantDisplayName"]));
  if (selectedTenantName && rowTenantName) return rowTenantName === selectedTenantName;

  const directTenant = readString(row, ["tenantId", "tenant_id", "tenant", "platformTenantId", "platform_tenant_id"]);
  if (directTenant) return directTenant === tenantId;

  const nestedTenant = row.tenant;
  if (nestedTenant && typeof nestedTenant === "object") {
    const nestedId = readString(nestedTenant as Record<string, unknown>, ["id", "tenantId", "tenant_id"]);
    if (nestedId) return nestedId === tenantId;
  }

  // Non-super-admin responses are already tenant-scoped. If a row carries no
  // tenant marker at all, keep it so valid tenant extensions are not hidden.
  return true;
}

function isValidTenantExtension(ext: string): boolean {
  return /^\d{3}$/.test(ext);
}

function isSystemExtensionName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    normalized === "pbx user" ||
    /^pbx user\s+\d+$/.test(normalized) ||
    normalized === "invite lifecycle" ||
    normalized.includes("invite lifecycle") ||
    normalized.includes("provisioning") ||
    normalized.includes("smoke") ||
    normalized.includes("system") ||
    normalized === "voice user" ||
    /^voice user\s+\d+$/.test(normalized)
  );
}

function byExtensionAsc(a: TeamMember, b: TeamMember): number {
  return Number(a.extension) - Number(b.extension);
}

type ViewMode = "card" | "list";
type SortKey = "name" | "extension" | "status";
type StatusFilter = PresenceState | "all";

function getStoredView(): ViewMode {
  if (typeof window === "undefined") return "card";
  return localStorage.getItem("cc-team-hub-view") === "list" ? "list" : "card";
}

// ── Action Menu ────────────────────────────────────────────────────────────────

function ActionMenu({
  onCall,
  onMessage,
  onCopy,
  onDetails,
}: {
  onCall: () => void;
  onMessage: () => void;
  onCopy: () => void;
  onDetails: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const run = (fn: () => void) => { fn(); setOpen(false); };

  const items = [
    { icon: <Phone size={14} />, label: "Call",           fn: onCall    },
    { icon: <MessageSquare size={14} />, label: "Message",fn: onMessage  },
    { icon: <User size={14} />, label: "View Details",    fn: onDetails  },
    { icon: <Copy size={14} />, label: "Copy Extension",  fn: onCopy     },
  ];

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        className="td-action-btn"
        aria-label="More actions"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <MoreHorizontal size={16} strokeWidth={2} />
      </button>
      {open ? (
        <div className="td-action-menu" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              className="td-action-item"
              role="menuitem"
              onClick={(e) => { e.stopPropagation(); run(item.fn); }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── Avatar with presence dot ───────────────────────────────────────────────────

function MemberAvatar({ member, size = 48 }: { member: TeamMember; size?: number }) {
  const meta = PRESENCE_META[member.presence];
  const dotSize = Math.max(8, Math.round(size * 0.265));
  return (
    <div className={`td-avatar-wrap td-presence-${member.presence}`} style={{ width: size, height: size }}>
      <div
        className="td-avatar-circle"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.34) }}
      >
        {mkInitials(member.name)}
      </div>
      <span
        className={`td-presence-dot${meta.animate ? " td-presence-dot-pulse" : ""}`}
        style={{ width: dotSize, height: dotSize, background: meta.dotColor, bottom: 1, right: 1 }}
      />
    </div>
  );
}

// ── Detail Panel ───────────────────────────────────────────────────────────────

function DetailPanel({
  member,
  onCall,
  onMessage,
  onCopy,
  onClose,
}: {
  member: TeamMember;
  onCall: (ext: string) => void;
  onMessage: (m: TeamMember) => void;
  onCopy: (ext: string) => void;
  onClose: () => void;
}) {
  const meta = PRESENCE_META[member.presence];
  const activeNow = member.presence === "on_call" || member.presence === "ringing";
  return (
    <>
      <div className="td-detail-backdrop" onClick={onClose} />
      <aside className="td-detail-panel" aria-label="Member details">
        <button className="td-detail-close" onClick={onClose} aria-label="Close details">
          <X size={18} />
        </button>

        <div className="td-detail-profile">
          <MemberAvatar member={member} size={86} />
          <div className="td-detail-name">{member.name}</div>
          {member.title ? <div className="td-detail-title">{member.title}</div> : null}
          {member.department ? <div className="td-detail-dept">{member.department}</div> : null}
          <div className="td-detail-status-row">
            <span
              className={`td-presence-dot-xs${meta.animate ? " td-presence-dot-pulse" : ""}`}
              style={{ background: meta.dotColor, position: "relative", top: 0, left: 0, display: "inline-block" }}
            />
            <span style={{ color: meta.color, fontWeight: 600, fontSize: 13 }}>{meta.label}</span>
          </div>
        </div>

        <div className="td-detail-actions">
          <button
            className="btn td-detail-cta"
            style={{ background: "var(--success)", border: "none", color: "#fff" }}
            onClick={() => onCall(member.extension)}
          >
            <Phone size={15} /> Call Ext {member.extension}
          </button>
          <button className="btn ghost td-detail-cta" onClick={() => onMessage(member)}>
            <MessageSquare size={15} /> Message
          </button>
        </div>

        <div className="td-detail-insights">
          <div className="td-detail-insight">
            <Activity size={16} />
            <span>
              <strong>{activeNow ? "Active now" : member.presence === "available" ? "Ready to connect" : "Quiet"}</strong>
              <small>{member.callerId || `${meta.label} on extension ${member.extension}`}</small>
            </span>
          </div>
          <div className="td-detail-mini-stats">
            <div>
              <strong>{member.extension}</strong>
              <small>Extension</small>
            </div>
            <div>
              <strong>{activeNow ? "Live" : "Idle"}</strong>
              <small>Activity</small>
            </div>
            <div>
              <strong>{member.department || "Team"}</strong>
              <small>Group</small>
            </div>
          </div>
        </div>

        <dl className="td-detail-dl">
          <div className="td-detail-row">
            <dt>Extension</dt>
            <dd>
              <span className="td-ext-badge">{member.extension}</span>
              <button
                type="button"
                className="td-copy-inline"
                onClick={() => onCopy(member.extension)}
                title="Copy extension"
              >
                <Copy size={13} />
              </button>
            </dd>
          </div>
          {member.email ? (
            <div className="td-detail-row">
              <dt>Email</dt>
              <dd>
                <a href={`mailto:${member.email}`} className="td-email-link">{member.email}</a>
              </dd>
            </div>
          ) : null}
          {member.title ? (
            <div className="td-detail-row">
              <dt>Title</dt>
              <dd>{member.title}</dd>
            </div>
          ) : null}
          {member.department ? (
            <div className="td-detail-row">
              <dt>Department</dt>
              <dd>{member.department}</dd>
            </div>
          ) : null}
          {member.callerId ? (
            <div className="td-detail-row">
              <dt>Current call</dt>
              <dd style={{ color: meta.color, fontWeight: 600 }}>{member.callerId}</dd>
            </div>
          ) : null}
        </dl>
      </aside>
    </>
  );
}

// ── Member Card ────────────────────────────────────────────────────────────────

function MemberCard({
  member,
  onCall,
  onMessage,
  onCopy,
  onDetails,
}: {
  member: TeamMember;
  onCall: (ext: string) => void;
  onMessage: (m: TeamMember) => void;
  onCopy: (ext: string) => void;
  onDetails: (m: TeamMember) => void;
}) {
  const meta = PRESENCE_META[member.presence];
  const isActive = member.presence === "on_call" || member.presence === "ringing";

  return (
    <div
      className={`td-card td-smart-card td-presence-${member.presence}${isActive ? " td-card-active" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onDetails(member)}
      onKeyDown={(e) => e.key === "Enter" && onDetails(member)}
    >
      <div className="td-card-top">
        <MemberAvatar member={member} size={42} />
        <span
          className="td-status-pill td-status-pill-float"
          style={{
            background: `color-mix(in srgb, ${meta.dotColor} 16%, transparent)`,
            color: meta.color,
          }}
        >
          <span
            className={`td-presence-dot-xs${meta.animate ? " td-presence-dot-pulse" : ""}`}
            style={{ background: meta.dotColor }}
          />
          {meta.label}
        </span>
      </div>
      <div className="td-card-name">{member.name}</div>
      <div className="td-card-ext">Ext {member.extension}</div>
      {member.title ? <div className="td-card-role">{member.title}</div> : null}
      {member.department ? <div className="td-card-dept">{member.department}</div> : null}
      <div className="td-card-footer">
        <button className="td-hover-action" type="button" onClick={(e) => { e.stopPropagation(); onCall(member.extension); }}>
          <Phone size={15} /> Call
        </button>
        <button className="td-hover-action" type="button" onClick={(e) => { e.stopPropagation(); onMessage(member); }}>
          <MessageSquare size={15} /> Message
        </button>
        <ActionMenu
          onCall={() => onCall(member.extension)}
          onMessage={() => onMessage(member)}
          onCopy={() => onCopy(member.extension)}
          onDetails={() => onDetails(member)}
        />
      </div>
    </div>
  );
}

// ── List Row ───────────────────────────────────────────────────────────────────

function MemberListRow({
  member,
  onCall,
  onMessage,
  onCopy,
  onDetails,
}: {
  member: TeamMember;
  onCall: (ext: string) => void;
  onMessage: (m: TeamMember) => void;
  onCopy: (ext: string) => void;
  onDetails: (m: TeamMember) => void;
}) {
  const meta = PRESENCE_META[member.presence];
  const isActive = member.presence === "on_call" || member.presence === "ringing";

  return (
    <div
      className={`td-list-row td-clean-row td-presence-${member.presence}${isActive ? " td-list-row-active" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onDetails(member)}
      onKeyDown={(e) => e.key === "Enter" && onDetails(member)}
    >
      <div className="td-list-name-cell">
        <MemberAvatar member={member} size={38} />
        <div>
          <div className="td-list-name">{member.name}</div>
          <div className="td-list-email">Ext {member.extension}{member.email ? ` · ${member.email}` : ""}</div>
        </div>
      </div>
      <div className="td-list-meta">
        <span>{member.title || "Team member"}</span>
        <small>{member.department || "Live Team"}</small>
      </div>
      <span
        className="td-status-pill"
        style={{
          background: `color-mix(in srgb, ${meta.dotColor} 15%, transparent)`,
          color: meta.color,
        }}
      >
        <span
          className={`td-presence-dot-xs${meta.animate ? " td-presence-dot-pulse" : ""}`}
          style={{ background: meta.dotColor }}
        />
        {meta.label}
      </span>
      <div className="td-row-actions" onClick={(e) => e.stopPropagation()}>
        <button className="td-action-btn" type="button" onClick={() => onCall(member.extension)} aria-label={`Call ${member.name}`}>
          <Phone size={15} />
        </button>
        <button className="td-action-btn" type="button" onClick={() => onMessage(member)} aria-label={`Message ${member.name}`}>
          <MessageSquare size={15} />
        </button>
        <ActionMenu
          onCall={() => onCall(member.extension)}
          onMessage={() => onMessage(member)}
          onCopy={() => onCopy(member.extension)}
          onDetails={() => onDetails(member)}
        />
      </div>
    </div>
  );
}

// ── Filter config ──────────────────────────────────────────────────────────────

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all",       label: "All"       },
  { key: "available", label: "Available" },
  { key: "on_call",   label: "On Call"   },
  { key: "offline",   label: "Offline"   },
];

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function TeamDirectoryPage() {
  const { tenantId, adminScope, tenant } = useAppContext();
  const telephony = useTelephony();
  const phone = useSipPhone();
  const router = useRouter();

  // Persistent view mode
  const [view, setView] = useState<ViewMode>(getStoredView);
  const setViewPersist = useCallback((v: ViewMode) => {
    setView(v);
    localStorage.setItem("cc-team-hub-view", v);
  }, []);

  // Search / filter / sort
  const [rawSearch, setRawSearch] = useState("");
  const search = useDebouncedValue(rawSearch, 180);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("extension");

  // Detail panel
  const [detail, setDetail] = useState<TeamMember | null>(null);

  // Toast
  const [toast, setToast] = useState<{ msg: string; key: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, key: Date.now() });
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }, []);

  // Fetch the same extension source as PBX Extensions. For super-admins this
  // returns all extension rows, then we filter by selected tenant name/id below.
  const extState = useAsyncResource<{ rows: Record<string, unknown>[] }>(
    () => loadPbxResource("extensions"),
    [tenantId, tenant?.name, adminScope],
  );
  const extensionRows = extState.status === "success" ? extState.data.rows : [];

  // Tenant-scoped live calls for presence (not cross-tenant)
  const tenantCalls = useMemo(
    () =>
      tenantId
        ? scopeLiveCallsForTenant(telephony.activeCalls, tenantId, extensionRows, tenant?.name)
        : [],
    [extensionRows, telephony.activeCalls, tenant?.name, tenantId],
  );

  // Build active/ringing extension sets from live calls
  const { activeExts, ringingExts } = useMemo(() => extensionSetsFromCalls(tenantCalls), [tenantCalls]);

  // Build member list — merge VitalPBX directory + live AMI presence
  const members: TeamMember[] = useMemo(() => {
    const mapped = extensionRows.flatMap((r, i): TeamMember[] => {
      if (!rowTenantMatches(r, tenantId, tenant?.name)) return [];

      const ext = readString(r, ["extension", "extNumber", "ext_number", "number", "sipExtension"]);
      if (!ext || !isValidTenantExtension(ext)) return [];

      const name = readString(r, ["displayName", "display_name", "name", "callerid", "callerId"]) ?? `Extension ${ext}`;
      if (isSystemExtensionName(name)) return [];

      const amiState = telephony.extensionList.find((e) => e.extension === ext && (!tenantId || !e.tenantId || e.tenantId === tenantId));
      return [{
        id: readString(r, ["id", "uuid"]) ?? ext,
        name,
        extension: ext,
        email: readString(r, ["email"]),
        department: readString(r, ["department", "team"]),
        title: readString(r, ["title", "role"]),
        presence: mapAmiPresence(
          amiState?.status ?? readString(r, ["state", "status"]) ?? "offline",
          ext,
          activeExts,
          ringingExts,
        ),
        callerId: undefined,
      }];
    });

    // During the initial fetch only, fall back to AMI data filtered to real
    // 3-digit extensions so system or cross-tenant junk never enters the UI.
    if (mapped.length === 0 && extState.status === "loading") {
      return telephony.extensionList.flatMap((e): TeamMember[] => {
        if (tenantId && e.tenantId && e.tenantId !== tenantId) return [];
        if (!isValidTenantExtension(e.extension) || isSystemExtensionName(e.hint || e.extension)) return [];
        return [{
        id: e.extension,
        name: e.hint || e.extension,
        extension: e.extension,
        presence: mapAmiPresence(e.status ?? "offline", e.extension, activeExts, ringingExts),
        }];
      }).sort(byExtensionAsc);
    }
    return mapped.sort(byExtensionAsc);
  }, [activeExts, extensionRows, extState.status, ringingExts, tenant?.name, tenantId, telephony.extensionList]);

  // Keep detail panel in sync with live presence updates
  useEffect(() => {
    setDetail((prev) => {
      if (!prev) return null;
      return members.find((m) => m.id === prev.id) ?? null;
    });
  }, [members]);

  // Filter + sort
  const visible = useMemo(() => {
    let list = [...members];
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.extension.includes(q) ||
          (m.email ?? "").toLowerCase().includes(q) ||
          (m.department ?? "").toLowerCase().includes(q) ||
          (m.title ?? "").toLowerCase().includes(q),
      );
    }
    if (statusFilter !== "all") {
      list = list.filter((m) => m.presence === statusFilter);
    }
    switch (sortKey) {
      case "extension":
        list.sort((a, b) => a.extension.localeCompare(b.extension, undefined, { numeric: true }));
        break;
      case "status":
        list.sort((a, b) => PRESENCE_ORDER[a.presence] - PRESENCE_ORDER[b.presence] || byExtensionAsc(a, b));
        break;
      case "name":
        list.sort((a, b) => a.name.localeCompare(b.name));
        break;
      default:
        list.sort(byExtensionAsc);
    }
    return list;
  }, [members, search, statusFilter, sortKey]);

  // Counts for filter chips
  const counts = useMemo(() => ({
    total:     members.length,
    available: members.filter((m) => m.presence === "available").length,
    on_call:   members.filter((m) => m.presence === "on_call").length,
    ringing:   members.filter((m) => m.presence === "ringing").length,
    offline:   members.filter((m) => m.presence === "offline").length,
  }), [members]);

  // Actions
  const handleCall = useCallback((ext: string) => {
    phone.setDialpadInput(ext);
    phone.dial(ext);
  }, [phone]);

  const handleMessage = useCallback((member: TeamMember) => {
    router.push(`/chat?ext=${encodeURIComponent(member.extension)}`);
  }, [router]);

  const handleCopy = useCallback((ext: string) => {
    navigator.clipboard.writeText(ext).catch(() => {});
    showToast(`Extension ${ext} copied`);
  }, [showToast]);

  const presenceLive = telephony.isLive;
  const isInitialLoad = extState.status === "loading" && members.length === 0;

  return (
    <div className="td-page">
      {/* Presence unavailable banner */}
      {!presenceLive && members.length > 0 ? (
        <div className="td-presence-banner">
          <WifiOff size={14} />
          Presence is temporarily unavailable. Directory data is still shown.
        </div>
      ) : null}

      <section className="td-hub-hero">
        <div className="td-hub-title">
          <span className="td-kicker"><Activity size={14} /> Live Team Hub</span>
          <h1>Team Directory</h1>
          <p>Every extension is an active communication node with live state, instant actions, and tenant-scoped presence.</p>
        </div>
        <div className="td-hub-metrics">
          <div className="td-hub-metric">
            <strong>{counts.available}</strong>
            <span>Available</span>
          </div>
          <div className="td-hub-metric danger">
            <strong>{counts.on_call}</strong>
            <span>On call</span>
          </div>
          <div className="td-hub-metric warning">
            <strong>{counts.ringing}</strong>
            <span>Ringing</span>
          </div>
        </div>
      </section>

      {/* Toolbar */}
      <div className="td-toolbar">
        <div className="td-toolbar-left">
          {/* Search */}
          <div className="td-search-wrap">
            <Search className="td-search-icon" size={15} strokeWidth={2} aria-hidden />
            <input
              className="td-search"
              placeholder="Search name, extension, email…"
              value={rawSearch}
              onChange={(e) => setRawSearch(e.target.value)}
              autoComplete="off"
              aria-label="Search team members"
            />
            {rawSearch ? (
              <button className="td-search-clear" onClick={() => setRawSearch("")} aria-label="Clear search">
                <X size={13} />
              </button>
            ) : null}
          </div>

          {/* Status filter chips */}
          <div className="td-filters" role="group" aria-label="Filter by status">
            {STATUS_FILTERS.map((f) => {
              const count = f.key === "all" ? counts.total : (counts[f.key as keyof typeof counts] ?? 0);
              return (
                <button
                  key={f.key}
                  type="button"
                  className={`td-filter-chip${statusFilter === f.key ? " active" : ""}`}
                  onClick={() => setStatusFilter(f.key)}
                  aria-pressed={statusFilter === f.key}
                >
                  {f.label}
                  <span className="td-filter-count">{count}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="td-toolbar-right">
          {/* Sort */}
          <select
            className="td-sort-select"
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            aria-label="Sort by"
          >
            <option value="extension">Extension</option>
            <option value="name">Name</option>
            <option value="status">Status</option>
          </select>

          {/* View toggle */}
          <div className="td-view-toggle" role="group" aria-label="View mode">
            <button
              type="button"
              className={`td-view-btn${view === "card" ? " active" : ""}`}
              onClick={() => setViewPersist("card")}
              aria-pressed={view === "card"}
              title="Card view"
            >
              <LayoutGrid size={15} strokeWidth={2} />
              <span>Cards</span>
            </button>
            <button
              type="button"
              className={`td-view-btn${view === "list" ? " active" : ""}`}
              onClick={() => setViewPersist("list")}
              aria-pressed={view === "list"}
              title="List view"
            >
              <LayoutList size={15} strokeWidth={2} />
              <span>List</span>
            </button>
          </div>

          {/* Live badge */}
          <div
            className="td-live-badge"
            style={{ color: presenceLive ? "var(--success)" : "var(--warning)" }}
            title={presenceLive ? "Presence data live" : "Presence reconnecting"}
          >
            {presenceLive
              ? <><Wifi size={13} /><span>Live</span></>
              : <><WifiOff size={13} /><span>Offline</span></>}
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="td-content">
        {isInitialLoad ? (
          <div className="td-empty">
            <div className="td-empty-title" style={{ color: "var(--text-dim)", fontWeight: 400 }}>
              Loading team directory…
            </div>
          </div>
        ) : visible.length === 0 ? (
          <div className="td-empty">
            <User className="td-empty-icon-svg" size={42} strokeWidth={1.1} />
            <div className="td-empty-title">
              {rawSearch || statusFilter !== "all"
                ? "No matching team members"
                : "No team members found for this tenant"}
            </div>
            <div className="td-empty-sub">
              {rawSearch || statusFilter !== "all"
                ? "Try a different search term or filter."
                : "Extensions will appear here once provisioned in VitalPBX."}
            </div>
            {rawSearch || statusFilter !== "all" ? (
              <button
                className="btn ghost"
                style={{ marginTop: 12, fontSize: 13 }}
                onClick={() => { setRawSearch(""); setStatusFilter("all"); }}
              >
                Clear filters
              </button>
            ) : null}
          </div>
        ) : view === "card" ? (
          <div className="td-card-grid">
            {visible.map((m) => (
              <MemberCard
                key={m.id}
                member={m}
                onCall={handleCall}
                onMessage={handleMessage}
                onCopy={handleCopy}
                onDetails={setDetail}
              />
            ))}
          </div>
        ) : (
          <div className="td-list-wrap td-clean-list">
            {visible.map((m) => (
              <MemberListRow
                key={m.id}
                member={m}
                onCall={handleCall}
                onMessage={handleMessage}
                onCopy={handleCopy}
                onDetails={setDetail}
              />
            ))}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="td-status-bar">
        <span>{visible.length} of {members.length}</span>
        {counts.on_call > 0 ? (
          <span className="td-stat-badge td-stat-oncall">{counts.on_call} on call</span>
        ) : null}
        {counts.ringing > 0 ? (
          <span className="td-stat-badge td-stat-ringing">{counts.ringing} ringing</span>
        ) : null}
        <span className="td-stat-badge td-stat-avail">{counts.available} available</span>
        <span className="td-stat-badge td-stat-offline">{counts.offline} offline</span>
      </div>

      {/* Detail panel */}
      {detail ? (
        <DetailPanel
          member={detail}
          onCall={handleCall}
          onMessage={handleMessage}
          onCopy={handleCopy}
          onClose={() => setDetail(null)}
        />
      ) : null}

      {/* Toast */}
      {toast ? (
        <div key={toast.key} className="td-toast" role="status">
          <Check size={14} />
          {toast.msg}
        </div>
      ) : null}
    </div>
  );
}
