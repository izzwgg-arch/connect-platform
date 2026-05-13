"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Megaphone, Plus, Search, ChevronRight, Play, Pause, Archive, Users } from "lucide-react";
import { apiGet, apiPost, apiPatch } from "../../../../services/apiClient";

// ── Types ──────────────────────────────────────────────────────────────────────

type CampaignStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "COMPLETED" | "ARCHIVED";

type Campaign = {
  id: string;
  name: string;
  description: string | null;
  status: CampaignStatus;
  scriptId: string | null;
  checklistId: string | null;
  createdAt: string;
  updatedAt: string;
  script: { id: string; name: string } | null;
  checklist: { id: string; name: string } | null;
  memberCount: number;
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
  DRAFT: "bg-gray-100 text-gray-600",
  ACTIVE: "bg-green-100 text-green-700",
  PAUSED: "bg-yellow-100 text-yellow-700",
  COMPLETED: "bg-blue-100 text-blue-700",
  ARCHIVED: "bg-gray-100 text-gray-400",
};

// ── Components ─────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: CampaignStatus }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

// ── Create Campaign Modal ──────────────────────────────────────────────────────

function CreateCampaignModal({ onClose, onCreate }: { onClose: () => void; onCreate: (c: Campaign) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError("");
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("token") ?? undefined : undefined;
      const res = await apiPost<{ campaign: Campaign }>("/crm/campaigns", { name: name.trim(), description: description.trim() || undefined }, token);
      onCreate(res.campaign);
    } catch (err: any) {
      setError(err?.message ?? "Failed to create campaign");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">New Campaign</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Campaign Name</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g. Q3 Outbound"
              maxLength={200}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description <span className="text-gray-400">(optional)</span></label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              rows={3}
              placeholder="What is this campaign about?"
              maxLength={2000}
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2 justify-end pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={saving || !name.trim()} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
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

  useEffect(() => { load(); }, [load]);

  async function handleQuickStatus(id: string, status: CampaignStatus, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await apiPatch(`/crm/campaigns/${id}`, { status }, token);
      setCampaigns((prev) => prev.map((c) => (c.id === id ? { ...c, status } : c)));
    } catch {}
  }

  const filtered = campaigns.filter((c) => {
    if (!search) return true;
    return c.name.toLowerCase().includes(search.toLowerCase());
  });

  return (
    <div className="min-h-screen bg-gray-50">
      {showCreate && (
        <CreateCampaignModal
          onClose={() => setShowCreate(false)}
          onCreate={(c) => {
            setCampaigns((prev) => [c, ...prev]);
            setShowCreate(false);
            router.push(`/crm/campaigns/${c.id}`);
          }}
        />
      )}

      <div className="max-w-5xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Megaphone className="h-6 w-6 text-blue-600" />
            <h1 className="text-2xl font-bold text-gray-900">Campaigns</h1>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            New Campaign
          </button>
        </div>

        {/* Filters */}
        <div className="flex gap-3 mb-5">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Search campaigns..."
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
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
          <div className="py-20 text-center text-gray-400 text-sm">Loading campaigns...</div>
        ) : error ? (
          <div className="py-20 text-center text-red-500 text-sm">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="py-20 text-center">
            <Megaphone className="h-10 w-10 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-600 font-semibold text-base">Create your first campaign</p>
            <p className="text-gray-400 text-sm mt-1">Organize leads into campaigns and assign agents to work them.</p>
            <button onClick={() => setShowCreate(true)} className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
              New Campaign
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((campaign) => (
              <div
                key={campaign.id}
                onClick={() => router.push(`/crm/campaigns/${campaign.id}`)}
                className="bg-white border border-gray-200 rounded-xl p-4 hover:border-blue-300 hover:shadow-sm cursor-pointer transition-all"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    <StatusBadge status={campaign.status} />
                    <span className="font-medium text-gray-900 truncate">{campaign.name}</span>
                    {campaign.description && (
                      <span className="text-sm text-gray-400 hidden sm:block truncate max-w-xs">{campaign.description}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 ml-3 shrink-0">
                    <div className="flex items-center gap-1 text-xs text-gray-500">
                      <Users className="h-3.5 w-3.5" />
                      <span>{campaign.memberCount}</span>
                    </div>
                    {campaign.status === "DRAFT" && (
                      <button
                        onClick={(e) => handleQuickStatus(campaign.id, "ACTIVE", e)}
                        className="flex items-center gap-1 px-2 py-1 bg-green-50 text-green-700 border border-green-200 rounded text-xs hover:bg-green-100"
                        title="Start campaign"
                      >
                        <Play className="h-3 w-3" />
                        Start
                      </button>
                    )}
                    {campaign.status === "ACTIVE" && (
                      <button
                        onClick={(e) => handleQuickStatus(campaign.id, "PAUSED", e)}
                        className="flex items-center gap-1 px-2 py-1 bg-yellow-50 text-yellow-700 border border-yellow-200 rounded text-xs hover:bg-yellow-100"
                        title="Pause campaign"
                      >
                        <Pause className="h-3 w-3" />
                        Pause
                      </button>
                    )}
                    {campaign.status === "PAUSED" && (
                      <button
                        onClick={(e) => handleQuickStatus(campaign.id, "ACTIVE", e)}
                        className="flex items-center gap-1 px-2 py-1 bg-green-50 text-green-700 border border-green-200 rounded text-xs hover:bg-green-100"
                        title="Resume campaign"
                      >
                        <Play className="h-3 w-3" />
                        Resume
                      </button>
                    )}
                    {(campaign.status === "ACTIVE" || campaign.status === "PAUSED") && (
                      <button
                        onClick={(e) => handleQuickStatus(campaign.id, "ARCHIVED", e)}
                        className="p-1 text-gray-400 hover:text-gray-600 rounded"
                        title="Archive campaign"
                      >
                        <Archive className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <ChevronRight className="h-4 w-4 text-gray-400" />
                  </div>
                </div>
                {(campaign.script || campaign.checklist) && (
                  <div className="mt-2 flex gap-3 text-xs text-gray-500">
                    {campaign.script && <span>Script: {campaign.script.name}</span>}
                    {campaign.checklist && <span>Checklist: {campaign.checklist.name}</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
