"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { FileUp, ListOrdered, Megaphone, Plus, Search } from "lucide-react";
import {
  CRMPageShell,
  CRMPageHeader,
  CRMEmptyState,
  CRMActionBar,
  CRMStat,
  CampaignIndexCard,
  type CampaignListItem,
  type CampaignReportRow,
  type CampaignStatus,
} from "../../../../components/crm";
import { crm } from "../../../../components/crm/crmClasses";
import { apiGet, apiPost, apiPatch } from "../../../../services/apiClient";
import { useAppContext } from "../../../../hooks/useAppContext";
import { cn } from "../../../../components/crm/cn";

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
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
              className={cn(crm.input, "resize-none")}
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
                    "px-3 py-1.5 text-xs font-medium rounded-crm border",
                    priority === p ? "bg-crm-accent text-white border-crm-accent" : "border-crm-border text-crm-muted hover:bg-crm-surface-2",
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
      const order = (s: CampaignStatus) =>
        s === "ACTIVE" ? 0 : s === "PAUSED" ? 1 : s === "DRAFT" ? 2 : 3;
      const d = order(a.status) - order(b.status);
      if (d !== 0) return d;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [campaigns, search]);

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
    <CRMPageShell innerClassName={crm.pageInnerCampaign}>
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

      <CRMPageHeader
        icon={<Megaphone className="h-5 w-5" />}
        title="Campaigns"
        subtitle="Outbound command center — open a program, monitor queue pressure, and jump into power dialing."
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
      />

      {!loading && !error && campaigns.length > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-crm-lg border border-crm-border bg-crm-surface px-4 py-3">
          <CRMStat label="Active" value={summary.active} emphasize={summary.active > 0 ? "default" : undefined} />
          <CRMStat label="Paused" value={summary.paused} />
          <CRMStat label="Queue work (all)" value={summary.queueWork} emphasize={summary.queueWork > 0 ? "warn" : undefined} />
          <CRMStat label="Callbacks" value={summary.callbacks} emphasize={summary.callbacks > 0 ? "warn" : undefined} />
          <CRMStat label="Members" value={summary.members} />
        </div>
      )}

      <CRMActionBar>
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-crm-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={cn(crm.input, crm.inputWithIcon)}
            placeholder="Search campaigns…"
            aria-label="Search campaigns"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className={cn(crm.input, "w-auto min-w-[10rem]")}
          aria-label="Filter by status"
        >
          <option value="all">All statuses</option>
          <option value="DRAFT">Draft</option>
          <option value="ACTIVE">Active</option>
          <option value="PAUSED">Paused</option>
          <option value="COMPLETED">Completed</option>
          <option value="ARCHIVED">Archived</option>
        </select>
      </CRMActionBar>

      {loading ? (
        <p className="py-16 text-center text-sm text-crm-muted">Loading campaigns…</p>
      ) : error ? (
        <p className="py-16 text-center text-sm text-crm-danger">{error}</p>
      ) : listEmptyNoCampaigns ? (
        <CRMEmptyState
          icon={<Megaphone className="h-10 w-10" />}
          title="No campaigns yet"
          description="Create a campaign to group leads and scripts, then route work through My Queue or import leads first."
          action={
            <div className="flex flex-wrap justify-center gap-2">
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
            </div>
          }
        />
      ) : listEmptyAfterFilter ? (
        <CRMEmptyState
          title="No campaigns match"
          description="Try another name or clear the search."
          action={
            <button type="button" onClick={() => setSearch("")} className={crm.btnSecondary}>
              Clear search
            </button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {filtered.map((campaign) => (
            <li key={campaign.id}>
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
    </CRMPageShell>
  );
}
