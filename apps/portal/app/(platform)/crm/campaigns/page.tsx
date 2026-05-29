"use client";

import { useEffect, useState, useCallback, useMemo, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Activity,
  Archive,
  CalendarDays,
  CheckCircle2,
  Clock3,
  FileUp,
  Filter,
  Gauge,
  Grid2X2,
  Megaphone,
  Pause,
  Plus,
  Search,
  Send,
  Target,
  TrendingUp,
  Users,
  Zap,
} from "lucide-react";
import {
  CRMPageShell,
  CRMActionBar,
  CampaignQuickActionStrip,
  CampaignGuidedEmpty,
  type CampaignListItem,
  type CampaignReportRow,
  type CampaignStatus,
} from "../../../../components/crm";
import { crm } from "../../../../components/crm/crmClasses";
import { mk } from "../../../../components/crm/campaign/campaignCinemaClasses";
import { apiGet, apiPost, apiPatch } from "../../../../services/apiClient";
import { useAppContext } from "../../../../hooks/useAppContext";
import { cn } from "../../../../components/crm/cn";
import { CAMPAIGN_PRIORITY_LABELS, CAMPAIGN_STATUS_LABELS } from "../../../../components/crm/campaign/campaignTypes";
import { formatShortDate, queueHref } from "../../../../components/crm/campaign/campaignUtils";

const STATUS_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All" },
  { value: "ACTIVE", label: CAMPAIGN_STATUS_LABELS.ACTIVE },
  { value: "PAUSED", label: CAMPAIGN_STATUS_LABELS.PAUSED },
  { value: "DRAFT", label: CAMPAIGN_STATUS_LABELS.DRAFT },
  { value: "COMPLETED", label: CAMPAIGN_STATUS_LABELS.COMPLETED },
  { value: "ARCHIVED", label: CAMPAIGN_STATUS_LABELS.ARCHIVED },
];

type CampaignSort = "status" | "updated" | "name";
type CampaignQuickFilter = "all" | CampaignStatus | "SCHEDULED";
type CampaignTypeFilter = "all" | "LOW" | "NORMAL" | "HIGH" | "URGENT" | "SCRIPTED" | "CHECKLIST";

const QUICK_FILTER_OPTIONS: { value: CampaignQuickFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "ACTIVE", label: "Active" },
  { value: "SCHEDULED", label: "Scheduled" },
  { value: "PAUSED", label: "Paused" },
  { value: "COMPLETED", label: "Completed" },
  { value: "DRAFT", label: "Draft" },
  { value: "ARCHIVED", label: "Archived" },
];

const TYPE_FILTER_OPTIONS: { value: CampaignTypeFilter; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "SCRIPTED", label: "Has script" },
  { value: "CHECKLIST", label: "Has checklist" },
  { value: "LOW", label: "Low priority" },
  { value: "NORMAL", label: "Normal priority" },
  { value: "HIGH", label: "High priority" },
  { value: "URGENT", label: "Urgent priority" },
];

const CAMPAIGN_STATUS_TONE: Record<CampaignStatus | "SCHEDULED", string> = {
  ACTIVE: "campaigns-status-active",
  PAUSED: "campaigns-status-paused",
  DRAFT: "campaigns-status-draft",
  COMPLETED: "campaigns-status-completed",
  ARCHIVED: "campaigns-status-archived",
  SCHEDULED: "campaigns-status-scheduled",
};

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatPercent(value: number): string {
  return `${Number.isFinite(value) ? value.toFixed(value % 1 === 0 ? 0 : 1) : "0"}%`;
}

function campaignCountForFilter(campaigns: CampaignListItem[], key: CampaignQuickFilter) {
  if (key === "all") return campaigns.length;
  if (key === "SCHEDULED") return 0;
  return campaigns.filter((campaign) => campaign.status === key).length;
}

function campaignTypeLabel(campaign: CampaignListItem) {
  if (campaign.script && campaign.checklist) return "Playbook";
  if (campaign.script) return "Scripted";
  if (campaign.checklist) return "Checklist";
  return CAMPAIGN_PRIORITY_LABELS[campaign.priority] ?? "Standard";
}

function campaignOwnerLabel(campaign: CampaignListItem) {
  if (campaign.script?.name) return campaign.script.name;
  if (campaign.checklist?.name) return campaign.checklist.name;
  return "Support Team";
}

function Sparkline({ seed, tone = "blue" }: { seed: string; tone?: "blue" | "green" | "violet" | "orange" | "red" }) {
  const color =
    tone === "green" ? "#10b981" : tone === "violet" ? "#8b5cf6" : tone === "orange" ? "#f59e0b" : tone === "red" ? "#ef4444" : "#3b82f6";
  const points = useMemo(() => {
    let hash = 0;
    for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) % 997;
    return Array.from({ length: 9 }, (_, i) => {
      const n = Math.sin((hash + i * 19) / 13) * 13 + Math.cos((hash + i * 7) / 9) * 8;
      return 34 - Math.max(5, Math.min(31, 18 + n));
    });
  }, [seed]);
  const d = points.map((y, i) => `${i === 0 ? "M" : "L"} ${i * 11} ${y}`).join(" ");
  return (
    <svg className="h-9 w-24" viewBox="0 0 88 38" fill="none" aria-hidden>
      <path d={`${d} L 88 38 L 0 38 Z`} fill={color} opacity="0.10" />
      <path d={d} stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CampaignKpiTile({
  label,
  value,
  trend,
  icon,
  tone,
}: {
  label: string;
  value: string | number;
  trend: string;
  icon: ReactNode;
  tone: "blue" | "green" | "violet" | "orange" | "red" | "cyan";
}) {
  return (
    <article className={cn("campaigns-kpi-card", `campaigns-kpi-${tone}`)}>
      <div className="campaigns-kpi-icon">{icon}</div>
      <p className="campaigns-kpi-label">{label}</p>
      <p className="campaigns-kpi-value">{value}</p>
      <p className="campaigns-kpi-trend">{trend}</p>
    </article>
  );
}

function CampaignStatusPill({ status }: { status: CampaignStatus }) {
  return (
    <span className={cn("campaigns-status-pill", CAMPAIGN_STATUS_TONE[status])}>
      <span className="campaigns-status-dot" />
      {CAMPAIGN_STATUS_LABELS[status]}
    </span>
  );
}

function CampaignHealthDonut({
  healthy,
  warning,
  problem,
}: {
  healthy: number;
  warning: number;
  problem: number;
}) {
  const total = Math.max(healthy + warning + problem, 1);
  const healthyPct = Math.round((healthy / total) * 100);
  const warningPct = Math.round((warning / total) * 100);
  return (
    <div className="campaigns-health-donut-wrap">
      <div
        className="campaigns-health-donut"
        style={{
          background: `conic-gradient(#10b981 0 ${healthyPct}%, #f59e0b ${healthyPct}% ${healthyPct + warningPct}%, #ef4444 ${healthyPct + warningPct}% 100%)`,
        }}
      >
        <div className="campaigns-health-donut-core">
          <span>{healthyPct}%</span>
          <small>healthy</small>
        </div>
      </div>
    </div>
  );
}

function CreateCampaignModal({
  onClose,
  onCreate,
  importAfterCreate = false,
}: {
  onClose: () => void;
  onCreate: (c: CampaignListItem) => void;
  importAfterCreate?: boolean;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<CampaignListItem["priority"]>("NORMAL");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError("");
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("token") ?? undefined : undefined;
      const res = await apiPost<{ campaign: CampaignListItem }>(
        "/crm/campaigns",
        { name: name.trim(), description: description.trim() || undefined, priority },
        token,
      );
      onCreate(res.campaign);
    } catch (err: unknown) {
      setError((err as Error)?.message ?? "Failed to create campaign");
      setSaving(false);
    }
  }

  return (
    <div className={crm.campaignModalBackdrop}>
      <div className={cn(crm.card, "w-full max-w-md p-6 shadow-xl")}>
        <h2 className="text-lg font-semibold text-crm-text mb-1">
          {importAfterCreate ? "Create campaign & import leads" : "New campaign"}
        </h2>
        {importAfterCreate && (
          <p className="text-sm text-crm-muted mb-4">
            Name your campaign, then import a CSV on the next screen. Contacts will be added as campaign members.
          </p>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-crm-text mb-1">Campaign name</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={crm.input}
              placeholder="e.g. Q3 Outbound"
              maxLength={200}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-crm-text mb-1">
              Description <span className="text-crm-muted font-normal">(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={cn(crm.input, "resize-none min-h-[5.5rem] bg-crm-surface-2/90")}
              rows={3}
              placeholder="Objective for agents…"
              maxLength={2000}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-crm-text mb-1">Queue priority</label>
            <div className="flex gap-2 flex-wrap">
              {(["NORMAL", "HIGH", "URGENT"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority(p)}
                  className={cn(
                    crm.campaignPriorityPill,
                    priority === p &&
                      (p === "URGENT"
                        ? crm.campaignPriorityPillUrgent
                        : p === "HIGH"
                          ? crm.campaignPriorityPillHigh
                          : crm.campaignPriorityPillActive),
                  )}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          {error ? <p className="text-sm text-crm-danger">{error}</p> : null}
          <div className="flex gap-2 justify-end pt-2">
            <button type="button" onClick={onClose} className={crm.btnSecondary}>
              Cancel
            </button>
            <button type="submit" disabled={saving || !name.trim()} className={crm.btnPrimary}>
              {saving ? "Creating…" : importAfterCreate ? "Create & go to import" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function CampaignsPage() {
  const router = useRouter();
  const { backendJwtRole, can } = useAppContext();

  const isAdmin =
    backendJwtRole === "ADMIN" ||
    backendJwtRole === "TENANT_ADMIN" ||
    backendJwtRole === "SUPER_ADMIN" ||
    can("can_manage_crm");

  const canQueue = can("can_view_crm_queue");

  const [campaigns, setCampaigns] = useState<CampaignListItem[]>([]);
  const [reportById, setReportById] = useState<Map<string, CampaignReportRow>>(new Map());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<CampaignQuickFilter>("all");
  const [typeFilter, setTypeFilter] = useState<CampaignTypeFilter>("all");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("all");
  const [sortBy, setSortBy] = useState<CampaignSort>("status");
  const [showCreate, setShowCreate] = useState(false);
  const [createForImport, setCreateForImport] = useState(false);
  const [error, setError] = useState("");

  const token = typeof window !== "undefined" ? localStorage.getItem("token") ?? undefined : undefined;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [listRes, reportRes] = await Promise.all([
        apiGet<{ campaigns: CampaignListItem[] }>("/crm/campaigns", token),
        apiGet<{ campaigns: CampaignReportRow[] }>("/crm/reports/campaigns?status=all", token).catch(() => ({
          campaigns: [] as CampaignReportRow[],
        })),
      ]);
      setCampaigns(listRes.campaigns);
      const map = new Map<string, CampaignReportRow>();
      for (const r of reportRes.campaigns) map.set(r.id, r);
      setReportById(map);
    } catch (err: unknown) {
      setError((err as Error)?.message ?? "Failed to load campaigns");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleQuickStatus(id: string, status: CampaignStatus, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    try {
      await apiPatch(`/crm/campaigns/${id}`, { status }, token);
      setCampaigns((prev) => prev.map((c) => (c.id === id ? { ...c, status } : c)));
    } catch {
      void load();
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = campaigns;
    if (q) {
      list = list.filter((c) =>
        [c.name, c.description ?? "", c.script?.name ?? "", c.checklist?.name ?? ""].some((value) =>
          value.toLowerCase().includes(q),
        ),
      );
    }
    if (statusFilter !== "all") {
      list = statusFilter === "SCHEDULED" ? [] : list.filter((c) => c.status === statusFilter);
    }
    if (typeFilter !== "all") {
      list = list.filter((c) => {
        if (typeFilter === "SCRIPTED") return Boolean(c.script);
        if (typeFilter === "CHECKLIST") return Boolean(c.checklist);
        return c.priority === typeFilter;
      });
    }
    if (ownerFilter !== "all") {
      list = list.filter((c) => campaignOwnerLabel(c) === ownerFilter);
    }
    if (dateFilter !== "all") {
      const now = Date.now();
      const days = dateFilter === "7d" ? 7 : dateFilter === "30d" ? 30 : 90;
      list = list.filter((c) => now - new Date(c.updatedAt).getTime() <= days * 24 * 60 * 60 * 1000);
    }
    return [...list].sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name);
      if (sortBy === "updated") {
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      }
      const order = (s: CampaignStatus) =>
        s === "ACTIVE" ? 0 : s === "PAUSED" ? 1 : s === "DRAFT" ? 2 : 3;
      const d = order(a.status) - order(b.status);
      if (d !== 0) return d;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [campaigns, dateFilter, ownerFilter, search, sortBy, statusFilter, typeFilter]);

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (!isAdmin) return;
      const t = e.target as HTMLElement | null;
      if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.tagName === "SELECT" || t?.isContentEditable) {
        return;
      }
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        setShowCreate(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isAdmin]);

  const summary = useMemo(() => {
    let active = 0;
    let paused = 0;
    let completed = 0;
    let draft = 0;
    let archived = 0;
    let queueWork = 0;
    let callbacks = 0;
    let members = 0;
    let contacted = 0;
    let converted = 0;
    let attempts = 0;
    let conversionRateTotal = 0;
    let conversionRateRows = 0;
    for (const c of campaigns) {
      members += c.memberCount ?? 0;
      if (c.status === "ACTIVE") active += 1;
      if (c.status === "PAUSED") paused += 1;
      if (c.status === "COMPLETED") completed += 1;
      if (c.status === "DRAFT") draft += 1;
      if (c.status === "ARCHIVED") archived += 1;
      const m = reportById.get(c.id);
      if (m) {
        queueWork += m.pending;
        callbacks += m.callbacks;
        contacted += m.contacted;
        converted += m.converted;
        attempts += m.totalAttempts;
        conversionRateTotal += m.conversionRate;
        conversionRateRows += 1;
      }
    }
    const avgConversionRate = conversionRateRows > 0 ? conversionRateTotal / conversionRateRows : 0;
    return {
      active,
      paused,
      completed,
      draft,
      archived,
      queueWork,
      callbacks,
      members,
      contacted,
      converted,
      attempts,
      avgConversionRate,
    };
  }, [campaigns, reportById]);

  const ownerOptions = useMemo(() => {
    const owners = new Set(campaigns.map(campaignOwnerLabel));
    return Array.from(owners).sort((a, b) => a.localeCompare(b));
  }, [campaigns]);

  const topCampaigns = useMemo(() => {
    return campaigns
      .map((campaign) => ({
        campaign,
        metrics: reportById.get(campaign.id),
      }))
      .sort((a, b) => (b.metrics?.conversionRate ?? 0) - (a.metrics?.conversionRate ?? 0))
      .slice(0, 5);
  }, [campaigns, reportById]);

  const recentActivity = useMemo(() => {
    return [...campaigns]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 4);
  }, [campaigns]);

  const listEmptyNoCampaigns = !loading && !error && campaigns.length === 0;
  const listEmptyAfterFilter = !loading && !error && campaigns.length > 0 && filtered.length === 0;

  return (
    <CRMPageShell innerClassName={cn(mk.pageInner, mk.workspace, "pb-36")}>
      {showCreate && (
        <CreateCampaignModal
          importAfterCreate={createForImport}
          onClose={() => { setShowCreate(false); setCreateForImport(false); }}
          onCreate={(c) => {
            setCampaigns((prev) => [{ ...c, memberCount: c.memberCount ?? 0 }, ...prev]);
            const dest = createForImport
              ? `/crm/campaigns/${c.id}?openImport=1`
              : `/crm/campaigns/${c.id}`;
            setShowCreate(false);
            setCreateForImport(false);
            router.push(dest);
          }}
        />
      )}

      <header className="campaigns-overview-hero">
        <div className="campaigns-hero-copy">
          <div className="campaigns-hero-icon">
            <Megaphone className="h-7 w-7" />
          </div>
          <div>
            <p className="campaigns-eyebrow">CRM outreach command center</p>
            <h1>Campaigns</h1>
            <p>Create, manage, and analyze outbound programs with live operational context.</p>
          </div>
        </div>
        <div className="campaigns-hero-actions">
          {isAdmin && (
            <button
              type="button"
              onClick={() => { setCreateForImport(true); setShowCreate(true); }}
              className="campaigns-btn-secondary"
            >
              <FileUp className="h-4 w-4" />
              Import Leads
            </button>
          )}
          {canQueue && (
            <Link href="/crm/scripts" className="campaigns-btn-secondary">
              <Grid2X2 className="h-4 w-4" />
              Templates
            </Link>
          )}
          {isAdmin && (
            <button type="button" onClick={() => setShowCreate(true)} className="campaigns-btn-primary">
              <Plus className="h-4 w-4" />
              New Campaign
            </button>
          )}
        </div>
      </header>

      {!loading && !error && campaigns.length > 0 ? (
        <section className="campaigns-kpi-grid" aria-label="Campaign metrics">
          <CampaignKpiTile label="Total Campaigns" value={formatNumber(campaigns.length)} trend="+ across all statuses" tone="blue" icon={<CalendarDays className="h-5 w-5" />} />
          <CampaignKpiTile label="Active Campaigns" value={formatNumber(summary.active)} trend={summary.paused > 0 ? `${summary.paused} paused` : "All live programs clear"} tone="violet" icon={<Zap className="h-5 w-5" />} />
          <CampaignKpiTile label="Total Contacts" value={formatNumber(summary.members)} trend="Across campaign rosters" tone="green" icon={<Users className="h-5 w-5" />} />
          <CampaignKpiTile label="Contacted" value={formatNumber(summary.contacted)} trend={`${formatNumber(summary.attempts)} total attempts`} tone="cyan" icon={<Send className="h-5 w-5" />} />
          <CampaignKpiTile label="Converted" value={formatNumber(summary.converted)} trend={`${summary.callbacks} callbacks waiting`} tone="orange" icon={<CheckCircle2 className="h-5 w-5" />} />
          <CampaignKpiTile label="Conversion Rate" value={formatPercent(summary.avgConversionRate)} trend="Average by campaign" tone="red" icon={<Target className="h-5 w-5" />} />
        </section>
      ) : null}

      <CRMActionBar className="campaigns-filter-panel">
        <div className="campaigns-filter-row">
          <div className="campaigns-search-wrap">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-crm-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="campaigns-search-input"
              placeholder="Search campaigns by name, script, checklist..."
              aria-label="Search campaigns"
            />
          </div>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as CampaignQuickFilter)} className="campaigns-select" aria-label="Status filter">
            {STATUS_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
            <option value="SCHEDULED">Scheduled</option>
          </select>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as CampaignTypeFilter)} className="campaigns-select" aria-label="Type filter">
            {TYPE_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)} className="campaigns-select" aria-label="Owner filter">
            <option value="all">All owners</option>
            {ownerOptions.map((owner) => (
              <option key={owner} value={owner}>{owner}</option>
            ))}
          </select>
          <select value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} className="campaigns-select" aria-label="Date range">
            <option value="all">Date range</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
          </select>
          <button type="button" className="campaigns-filter-button" aria-label="Open filters">
            <Filter className="h-4 w-4" />
            Filters
          </button>
        </div>
        <div className="campaigns-quick-pills" role="group" aria-label="Quick campaign filters">
          {QUICK_FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setStatusFilter(opt.value)}
              className={cn("campaigns-quick-pill", statusFilter === opt.value && "campaigns-quick-pill-active")}
            >
              {opt.label}
              <span>{campaignCountForFilter(campaigns, opt.value)}</span>
            </button>
          ))}
          <button
            type="button"
            className="campaigns-clear-filters"
            onClick={() => {
              setSearch("");
              setStatusFilter("all");
              setTypeFilter("all");
              setOwnerFilter("all");
              setDateFilter("all");
            }}
          >
            Clear filters
          </button>
        </div>
      </CRMActionBar>

      {loading ? (
        <p className="py-16 text-center text-sm text-crm-muted">Loading campaigns…</p>
      ) : error ? (
        <p className="py-16 text-center text-sm text-crm-danger">{error}</p>
      ) : listEmptyNoCampaigns ? (
        <CampaignGuidedEmpty
          icon={<Megaphone className="h-5 w-5" />}
          title="No campaigns yet"
          steps={[
            { label: "Create a campaign", hint: "group leads and scripts" },
            { label: "Import or add contacts", hint: "build the roster" },
            { label: "Open queue", hint: "start outbound work" },
          ]}
          action={
            <>
              {isAdmin && (
                <button type="button" onClick={() => setShowCreate(true)} className={crm.btnPrimary}>
                  <Plus className="h-4 w-4" /> New campaign
                </button>
              )}
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => { setCreateForImport(true); setShowCreate(true); }}
                  className={crm.btnSecondary}
                >
                  <FileUp className="h-4 w-4" /> Import leads
                </button>
              )}
            </>
          }
        />
      ) : listEmptyAfterFilter ? (
        <CampaignGuidedEmpty
          compact
          title="No campaigns match"
          steps={[{ label: "Clear search or filters", hint: "to see more programs" }]}
          action={
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setStatusFilter("all");
              }}
              className={crm.btnSecondary}
            >
              Reset filters
            </button>
          }
        />
      ) : (
        <div className="campaigns-workspace-grid">
          <section className="campaigns-table-card" aria-label="Campaign table">
            <div className="campaigns-table-head">
              <div>
                <h2>Campaign portfolio</h2>
                <p>Showing {filtered.length} of {campaigns.length} campaigns</p>
              </div>
              <label className="campaigns-sort-control">
                Sort
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value as CampaignSort)}>
                  <option value="status">Status</option>
                  <option value="updated">Updated</option>
                  <option value="name">Name</option>
                </select>
              </label>
            </div>
            <div className="campaigns-table-scroll">
              <table className="campaigns-table">
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Contacts</th>
                    <th>Contacted</th>
                    <th>Converted</th>
                    <th>Conversion Rate</th>
                    <th>Activity</th>
                    <th>Owner</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((campaign) => {
                    const metrics = reportById.get(campaign.id);
                    const contacts = campaign.memberCount ?? metrics?.total ?? 0;
                    const contacted = metrics?.contacted ?? 0;
                    const converted = metrics?.converted ?? 0;
                    const conversionRate = metrics?.conversionRate ?? 0;
                    const sparkTone = conversionRate >= 15 ? "green" : conversionRate >= 8 ? "blue" : campaign.status === "PAUSED" ? "orange" : "violet";
                    return (
                      <tr key={campaign.id}>
                        <td>
                          <div className="campaigns-campaign-cell">
                            <span className={cn("campaigns-row-icon", CAMPAIGN_STATUS_TONE[campaign.status])}>
                              <Megaphone className="h-4 w-4" />
                            </span>
                            <div>
                              <Link href={`/crm/campaigns/${campaign.id}`} className="campaigns-row-title">{campaign.name}</Link>
                              <p>{campaign.description?.trim() || `Updated ${formatShortDate(campaign.updatedAt)}`}</p>
                            </div>
                          </div>
                        </td>
                        <td><span className="campaigns-type-pill">{campaignTypeLabel(campaign)}</span></td>
                        <td><CampaignStatusPill status={campaign.status} /></td>
                        <td className="campaigns-metric-cell">{formatNumber(contacts)}</td>
                        <td className="campaigns-metric-cell">{formatNumber(contacted)}</td>
                        <td className="campaigns-metric-cell">{formatNumber(converted)}</td>
                        <td>
                          <div className="campaigns-rate-cell">
                            <strong>{formatPercent(conversionRate)}</strong>
                            <span>{metrics?.callbacks ?? 0} callbacks</span>
                          </div>
                        </td>
                        <td><Sparkline seed={`${campaign.id}-${metrics?.totalAttempts ?? 0}`} tone={sparkTone} /></td>
                        <td>
                          <div className="campaigns-owner-cell">
                            <span>{campaignOwnerLabel(campaign).slice(0, 2).toUpperCase()}</span>
                            <div>
                              <strong>{campaignOwnerLabel(campaign)}</strong>
                              <small>Updated {formatShortDate(campaign.updatedAt)}</small>
                            </div>
                          </div>
                          <div className="campaigns-row-actions">
                            <Link href={`/crm/campaigns/${campaign.id}`}>Open</Link>
                            {canQueue ? <Link href={queueHref(campaign.id)}>Queue</Link> : null}
                            {isAdmin && campaign.status === "ACTIVE" ? (
                              <button type="button" onClick={(e) => handleQuickStatus(campaign.id, "PAUSED", e)}>Pause</button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <aside className="campaigns-right-rail" aria-label="Campaign insights">
            <section className="campaigns-rail-card campaigns-health-card">
              <div className="campaigns-rail-heading">
                <div>
                  <p>Campaign Health</p>
                  <h3>Portfolio mix</h3>
                </div>
                <Gauge className="h-5 w-5" />
              </div>
              <CampaignHealthDonut healthy={summary.active + summary.completed} warning={summary.paused + summary.draft} problem={summary.archived} />
              <div className="campaigns-health-legend">
                <span><i className="bg-emerald-500" />Healthy <strong>{summary.active + summary.completed}</strong></span>
                <span><i className="bg-amber-500" />Needs attention <strong>{summary.paused + summary.draft}</strong></span>
                <span><i className="bg-red-500" />Inactive <strong>{summary.archived}</strong></span>
              </div>
            </section>

            <section className="campaigns-rail-card">
              <div className="campaigns-rail-heading">
                <div>
                  <p>Top Performing Campaigns</p>
                  <h3>This portfolio</h3>
                </div>
                <TrendingUp className="h-5 w-5" />
              </div>
              <ul className="campaigns-top-list">
                {topCampaigns.map(({ campaign, metrics }, index) => {
                  const pct = Math.min(100, metrics?.conversionRate ?? 0);
                  return (
                    <li key={campaign.id}>
                      <div className="campaigns-top-row">
                        <span>{campaign.name}</span>
                        <strong>{formatPercent(metrics?.conversionRate ?? 0)}</strong>
                      </div>
                      <div className="campaigns-progress-track">
                        <div style={{ width: `${pct}%` }} className={`campaigns-progress-${index % 5}`} />
                      </div>
                    </li>
                  );
                })}
              </ul>
              <Link href="/crm/reports" className="campaigns-rail-link">View all performance</Link>
            </section>

            <section className="campaigns-rail-card">
              <div className="campaigns-rail-heading">
                <div>
                  <p>Recent Activity</p>
                  <h3>Latest campaign movement</h3>
                </div>
                <Activity className="h-5 w-5" />
              </div>
              <ul className="campaigns-activity-list">
                {recentActivity.map((campaign) => (
                  <li key={campaign.id}>
                    <span className={cn("campaigns-activity-icon", CAMPAIGN_STATUS_TONE[campaign.status])}>
                      {campaign.status === "ACTIVE" ? <Zap className="h-4 w-4" /> : campaign.status === "PAUSED" ? <Pause className="h-4 w-4" /> : campaign.status === "ARCHIVED" ? <Archive className="h-4 w-4" /> : <Clock3 className="h-4 w-4" />}
                    </span>
                    <div>
                      <strong>{campaign.name}</strong>
                      <p>{CAMPAIGN_STATUS_LABELS[campaign.status]} · updated {formatShortDate(campaign.updatedAt)}</p>
                    </div>
                  </li>
                ))}
              </ul>
              <Link href="/crm/reports" className="campaigns-rail-link">View all activity</Link>
            </section>
          </aside>
        </div>
      )}

      {!loading && !error && campaigns.length > 0 ? (
        <CampaignQuickActionStrip
          variant="index"
          canQueue={canQueue}
          isAdmin={isAdmin}
          queueWork={summary.queueWork}
          callbacks={summary.callbacks}
          onNewCampaign={() => setShowCreate(true)}
        />
      ) : null}
    </CRMPageShell>
  );
}
