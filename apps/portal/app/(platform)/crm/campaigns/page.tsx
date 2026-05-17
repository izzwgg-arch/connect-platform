"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Megaphone,
  Plus,
  Search,
  Play,
  Pause,
  Archive,
  Users,
  FileUp,
  ListOrdered,
  ExternalLink,
} from "lucide-react";
import { CRMPageShell } from "../../../../components/crm";
import { apiGet, apiPost, apiPatch } from "../../../../services/apiClient";
import { useAppContext } from "../../../../hooks/useAppContext";

// ── Types ──────────────────────────────────────────────────────────────────────

type CampaignStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "COMPLETED" | "ARCHIVED";
type CampaignPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";

type Campaign = {
  id: string;
  name: string;
  description: string | null;
  status: CampaignStatus;
  priority: CampaignPriority;
  scriptId: string | null;
  checklistId: string | null;
  createdAt: string;
  updatedAt: string;
  script: { id: string; name: string } | null;
  checklist: { id: string; name: string } | null;
  /** Present on list/detail with counts; create response may omit. */
  memberCount?: number;
};

// ── Constants ──────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<CampaignStatus, string> = {
  DRAFT: "Draft",
  ACTIVE: "Active",
  PAUSED: "Paused",
  COMPLETED: "Completed",
  ARCHIVED: "Archived",
};

const STATUS_COLORS: Record<CampaignStatus, string> = {
  DRAFT: "bg-crm-surface-2 text-crm-muted",
  ACTIVE: "bg-green-100 text-green-700",
  PAUSED: "bg-yellow-100 text-crm-warning",
  COMPLETED: "bg-blue-100 text-crm-accent",
  ARCHIVED: "bg-crm-surface-2 text-crm-muted/80",
};

const PRIORITY_LABELS: Record<CampaignPriority, string> = {
  LOW: "Low", NORMAL: "Normal", HIGH: "High", URGENT: "Urgent",
};

const PRIORITY_COLORS: Record<CampaignPriority, string> = {
  LOW: "bg-crm-surface-2 text-crm-muted",
  NORMAL: "", // not shown — normal is the baseline
  HIGH: "bg-orange-100 text-orange-700",
  URGENT: "bg-red-100 text-crm-danger",
};

// ── Components ─────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: CampaignStatus }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: CampaignPriority }) {
  if (priority === "NORMAL") return null;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${PRIORITY_COLORS[priority]}`}>
      {PRIORITY_LABELS[priority]}
    </span>
  );
}

function formatShortDate(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

// ── Create Campaign Modal ──────────────────────────────────────────────────────

function CreateCampaignModal({ onClose, onCreate }: { onClose: () => void; onCreate: (c: Campaign) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<CampaignPriority>("NORMAL");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError("");
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("token") ?? undefined : undefined;
      const res = await apiPost<{ campaign: Campaign }>("/crm/campaigns", {
        name: name.trim(),
        description: description.trim() || undefined,
        priority,
      }, token);
      onCreate(res.campaign);
    } catch (err: any) {
      setError(err?.message ?? "Failed to create campaign");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-crm-surface rounded-crm border border-crm-border shadow-xl p-6 w-full max-w-md">
        <h2 className="text-lg font-semibold text-crm-text mb-4">New Campaign</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-crm-text mb-1">Campaign Name</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border border-crm-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-crm-accent/30"
              placeholder="e.g. Q3 Outbound"
              maxLength={200}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-crm-text mb-1">Description <span className="text-crm-muted/80">(optional)</span></label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full border border-crm-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-crm-accent/30 resize-none"
              rows={3}
              placeholder="What is this campaign about?"
              maxLength={2000}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-crm-text mb-1">Smart Queue Priority</label>
            <div className="flex gap-2 flex-wrap">
              {(["NORMAL", "HIGH", "URGENT"] as CampaignPriority[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority(p)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                    priority === p
                      ? p === "URGENT"
                        ? "bg-red-600 text-white border-red-600"
                        : p === "HIGH"
                          ? "bg-orange-500 text-white border-orange-500"
                          : "bg-crm-accent text-white border-blue-600"
                      : "border-crm-border text-crm-muted hover:bg-crm-bg"
                  }`}
                >
                  {PRIORITY_LABELS[p]}
                </button>
              ))}
            </div>
            <p className="text-xs text-crm-muted/80 mt-1">
              {priority === "URGENT"
                ? "Leads in this campaign surface above all others in Smart Queue."
                : priority === "HIGH"
                  ? "Leads in this campaign rank above Normal campaigns in Smart Queue."
                  : "Default ranking in Smart Queue."}
            </p>
          </div>
          {error && <p className="text-sm text-crm-danger">{error}</p>}
          <div className="flex gap-2 justify-end pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm border border-crm-border rounded-lg text-crm-text hover:bg-crm-bg">Cancel</button>
            <button type="submit" disabled={saving || !name.trim()} className="px-4 py-2 text-sm bg-crm-accent text-white rounded-lg hover:brightness-110 disabled:opacity-50">
              {saving ? "Creating..." : "Create Campaign"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function CampaignsPage() {
  const router = useRouter();
  const { backendJwtRole, can } = useAppContext();

  const isAdmin =
    backendJwtRole === "ADMIN" ||
    backendJwtRole === "TENANT_ADMIN" ||
    backendJwtRole === "SUPER_ADMIN";

  const canImport = can("can_view_crm_import");
  const canQueue = can("can_view_crm_queue");

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState("");

  const token = typeof window !== "undefined" ? localStorage.getItem("token") ?? undefined : undefined;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = statusFilter !== "all" ? `?status=${statusFilter}` : "";
      const res = await apiGet<{ campaigns: Campaign[] }>(`/crm/campaigns${params}`, token);
      setCampaigns(res.campaigns);
    } catch (err: any) {
      setError(err?.message ?? "Failed to load campaigns");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, token]);

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

  const filtered = campaigns.filter((c) => {
    if (!search) return true;
    return c.name.toLowerCase().includes(search.toLowerCase());
  });

  const summary = useMemo(() => {
    let active = 0;
    let paused = 0;
    let completed = 0;
    let draft = 0;
    let archived = 0;
    let members = 0;
    for (const c of campaigns) {
      members += c.memberCount ?? 0;
      switch (c.status) {
        case "ACTIVE":
          active += 1;
          break;
        case "PAUSED":
          paused += 1;
          break;
        case "COMPLETED":
          completed += 1;
          break;
        case "DRAFT":
          draft += 1;
          break;
        case "ARCHIVED":
          archived += 1;
          break;
        default:
          break;
      }
    }
    return { active, paused, completed, draft, archived, members };
  }, [campaigns]);

  const listEmptyAfterFilter = !loading && !error && campaigns.length > 0 && filtered.length === 0;
  const listEmptyNoCampaigns = !loading && !error && campaigns.length === 0;

  return (
    <CRMPageShell>
      {showCreate && isAdmin && (
        <CreateCampaignModal
          onClose={() => setShowCreate(false)}
          onCreate={(c) => {
            const normalized: Campaign = { ...c, memberCount: c.memberCount ?? 0 };
            setCampaigns((prev) => [normalized, ...prev]);
            setShowCreate(false);
            router.push(`/crm/campaigns/${c.id}`);
          }}
        />
      )}

        {/* Command header */}
        <div className="rounded-crm-lg border border-crm-border bg-crm-surface p-6 shadow-crm mb-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex gap-3 min-w-0">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-crm bg-crm-accent/15 text-crm-accent">
                <Megaphone className="h-5 w-5" aria-hidden />
              </div>
              <div className="min-w-0">
                <h1 className="text-2xl font-semibold tracking-tight text-crm-text">Campaigns</h1>
                <p className="mt-1 text-sm text-crm-muted max-w-xl">
                  Run outbound work by campaign: open a program, pull its queue in My Queue, or adjust lifecycle status from the campaign record.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setShowCreate(true)}
                  className="inline-flex items-center gap-2 rounded-lg bg-crm-accent px-4 py-2 text-sm font-medium text-white hover:brightness-110"
                >
                  <Plus className="h-4 w-4" />
                  New campaign
                </button>
              )}
              {canImport && (
                <Link
                  href="/crm/import"
                  className="inline-flex items-center gap-2 rounded-lg border border-crm-border bg-crm-surface px-3 py-2 text-sm font-medium text-crm-text hover:bg-crm-bg"
                >
                  <FileUp className="h-4 w-4 text-crm-muted" />
                  Import leads
                </Link>
              )}
              {canQueue && (
                <Link
                  href="/crm/queue"
                  className="inline-flex items-center gap-2 rounded-lg border border-crm-border bg-crm-surface px-3 py-2 text-sm font-medium text-crm-text hover:bg-crm-bg"
                >
                  <ListOrdered className="h-4 w-4 text-crm-muted" />
                  My Queue
                </Link>
              )}
            </div>
          </div>
        </div>

        {/* Summary: counts from this GET /crm/campaigns payload only */}
        {!loading && !error && campaigns.length > 0 && (
          <div className="mb-6">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {(
                [
                  { key: "active", label: "Active", value: summary.active },
                  { key: "paused", label: "Paused", value: summary.paused },
                  { key: "completed", label: "Completed", value: summary.completed },
                  { key: "draft", label: "Draft", value: summary.draft },
                  { key: "archived", label: "Archived", value: summary.archived },
                  { key: "members", label: "Members (this list)", value: summary.members },
                ] as const
              ).map((tile) => (
                <div
                  key={tile.key}
                  className="rounded-crm border border-crm-border bg-crm-surface px-4 py-3 shadow-crm"
                >
                  <p className="text-xs font-medium uppercase tracking-wide text-crm-muted">{tile.label}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-crm-text">{tile.value}</p>
                </div>
              ))}
            </div>
            {statusFilter === "all" && (
              <p className="mt-2 text-xs text-crm-muted">
                <span className="font-medium text-crm-muted">All statuses</span> excludes archived campaigns. Choose{" "}
                <span className="font-medium text-crm-text">Archived</span> in the filter to load them.
              </p>
            )}
            {statusFilter !== "all" && (
              <p className="mt-2 text-xs text-crm-muted">
                Figures reflect the campaigns returned for the current status filter (and search only hides rows below).
              </p>
            )}
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3 mb-5">
          <div className="relative flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-crm-muted/80" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-lg border border-crm-border py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-crm-accent/30"
              placeholder="Search by name…"
              aria-label="Search campaigns by name"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border border-crm-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-crm-accent/30 sm:w-auto w-full"
            aria-label="Filter by status"
          >
            <option value="all">All statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="ACTIVE">Active</option>
            <option value="PAUSED">Paused</option>
            <option value="COMPLETED">Completed</option>
            <option value="ARCHIVED">Archived</option>
          </select>
        </div>

        {/* Content */}
        {loading ? (
          <div className="py-20 text-center text-crm-muted/80 text-sm">Loading campaigns…</div>
        ) : error ? (
          <div className="py-20 text-center text-red-500 text-sm">{error}</div>
        ) : listEmptyNoCampaigns ? (
          <div className="rounded-crm-lg border border-dashed border-crm-border bg-crm-surface px-6 py-16 text-center">
            <Megaphone className="mx-auto mb-3 h-10 w-10 text-crm-border" aria-hidden />
            <p className="text-base font-medium text-crm-text">No campaigns yet</p>
            <p className="mx-auto mt-2 max-w-md text-sm text-crm-muted">
              Create a campaign to group leads and scripts, then route work through My Queue. If leads arrive via file import, start from Import Leads and attach them to a campaign from there.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setShowCreate(true)}
                  className="inline-flex items-center gap-2 rounded-lg bg-crm-accent px-4 py-2 text-sm font-medium text-white hover:brightness-110"
                >
                  <Plus className="h-4 w-4" />
                  New campaign
                </button>
              )}
              {canImport && (
                <Link
                  href="/crm/import"
                  className="inline-flex items-center gap-2 rounded-lg border border-crm-border bg-crm-surface px-4 py-2 text-sm font-medium text-crm-text hover:bg-crm-bg"
                >
                  <FileUp className="h-4 w-4 text-crm-muted" />
                  Import leads
                </Link>
              )}
            </div>
            {!isAdmin && !canImport && (
              <p className="mt-4 text-xs text-crm-muted">Ask a CRM admin to create a campaign or grant import access if you need to load leads.</p>
            )}
          </div>
        ) : listEmptyAfterFilter ? (
          <div className="rounded-crm-lg border border-crm-border bg-crm-surface px-6 py-14 text-center">
            <p className="text-base font-medium text-crm-text">No campaigns match this search</p>
            <p className="mt-2 text-sm text-crm-muted">Try another name or clear the search to see all loaded campaigns.</p>
            <button
              type="button"
              onClick={() => setSearch("")}
              className="mt-5 rounded-lg border border-crm-border bg-crm-surface px-4 py-2 text-sm font-medium text-crm-text hover:bg-crm-bg"
            >
              Clear search
            </button>
          </div>
        ) : (
          <ul className="space-y-3">
            {filtered.map((campaign) => {
              const members = campaign.memberCount ?? 0;
              return (
                <li
                  key={campaign.id}
                  className="rounded-crm-lg border border-crm-border bg-crm-surface p-4 shadow-crm transition-colors hover:border-crm-border"
                >
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate text-base font-semibold text-crm-text">{campaign.name}</h2>
                        <StatusBadge status={campaign.status} />
                        <PriorityBadge priority={campaign.priority ?? "NORMAL"} />
                      </div>
                      {campaign.description ? (
                        <p className="text-sm text-crm-muted line-clamp-2">{campaign.description}</p>
                      ) : null}
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-crm-muted">
                        <span className="inline-flex items-center gap-1">
                          <Users className="h-3.5 w-3.5 shrink-0" aria-hidden />
                          {members} member{members === 1 ? "" : "s"}
                        </span>
                        <span>Updated {formatShortDate(campaign.updatedAt)}</span>
                        <span className="text-crm-muted/80">Created {formatShortDate(campaign.createdAt)}</span>
                      </div>
                      {(campaign.script || campaign.checklist) && (
                        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-crm-muted">
                          {campaign.script && <span>Script: {campaign.script.name}</span>}
                          {campaign.checklist && <span>Checklist: {campaign.checklist.name}</span>}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center lg:justify-end lg:pl-4 shrink-0">
                      <Link
                        href={`/crm/campaigns/${campaign.id}`}
                        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-crm-border bg-crm-surface px-3 py-2 text-sm font-medium text-crm-text hover:bg-crm-bg"
                      >
                        Open campaign
                        <ExternalLink className="h-3.5 w-3.5 text-crm-muted/80" aria-hidden />
                      </Link>
                      {canQueue && (
                        <Link
                          href={`/crm/queue?campaignId=${encodeURIComponent(campaign.id)}`}
                          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-crm-border bg-crm-surface px-3 py-2 text-sm font-medium text-crm-text hover:bg-crm-bg"
                        >
                          View queue
                          <ListOrdered className="h-3.5 w-3.5 text-crm-muted/80" aria-hidden />
                        </Link>
                      )}
                      {isAdmin && campaign.status === "DRAFT" && (
                        <button
                          type="button"
                          onClick={(e) => handleQuickStatus(campaign.id, "ACTIVE", e)}
                          className="inline-flex items-center justify-center gap-1 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm font-medium text-green-800 hover:bg-green-100"
                          title="Start campaign"
                        >
                          <Play className="h-3.5 w-3.5" />
                          Start
                        </button>
                      )}
                      {isAdmin && campaign.status === "ACTIVE" && (
                        <button
                          type="button"
                          onClick={(e) => handleQuickStatus(campaign.id, "PAUSED", e)}
                          className="inline-flex items-center justify-center gap-1 rounded-lg border border-crm-warning/35 bg-amber-50 px-3 py-2 text-sm font-medium text-crm-warning hover:bg-crm-warning/15"
                          title="Pause campaign"
                        >
                          <Pause className="h-3.5 w-3.5" />
                          Pause
                        </button>
                      )}
                      {isAdmin && campaign.status === "PAUSED" && (
                        <button
                          type="button"
                          onClick={(e) => handleQuickStatus(campaign.id, "ACTIVE", e)}
                          className="inline-flex items-center justify-center gap-1 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm font-medium text-green-800 hover:bg-green-100"
                          title="Resume campaign"
                        >
                          <Play className="h-3.5 w-3.5" />
                          Resume
                        </button>
                      )}
                      {isAdmin && (campaign.status === "ACTIVE" || campaign.status === "PAUSED") && (
                        <button
                          type="button"
                          onClick={(e) => handleQuickStatus(campaign.id, "ARCHIVED", e)}
                          className="inline-flex items-center justify-center rounded-lg p-2 text-crm-muted hover:bg-crm-surface-2 hover:text-crm-text"
                          title="Archive campaign"
                          aria-label="Archive campaign"
                        >
                          <Archive className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
    </CRMPageShell>
  );
}
