"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { FileUp, ListOrdered, Megaphone, Plus, Search } from "lucide-react";
import {
  CRMPageShell,
  CRMActionBar,
  CampaignIndexCard,
  CampaignIndexCommandHero,
  CampaignQuickActionStrip,
  CampaignGuidedEmpty,
  type CampaignListItem,
  type CampaignReportRow,
  type CampaignStatus,
} from "../../../../components/crm";
import { crm } from "../../../../components/crm/crmClasses";
import { apiGet, apiPost, apiPatch } from "../../../../services/apiClient";
import { useAppContext } from "../../../../hooks/useAppContext";
import { cn } from "../../../../components/crm/cn";
import { CAMPAIGN_STATUS_LABELS } from "../../../../components/crm/campaign/campaignTypes";

const STATUS_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All" },
  { value: "ACTIVE", label: CAMPAIGN_STATUS_LABELS.ACTIVE },
  { value: "PAUSED", label: CAMPAIGN_STATUS_LABELS.PAUSED },
  { value: "DRAFT", label: CAMPAIGN_STATUS_LABELS.DRAFT },
  { value: "COMPLETED", label: CAMPAIGN_STATUS_LABELS.COMPLETED },
  { value: "ARCHIVED", label: CAMPAIGN_STATUS_LABELS.ARCHIVED },
];

type CampaignSort = "status" | "updated" | "name";

function CreateCampaignModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (c: CampaignListItem) => void;
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
        <h2 className="text-lg font-semibold text-crm-text mb-4">New campaign</h2>
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
              {saving ? "Creating…" : "Create"}
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
    backendJwtRole === "SUPER_ADMIN";

  const canImport = can("can_view_crm_import");
  const canQueue = can("can_view_crm_queue");

  const [campaigns, setCampaigns] = useState<CampaignListItem[]>([]);
  const [reportById, setReportById] = useState<Map<string, CampaignReportRow>>(new Map());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortBy, setSortBy] = useState<CampaignSort>("status");
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState("");

  const token = typeof window !== "undefined" ? localStorage.getItem("token") ?? undefined : undefined;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = statusFilter !== "all" ? `?status=${statusFilter}` : "";
      const [listRes, reportRes] = await Promise.all([
        apiGet<{ campaigns: CampaignListItem[] }>(`/crm/campaigns${params}`, token),
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = campaigns;
    if (q) list = list.filter((c) => c.name.toLowerCase().includes(q));
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
  }, [campaigns, search, sortBy]);

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
    let queueWork = 0;
    let callbacks = 0;
    let members = 0;
    for (const c of campaigns) {
      members += c.memberCount ?? 0;
      if (c.status === "ACTIVE") active += 1;
      if (c.status === "PAUSED") paused += 1;
      const m = reportById.get(c.id);
      if (m) {
        queueWork += m.pending;
        callbacks += m.callbacks;
      }
    }
    return { active, paused, queueWork, callbacks, members };
  }, [campaigns, reportById]);

  const listEmptyNoCampaigns = !loading && !error && campaigns.length === 0;
  const listEmptyAfterFilter = !loading && !error && campaigns.length > 0 && filtered.length === 0;

  return (
    <CRMPageShell innerClassName={cn(crm.pageInnerCampaign, crm.campaignWorkspace, "pb-32")}>
      {showCreate && isAdmin && (
        <CreateCampaignModal
          onClose={() => setShowCreate(false)}
          onCreate={(c) => {
            setCampaigns((prev) => [{ ...c, memberCount: c.memberCount ?? 0 }, ...prev]);
            setShowCreate(false);
            router.push(`/crm/campaigns/${c.id}`);
          }}
        />
      )}

      <CampaignIndexCommandHero
        title="Campaigns"
        subtitle="Live outbound programs — scan queue pressure, open a desk, and jump into power dialing."
        actions={
          <>
            {isAdmin && (
              <button type="button" onClick={() => setShowCreate(true)} className={crm.btnPrimary}>
                <Plus className="h-4 w-4" />
                New campaign
              </button>
            )}
            {canImport && (
              <Link href="/crm/import" className={crm.btnSecondary}>
                <FileUp className="h-4 w-4" />
                Import leads
              </Link>
            )}
            {canQueue && (
              <Link href="/crm/queue" className={crm.btnSecondary}>
                <ListOrdered className="h-4 w-4" />
                My queue
              </Link>
            )}
          </>
        }
        kpis={
          loading || error || campaigns.length === 0
            ? []
            : [
                { label: "Active", value: summary.active, tone: summary.active > 0 ? "accent" : "default" },
                { label: "Paused", value: summary.paused },
                { label: "Queue work", value: summary.queueWork, tone: summary.queueWork > 0 ? "warn" : "default" },
                { label: "Callbacks", value: summary.callbacks, tone: summary.callbacks > 0 ? "warn" : "default" },
                { label: "Members", value: summary.members },
              ]
        }
      />

      <div className={crm.campaignCommandSticky}>
        <CRMActionBar className={cn(crm.campaignFilterBar, "gap-2 sm:gap-3 flex-wrap")}>
          <div className="relative min-w-[10rem] flex-1 max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-crm-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={crm.campaignSearchInput}
              placeholder="Search campaigns…"
              aria-label="Search campaigns"
            />
          </div>
          <div className={cn(crm.filterPillGroup, "shrink-0")} role="group" aria-label="Filter by status">
            {STATUS_FILTER_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setStatusFilter(opt.value)}
                className={cn(crm.filterPill, statusFilter === opt.value && crm.filterPillActive)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <label className="ml-auto flex shrink-0 items-center gap-2 text-[11px] font-medium text-crm-muted">
            Sort
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as CampaignSort)}
              className={crm.campaignSortSelect}
              aria-label="Sort campaigns"
            >
              <option value="status">Status</option>
              <option value="updated">Updated</option>
              <option value="name">Name</option>
            </select>
          </label>
        </CRMActionBar>
      </div>

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
              {canImport && (
                <Link href="/crm/import" className={crm.btnSecondary}>
                  <FileUp className="h-4 w-4" /> Import leads
                </Link>
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
        <ul className={crm.campaignIndexRowList}>
          {filtered.map((campaign) => (
            <li key={campaign.id} className="list-none">
              <CampaignIndexCard
                campaign={campaign}
                metrics={reportById.get(campaign.id)}
                canQueue={canQueue}
                isAdmin={isAdmin}
                onQuickStatus={handleQuickStatus}
              />
            </li>
          ))}
        </ul>
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
