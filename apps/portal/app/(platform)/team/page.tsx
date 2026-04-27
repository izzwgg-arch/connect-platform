"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  Grid3X3,
  List,
  MessageSquare,
  MoreHorizontal,
  Phone,
  Search,
  UserRound,
  X
} from "lucide-react";
import { LiveBadge } from "../../../components/LiveBadge";
import { PageHeader } from "../../../components/PageHeader";
import { useTelephony } from "../../../contexts/TelephonyContext";
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { useDebouncedValue } from "../../../hooks/useDebouncedValue";
import { useSipPhone } from "../../../hooks/useSipPhone";
import { apiGet } from "../../../services/apiClient";
import type { LiveCall, LiveExtensionState } from "../../../types/liveCall";

type PresenceState = "available" | "ringing" | "on_call" | "busy" | "offline" | "unknown";
type ViewMode = "cards" | "list";
type StatusFilter = "all" | "available" | "on_call" | "ringing" | "offline";
type SortKey = "name" | "extension" | "status";

type TeamMember = {
  id: string;
  name: string;
  extension: string;
  email?: string;
  phone?: string;
  department?: string;
  title?: string;
  tenantName?: string;
  tenantId?: string | null;
  presence: PresenceState;
  currentCall?: string;
  lastSeen?: string;
};

type ExtensionResponse = {
  rows: Record<string, unknown>[];
};

// Keep this page as the single Team Directory surface: scoped PBX directory data plus live presence.
const STATUS_META: Record<PresenceState, { label: string; tone: string; sort: number }> = {
  ringing: { label: "Ringing", tone: "ringing", sort: 0 },
  on_call: { label: "On Call", tone: "on-call", sort: 1 },
  available: { label: "Available", tone: "available", sort: 2 },
  busy: { label: "Busy", tone: "busy", sort: 3 },
  offline: { label: "Offline", tone: "offline", sort: 4 },
  unknown: { label: "Unknown", tone: "unknown", sort: 5 }
};

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "available", label: "Available" },
  { key: "on_call", label: "On Call" },
  { key: "ringing", label: "Ringing" },
  { key: "offline", label: "Offline" }
];

function cleanValue(value: unknown): string | undefined {
  const next = String(value ?? "").trim();
  return next ? next : undefined;
}

function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function extensionFromRow(row: Record<string, unknown>, fallback: number): string {
  return cleanValue(row.extension) ?? cleanValue(row.number) ?? cleanValue(row.ext) ?? String(fallback);
}

function rowTenantMatches(row: Record<string, unknown>, scopedTenantId: string | null): boolean {
  if (!scopedTenantId) return true;
  const raw =
    cleanValue(row.tenantId) ??
    cleanValue(row.tenant_id) ??
    cleanValue(row.pbxTenantId) ??
    cleanValue(row.vpbxTenantId);
  if (!raw) return true; // REST calls are scoped by x-tenant-context; only filter when the row exposes tenant identity.
  return raw === scopedTenantId || `vpbx:${raw}` === scopedTenantId || raw === scopedTenantId.replace(/^vpbx:/, "");
}

function mapPresence(
  rawState: string | undefined,
  extension: string,
  activeExts: Set<string>,
  ringingExts: Set<string>,
  presenceUnavailable: boolean
): PresenceState {
  if (ringingExts.has(extension)) return "ringing";
  if (activeExts.has(extension)) return "on_call";
  const state = String(rawState ?? "").toLowerCase();
  if (state === "not_inuse" || state === "idle" || state === "registered" || state === "0") return "available";
  if (state === "inuse" || state === "onhold" || state === "1") return "on_call";
  if (state === "ringing" || state === "2") return "ringing";
  if (state === "busy" || state === "3") return "busy";
  if (state === "unavailable" || state === "offline" || state === "unregistered" || state === "5") return "offline";
  return presenceUnavailable ? "unknown" : "offline";
}

function formatLastSeen(value?: string): string | undefined {
  if (!value) return undefined;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return undefined;
  const diff = Math.max(0, Date.now() - ts);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ts).toLocaleDateString();
}

function currentCallLabel(call: LiveCall | undefined, extension: string): string | undefined {
  if (!call) return undefined;
  const other = [call.fromName, call.from, call.to, call.connectedLine].find((v) => v && v !== extension);
  if (call.state === "ringing" || call.state === "dialing") return other ? `Ringing: ${other}` : "Ringing";
  return other ? `In call with ${other}` : "In active call";
}

function TeamActions({
  member,
  open,
  onToggle,
  onCall,
  onCopy,
  onDetails
}: {
  member: TeamMember;
  open: boolean;
  onToggle: () => void;
  onCall: (member: TeamMember) => void;
  onCopy: (member: TeamMember) => void;
  onDetails: (member: TeamMember) => void;
}) {
  return (
    <div className="team-actions-menu">
      <button className="team-icon-btn" type="button" onClick={onToggle} aria-label={`Actions for ${member.name}`}>
        <MoreHorizontal size={18} />
      </button>
      {open ? (
        <div className="team-actions-popover">
          <button type="button" onClick={() => onCall(member)}>
            <Phone size={15} /> Call
          </button>
          <Link href={`/chat?user=${encodeURIComponent(member.id)}`}>
            <MessageSquare size={15} /> Message
          </Link>
          <button type="button" onClick={() => onDetails(member)}>
            <UserRound size={15} /> View details
          </button>
          <button type="button" onClick={() => onCopy(member)}>
            <Copy size={15} /> Copy extension
          </button>
        </div>
      ) : null}
    </div>
  );
}

function StatusPill({ state }: { state: PresenceState }) {
  const meta = STATUS_META[state];
  return (
    <span className={`team-status-pill team-status-${meta.tone}`}>
      <span className="team-status-dot" />
      {meta.label}
    </span>
  );
}

function MemberCard({
  member,
  menuOpen,
  onToggleMenu,
  onCall,
  onCopy,
  onDetails
}: {
  member: TeamMember;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCall: (member: TeamMember) => void;
  onCopy: (member: TeamMember) => void;
  onDetails: (member: TeamMember) => void;
}) {
  return (
    <article className={`team-card team-card-${STATUS_META[member.presence].tone}`}>
      <div className="team-card-top">
        <div className="team-avatar" aria-hidden>{initials(member.name)}</div>
        <TeamActions
          member={member}
          open={menuOpen}
          onToggle={onToggleMenu}
          onCall={onCall}
          onCopy={onCopy}
          onDetails={onDetails}
        />
      </div>
      <div className="team-card-main">
        <div>
          <h3>{member.name}</h3>
          <p>Ext {member.extension}</p>
        </div>
        <StatusPill state={member.presence} />
      </div>
      <div className="team-card-meta">
        <span>{member.title || "Team member"}</span>
        {member.department ? <span>{member.department}</span> : null}
        {member.email ? <span>{member.email}</span> : null}
      </div>
      <div className="team-card-footer">
        <span>{member.currentCall || member.lastSeen || "Directory profile"}</span>
        <button type="button" onClick={() => onCall(member)}>
          <Phone size={15} /> Call
        </button>
      </div>
    </article>
  );
}

function DetailsPanel({ member, onClose, onCall, onCopy }: { member: TeamMember; onClose: () => void; onCall: (member: TeamMember) => void; onCopy: (member: TeamMember) => void }) {
  return (
    <aside className="team-detail-panel" aria-label="Team member details">
      <div className="team-detail-head">
        <button className="team-icon-btn" type="button" onClick={onClose} aria-label="Close details">
          <X size={18} />
        </button>
      </div>
      <div className="team-detail-profile">
        <div className="team-avatar team-avatar-lg" aria-hidden>{initials(member.name)}</div>
        <div>
          <h2>{member.name}</h2>
          <p>{member.title || member.department || "Team member"}</p>
        </div>
        <StatusPill state={member.presence} />
      </div>
      <div className="team-detail-actions">
        <button className="btn" type="button" onClick={() => onCall(member)}>
          <Phone size={16} /> Call Ext {member.extension}
        </button>
        <Link className="btn ghost" href={`/chat?user=${encodeURIComponent(member.id)}`}>
          <MessageSquare size={16} /> Message
        </Link>
        <button className="btn ghost" type="button" onClick={() => onCopy(member)}>
          <Copy size={16} /> Copy extension
        </button>
      </div>
      <dl className="team-detail-list">
        <div><dt>Extension</dt><dd>{member.extension}</dd></div>
        <div><dt>Status</dt><dd>{STATUS_META[member.presence].label}</dd></div>
        <div><dt>Role</dt><dd>{member.title || "—"}</dd></div>
        <div><dt>Department</dt><dd>{member.department || "—"}</dd></div>
        <div><dt>Email</dt><dd>{member.email || "—"}</dd></div>
        <div><dt>Tenant</dt><dd>{member.tenantName || member.tenantId || "Selected tenant"}</dd></div>
        <div><dt>Current call</dt><dd>{member.currentCall || "—"}</dd></div>
        <div><dt>Last seen</dt><dd>{member.lastSeen || "—"}</dd></div>
      </dl>
    </aside>
  );
}

export default function TeamPage() {
  const telephony = useTelephony();
  const phone = useSipPhone();
  const { adminScope, tenantId, tenant, user } = useAppContext();
  const scopedTenantId = adminScope === "GLOBAL" ? null : tenantId;
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 180);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("status");
  const [view, setView] = useState<ViewMode>("cards");
  const [selected, setSelected] = useState<TeamMember | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const viewKey = `cc-team-directory-view:${user.id}`;

  useEffect(() => {
    const stored = localStorage.getItem(viewKey);
    if (stored === "cards" || stored === "list") setView(stored);
  }, [viewKey]);

  function setViewMode(next: ViewMode) {
    setView(next);
    localStorage.setItem(viewKey, next);
  }

  const extState = useAsyncResource<ExtensionResponse>(
    () => apiGet("/voice/pbx/resources/extensions"),
    [scopedTenantId, adminScope]
  );

  const scopedCalls = useMemo(() => {
    return scopedTenantId ? telephony.callsByTenant(scopedTenantId) : telephony.activeCalls;
  }, [scopedTenantId, telephony]);

  const scopedExtensions = useMemo(() => {
    if (!scopedTenantId) return telephony.extensionList;
    return telephony.extensionList.filter((entry) => entry.tenantId === scopedTenantId);
  }, [scopedTenantId, telephony.extensionList]);

  const { activeExts, ringingExts, callByExt } = useMemo(() => {
    const active = new Set<string>();
    const ringing = new Set<string>();
    const byExt = new Map<string, LiveCall>();
    scopedCalls.forEach((call) => {
      call.extensions.forEach((ext) => {
        byExt.set(ext, call);
        if (call.state === "up" || call.state === "held") active.add(ext);
        if (call.state === "ringing" || call.state === "dialing") ringing.add(ext);
      });
    });
    return { activeExts: active, ringingExts: ringing, callByExt: byExt };
  }, [scopedCalls]);

  const presenceUnavailable = telephony.status !== "connected";

  const members = useMemo<TeamMember[]>(() => {
    const extRows = extState.status === "success" ? extState.data.rows.filter((row) => rowTenantMatches(row, scopedTenantId)) : [];
    const liveByExt = new Map<string, LiveExtensionState>(scopedExtensions.map((entry) => [entry.extension, entry]));

    if (extRows.length === 0) {
      return scopedExtensions.map((entry) => {
        const call = callByExt.get(entry.extension);
        return {
          id: entry.extension,
          name: entry.hint || `Extension ${entry.extension}`,
          extension: entry.extension,
          tenantId: entry.tenantId,
          tenantName: tenant.name,
          presence: mapPresence(entry.status, entry.extension, activeExts, ringingExts, presenceUnavailable),
          currentCall: currentCallLabel(call, entry.extension),
          lastSeen: formatLastSeen(entry.updatedAt)
        };
      });
    }

    return extRows.map((row, index) => {
      const ext = extensionFromRow(row, index);
      const live = liveByExt.get(ext);
      const call = callByExt.get(ext);
      const name =
        cleanValue(row.name) ??
        cleanValue(row.display_name) ??
        cleanValue(row.callerid) ??
        cleanValue(row.fullName) ??
        `Extension ${ext}`;
      return {
        id: cleanValue(row.id) ?? cleanValue(row.uuid) ?? ext,
        name,
        extension: ext,
        email: cleanValue(row.email),
        phone: cleanValue(row.phone) ?? cleanValue(row.mobile),
        department: cleanValue(row.department) ?? cleanValue(row.team),
        title: cleanValue(row.title) ?? cleanValue(row.role),
        tenantId: cleanValue(row.tenantId) ?? cleanValue(row.tenant_id) ?? live?.tenantId ?? scopedTenantId,
        tenantName: cleanValue(row.tenantName) ?? tenant.name,
        presence: mapPresence(live?.status ?? cleanValue(row.state), ext, activeExts, ringingExts, presenceUnavailable),
        currentCall: currentCallLabel(call, ext),
        lastSeen: formatLastSeen(live?.updatedAt)
      };
    });
  }, [activeExts, callByExt, extState, presenceUnavailable, ringingExts, scopedExtensions, scopedTenantId, tenant.name]);

  const visible = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    let list = members.filter((member) => {
      const matchesSearch =
        !q ||
        member.name.toLowerCase().includes(q) ||
        member.extension.toLowerCase().includes(q) ||
        (member.email ?? "").toLowerCase().includes(q);
      const matchesStatus =
        statusFilter === "all" ||
        member.presence === statusFilter ||
        (statusFilter === "offline" && member.presence === "unknown");
      return matchesSearch && matchesStatus;
    });

    list = [...list].sort((a, b) => {
      if (sortKey === "extension") return a.extension.localeCompare(b.extension, undefined, { numeric: true });
      if (sortKey === "name") return a.name.localeCompare(b.name);
      return STATUS_META[a.presence].sort - STATUS_META[b.presence].sort || a.name.localeCompare(b.name);
    });
    return list;
  }, [debouncedSearch, members, sortKey, statusFilter]);

  const counts = useMemo(() => ({
    all: members.length,
    available: members.filter((m) => m.presence === "available").length,
    on_call: members.filter((m) => m.presence === "on_call").length,
    ringing: members.filter((m) => m.presence === "ringing").length,
    offline: members.filter((m) => m.presence === "offline" || m.presence === "unknown").length
  }), [members]);

  function handleCall(member: TeamMember) {
    phone.setDialpadInput(member.extension);
    phone.dial(member.extension);
    setOpenMenu(null);
  }

  async function copyExtension(member: TeamMember) {
    try {
      await navigator.clipboard.writeText(member.extension);
      setToast(`Copied extension ${member.extension}`);
    } catch {
      setToast("Copy failed");
    }
    setOpenMenu(null);
    window.setTimeout(() => setToast(null), 1800);
  }

  function showDetails(member: TeamMember) {
    setSelected(member);
    setOpenMenu(null);
  }

  const emptyText = debouncedSearch || statusFilter !== "all"
    ? "No matching team members."
    : "No team members found for this tenant.";

  return (
    <div className="team-directory-page">
      <PageHeader
        title="Team Directory"
        subtitle={`Live presence and directory info for ${adminScope === "GLOBAL" ? "all workspaces" : tenant.name}.`}
        actions={<LiveBadge status={telephony.status} />}
      />

      {presenceUnavailable ? (
        <div className="team-warning">Presence is temporarily unavailable. Directory data is still shown.</div>
      ) : null}

      <section className="team-toolbar">
        <div className="team-search">
          <Search size={17} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name, extension, email..."
          />
        </div>
        <div className="team-filter-row">
          {FILTERS.map((filter) => (
            <button
              key={filter.key}
              type="button"
              className={statusFilter === filter.key ? "active" : ""}
              onClick={() => setStatusFilter(filter.key)}
            >
              {filter.label}
              <span>{counts[filter.key]}</span>
            </button>
          ))}
        </div>
        <select className="team-sort" value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)} aria-label="Sort team directory">
          <option value="status">Sort by status</option>
          <option value="name">Sort by name</option>
          <option value="extension">Sort by extension</option>
        </select>
        <div className="team-view-toggle" aria-label="Team directory view">
          <button type="button" className={view === "cards" ? "active" : ""} onClick={() => setViewMode("cards")}>
            <Grid3X3 size={16} /> Cards
          </button>
          <button type="button" className={view === "list" ? "active" : ""} onClick={() => setViewMode("list")}>
            <List size={16} /> List
          </button>
        </div>
      </section>

      <div className="team-summary-line">
        <span>{visible.length} of {members.length} team members</span>
        <span>{scopedTenantId ? "Tenant scoped" : "Global admin view"}</span>
      </div>

      {extState.status === "loading" ? (
        <div className="team-empty-state">Loading team directory...</div>
      ) : visible.length === 0 ? (
        <div className="team-empty-state">{emptyText}</div>
      ) : view === "cards" ? (
        <section className="team-card-grid">
          {visible.map((member) => (
            <MemberCard
              key={member.id}
              member={member}
              menuOpen={openMenu === member.id}
              onToggleMenu={() => setOpenMenu(openMenu === member.id ? null : member.id)}
              onCall={handleCall}
              onCopy={copyExtension}
              onDetails={showDetails}
            />
          ))}
        </section>
      ) : (
        <section className="team-list-panel">
          <div className="team-list-head">
            <span>Status</span>
            <span>Name</span>
            <span>Extension</span>
            <span>Role</span>
            <span>Department</span>
            <span>Current state</span>
            <span>Actions</span>
          </div>
          {visible.map((member) => (
            <div className="team-list-row" key={member.id}>
              <StatusPill state={member.presence} />
              <div className="team-list-name">
                <strong>{member.name}</strong>
                {member.email ? <span>{member.email}</span> : null}
              </div>
              <span>Ext {member.extension}</span>
              <span>{member.title || "—"}</span>
              <span>{member.department || "—"}</span>
              <span>{member.currentCall || member.lastSeen || STATUS_META[member.presence].label}</span>
              <TeamActions
                member={member}
                open={openMenu === member.id}
                onToggle={() => setOpenMenu(openMenu === member.id ? null : member.id)}
                onCall={handleCall}
                onCopy={copyExtension}
                onDetails={showDetails}
              />
            </div>
          ))}
        </section>
      )}

      {selected ? (
        <DetailsPanel member={selected} onClose={() => setSelected(null)} onCall={handleCall} onCopy={copyExtension} />
      ) : null}

      {toast ? (
        <div className="team-toast">
          <Check size={16} /> {toast}
        </div>
      ) : null}
    </div>
  );
}
