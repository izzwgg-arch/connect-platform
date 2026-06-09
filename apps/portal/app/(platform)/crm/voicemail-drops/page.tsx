"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Archive,
  BarChart3,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileAudio,
  FileText,
  Headphones,
  Loader2,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  Timer,
  TrendingUp,
  Upload,
  Voicemail,
  X,
} from "lucide-react";
import { CRMActionBar, CRMPageHeader, CRMPageShell, cn, crm } from "../../../../components/crm";
import { ConnectSelect } from "../../../../components/ConnectSelect";
import {
  CRMWorkspaceShell,
  CRMWorkspaceChrome,
  CRMWorkspaceHeader,
  CRMWorkspaceToolbar,
  CRMWorkspaceBody,
  CRMWorkspaceMain,
  CRMWorkspaceRightRail,
  CRMWorkspaceScrollRegion,
} from "../../../../components/crm/CRMWorkspaceShell";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet, apiPatch, apiUploadCrmVoicemailDrop } from "../../../../services/apiClient";

export type CrmVoicemailDrop = {
  id: string;
  name: string;
  description?: string | null;
  status: "READY" | "PROCESSING" | "FAILED" | "ARCHIVED";
  durationSeconds?: number | null;
  originalFileName?: string | null;
  originalMimeType?: string | null;
  campaign?: { id: string; name: string } | null;
  isDefault: boolean;
  usageCount: number;
  conversionStatus: string;
  conversionError?: string | null;
  pbxFormat?: string | null;
  streamUrl?: string | null;
  createdAt?: string;
  lastUsedAt?: string | null;
  updatedAt: string;
};

type DropsResponse = {
  voicemailDrops: CrmVoicemailDrop[];
  stats: {
    totalRecordings: number;
    totalDurationSeconds: number;
    dropSuccessRate: number;
  };
};

const DEV_ROW_PREVIEW_COUNT = 18;

const DEV_PREVIEW_DROPS: CrmVoicemailDrop[] = Array.from({ length: 6 }, (_, index) => {
  const statuses: CrmVoicemailDrop["status"][] = ["READY", "READY", "PROCESSING", "READY", "FAILED", "ARCHIVED"];
  const names = ["Jordan intro drop", "Demo follow-up", "Pricing callback", "After-hours note", "Missed call recovery", "Archived winter script"];
  const createdAt = new Date(Date.now() - (index + 2) * 86400000).toISOString();
  return {
    id: `dev-preview-voicemail-${index + 1}`,
    name: names[index] ?? `Preview voicemail ${index + 1}`,
    description: "Preview-only voicemail row for local visual QA.",
    status: statuses[index] ?? "READY",
    durationSeconds: 18 + index * 4,
    originalFileName: `connect-demo-${index + 1}.mp3`,
    originalMimeType: "audio/mpeg",
    campaign: { id: `dev-preview-campaign-${index + 1}`, name: index % 2 === 0 ? "Connect Demo Co LLC" : "Lead follow-up" },
    isDefault: index === 0,
    usageCount: index === 0 ? 18 : index * 3,
    conversionStatus: statuses[index] === "FAILED" ? "FAILED" : "READY",
    conversionError: statuses[index] === "FAILED" ? "Audio conversion needs review." : null,
    pbxFormat: "wav/8khz",
    streamUrl: null,
    createdAt,
    lastUsedAt: index < 3 ? new Date(Date.now() - (index + 1) * 43200000).toISOString() : null,
    updatedAt: new Date(Date.now() - index * 3600000).toISOString(),
  };
});

function expandRowsForDevPreview<T>(rows: T[], minRows = DEV_ROW_PREVIEW_COUNT): T[] {
  if (process.env.NODE_ENV !== "development") return rows;
  if (rows.length === 0 || rows.length >= minRows) return rows;
  return Array.from({ length: minRows }, (_, index) => rows[index % rows.length]);
}

function fmtDuration(total: number | null | undefined): string {
  const sec = Math.max(0, Number(total || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `0:${String(s).padStart(2, "0")}`;
}

function timeAgo(value: string): string {
  const ms = Date.now() - new Date(value).getTime();
  const days = Math.max(0, Math.floor(ms / 86400000));
  if (days === 0) return "Updated today";
  if (days === 1) return "Updated 1d ago";
  if (days < 30) return `Updated ${days}d ago`;
  return new Date(value).toLocaleDateString();
}

function authToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
}

function withToken(url: string | null | undefined): string {
  if (!url) return "";
  const token = authToken();
  if (!token) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function fmtFileSize(bytes: number | null | undefined): string {
  const size = Number(bytes || 0);
  if (!size) return "";
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function statusTone(status: CrmVoicemailDrop["status"]) {
  if (status === "READY") return "success";
  if (status === "FAILED") return "danger";
  if (status === "PROCESSING") return "warning";
  return "muted";
}

function statusPillClass(status: CrmVoicemailDrop["status"]) {
  const tone = statusTone(status);
  if (tone === "success") return "tasks-status-completed";
  if (tone === "warning") return "tasks-status-today";
  if (tone === "danger") return "tasks-status-overdue";
  return "tasks-status-muted";
}

function statusColor(status: CrmVoicemailDrop["status"]) {
  if (status === "READY") return "#6366f1";
  if (status === "PROCESSING") return "#f59e0b";
  if (status === "FAILED") return "#ef4444";
  return "#64748b";
}

function initialsFromName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "VD";
}

function readiness(drop: CrmVoicemailDrop | null) {
  if (!drop) {
    return { label: "No drop selected", detail: "Select a row to review setup readiness.", percent: 0, tone: "muted" as const };
  }
  if (drop.status === "ARCHIVED") {
    return { label: "Archived", detail: "Hidden from active voicemail workflows.", percent: 0, tone: "muted" as const };
  }
  if (drop.status === "FAILED") {
    return { label: "Needs attention", detail: drop.conversionError || "Audio conversion failed.", percent: 18, tone: "danger" as const };
  }
  if (drop.status === "PROCESSING") {
    return { label: "Processing", detail: "Audio is being converted to PBX-safe format.", percent: 58, tone: "warning" as const };
  }
  if (!drop.streamUrl) {
    return { label: "Missing audio", detail: "Ready status exists, but no stream URL is available.", percent: 72, tone: "warning" as const };
  }
  return { label: "Ready to drop", detail: "Audio is available and PBX-safe for live calls.", percent: 100, tone: "success" as const };
}

function progressToneClass(tone: ReturnType<typeof readiness>["tone"]) {
  if (tone === "success") return "bg-crm-success text-crm-success border-crm-success/35 bg-crm-success/8";
  if (tone === "warning") return "bg-crm-warning text-crm-warning border-crm-warning/35 bg-crm-warning/8";
  if (tone === "danger") return "bg-crm-danger text-crm-danger border-crm-danger/35 bg-crm-danger/8";
  return "bg-crm-muted text-crm-muted border-crm-border/45 bg-crm-surface/55";
}

export default function CrmVoicemailDropsPage() {
  const [drops, setDrops] = useState<CrmVoicemailDrop[]>([]);
  const [stats, setStats] = useState<DropsResponse["stats"]>({ totalRecordings: 0, totalDurationSeconds: 0, dropSuccessRate: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [creating, setCreating] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  async function loadDrops() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<DropsResponse>("/crm/voicemail-drops?includeArchived=true");
      setDrops(res.voicemailDrops ?? []);
      setStats(res.stats ?? { totalRecordings: 0, totalDurationSeconds: 0, dropSuccessRate: 0 });
    } catch (err: any) {
      setError(err?.message || "Failed to load voicemail drops");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDrops();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return drops.filter((drop) => {
      if (statusFilter !== "all" && drop.status !== statusFilter) return false;
      if (!q) return true;
      return `${drop.name} ${drop.description || ""} ${drop.campaign?.name || ""}`.toLowerCase().includes(q);
    });
  }, [drops, search, statusFilter]);

  const usingDevPreview =
    process.env.NODE_ENV === "development" &&
    drops.length === 0 &&
    filtered.length === 0 &&
    search.trim() === "" &&
    statusFilter === "all";
  const visibleRows = usingDevPreview ? DEV_PREVIEW_DROPS : filtered;
  const previewRows = useMemo(() => expandRowsForDevPreview(visibleRows), [visibleRows]);
  const metricDrops = usingDevPreview ? DEV_PREVIEW_DROPS : drops;
  const metricStats = useMemo(() => {
    if (!usingDevPreview) return stats;
    const ready = metricDrops.filter((drop) => drop.status === "READY").length;
    return {
      totalRecordings: metricDrops.length,
      totalDurationSeconds: metricDrops.reduce((sum, drop) => sum + (drop.durationSeconds || 0), 0),
      dropSuccessRate: metricDrops.length ? Math.round((ready / metricDrops.length) * 100) : 0,
    };
  }, [metricDrops, stats, usingDevPreview]);

  useEffect(() => {
    setActiveIndex((index) => {
      if (previewRows.length === 0) return 0;
      return Math.min(index, previewRows.length - 1);
    });
  }, [previewRows.length]);

  const selected = useMemo(
    () => previewRows[activeIndex] ?? drops.find((drop) => drop.id === selectedId) ?? null,
    [activeIndex, drops, previewRows, selectedId],
  );

  const readyCount = useMemo(() => metricDrops.filter((drop) => drop.status === "READY").length, [metricDrops]);
  const archivedCount = useMemo(() => metricDrops.filter((drop) => drop.status === "ARCHIVED").length, [metricDrops]);
  const usedCount = useMemo(() => metricDrops.filter((drop) => drop.usageCount > 0).length, [metricDrops]);

  function handleNewVoicemail() {
    setCreating(true);
    setSelectedId(null);
    setActiveIndex(0);
    setSavedMsg("");
  }

  function handleSelectDrop(drop: CrmVoicemailDrop, index: number) {
    setSelectedId(drop.id);
    setActiveIndex(index);
    setCreating(false);
    setSavedMsg("");
  }

  async function saveDrop(id: string, body: Record<string, unknown>) {
    const res = await apiPatch<{ voicemailDrop: CrmVoicemailDrop }>(`/crm/voicemail-drops/${id}`, body);
    const updated = res.voicemailDrop;
    setDrops((prev) => prev.map((drop) => (drop.id === id ? updated : drop)));
    setSelectedId(updated.id);
    setCreating(false);
    setSavedMsg("Saved");
    setTimeout(() => setSavedMsg(""), 2500);
    void loadDrops();
    return updated;
  }

  return (
    <PermissionGate permission="can_view_crm_voicemail_drops" fallback={<div className="state-box">You do not have Voicemail Drops access.</div>}>
    <CRMPageShell className={cn(crm.queueWorkspace, "crm-voicemail-drops-workspace w-full min-h-0")} innerClassName={crm.pageInnerQueue}>
      <CRMWorkspaceShell>
        <CRMWorkspaceChrome>
          <CRMWorkspaceHeader>
            <CRMPageHeader
              compact
              className={cn(crm.contactsHeaderPanel, "campaigns-command-header")}
              icon={<Voicemail className="h-6 w-6" aria-hidden />}
              title="Voicemail Drops"
              subtitle="Upload, manage, and deploy PBX-safe voicemail drop recordings."
              actions={
                <div className="campaigns-hero-actions">
                  <button
                    type="button"
                    onClick={handleNewVoicemail}
                    className="campaigns-btn-primary"
                  >
                    <Plus className="h-4 w-4" />
                    New voicemail
                  </button>
                </div>
              }
            />
          </CRMWorkspaceHeader>

          <CRMWorkspaceToolbar className="flex flex-col gap-3">
            {!loading && !error ? (
              <section className="crm-queue-kpi-strip grid w-full grid-cols-2 items-stretch gap-3 md:grid-cols-3 xl:grid-cols-6">
                <KpiCard icon={<Voicemail className="h-4 w-4" />} label="Total Drops" value={String(metricStats.totalRecordings || metricDrops.length)} micro={`${visibleRows.length} shown`} accent="blue" />
                <KpiCard icon={<Play className="h-4 w-4" />} label="Total Duration" value={fmtDuration(metricStats.totalDurationSeconds)} micro="PBX-safe audio" accent="violet" />
                <KpiCard icon={<CheckCircle2 className="h-4 w-4" />} label="Ready" value={String(readyCount)} micro="campaign-ready" accent="cyan" />
                <KpiCard icon={<Headphones className="h-4 w-4" />} label="Used" value={String(usedCount)} micro="used in calls" accent="green" />
                <KpiCard icon={<Archive className="h-4 w-4" />} label="Archived" value={String(archivedCount)} micro="hidden from active" accent="rose" />
                <KpiCard icon={<Sparkles className="h-4 w-4" />} label="Success Rate" value={`${Math.round(metricStats.dropSuccessRate)}%`} micro="drop success" accent="amber" />
              </section>
            ) : null}

            <CRMActionBar className="crm-queue-filter-bar voicemail-drops-filter-bar">
              <div className="crm-queue-filter-grid w-full">
                <div className="crm-queue-filter-field crm-queue-filter-field-search min-w-[min(100%,14rem)] flex-[2]">
                  <Search className="crm-queue-filter-icon h-4 w-4 shrink-0 text-crm-muted" />
                  <input
                    id="crm-voicemail-search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Name, campaign, audio file..."
                    className={cn(crm.input, "crm-queue-filter-control min-w-[10rem] flex-1")}
                    aria-label="Search voicemail drops"
                  />
                </div>
                <div className="crm-queue-filter-field">
                  <Voicemail className="crm-queue-filter-icon h-4 w-4 shrink-0 text-crm-muted" />
                  <label htmlFor="crm-voicemail-status" className="sr-only">Status</label>
                  <ConnectSelect
                    id="crm-voicemail-status"
                    value={statusFilter}
                    onChange={(value) => setStatusFilter(value)}
                    size="sm"
                    className="min-w-[10rem] flex-1"
                    options={[
                      { value: "all", label: "All Statuses" },
                      { value: "READY", label: "Ready" },
                      { value: "PROCESSING", label: "Processing" },
                      { value: "FAILED", label: "Failed" },
                      { value: "ARCHIVED", label: "Archived" },
                    ]}
                  />
                </div>
              </div>
            </CRMActionBar>
          </CRMWorkspaceToolbar>
        </CRMWorkspaceChrome>

        <CRMWorkspaceBody split>
          <CRMWorkspaceMain className="crm-queue-main-workspace">
            <CRMWorkspaceScrollRegion className="crm-queue-center-workspace flex min-w-0 flex-col gap-3">
              <section className="crm-queue-list-panel">
                {loading ? (
                  <div className="py-24 text-center text-sm text-crm-muted/80" aria-busy="true">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading voicemail drops...
                  </div>
                ) : error ? (
                  <div className="crm-queue-list-panel px-6 py-14 text-center">
                    <p className="text-sm font-medium text-crm-danger">{error}</p>
                    <button type="button" className={cn(crm.btnPrimary, "mt-6")} onClick={() => void loadDrops()}>
                      Retry
                    </button>
                  </div>
                ) : visibleRows.length === 0 ? (
                  <div className="crm-queue-list-panel px-6 py-14 text-center">
                    <FileAudio className="mx-auto h-10 w-10 text-crm-border" />
                    <h2 className="mt-3 text-lg font-bold text-crm-text">No voicemail drops yet</h2>
                    <p className="mx-auto mt-2 max-w-md text-sm text-crm-muted">Upload your first PBX-safe voicemail drop recording to get started.</p>
                    <button type="button" onClick={handleNewVoicemail} className="tasks-primary-action mt-6">
                      <Plus className="h-4 w-4" />
                      New voicemail
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="crm-queue-list-head">
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-crm-muted">
                        <input type="checkbox" readOnly checked={false} className={crm.checkbox} />
                        <span>Select voicemail drop</span>
                      </label>
                      <span className="text-[10px] font-semibold text-crm-muted tabular-nums">
                        {visibleRows.length} shown · {metricDrops.length} total
                      </span>
                    </div>
                    <div className="crm-queue-row-list">
                      {previewRows.map((drop, index) => (
                        <VoicemailRow
                          key={`${drop.id}-${index}`}
                          drop={drop}
                          rank={index + 1}
                          selected={activeIndex === index}
                          onSelect={() => handleSelectDrop(drop, index)}
                        />
                      ))}
                    </div>
                  </>
                )}
              </section>
            </CRMWorkspaceScrollRegion>
          </CRMWorkspaceMain>

          <CRMWorkspaceRightRail className="crm-queue-right-rail crm-queue-detail-rail voicemail-drops-right-rail flex flex-col min-h-0">
            <VoicemailDetailPanel
              drop={selected}
              drops={metricDrops}
              stats={metricStats}
              readyCount={readyCount}
              archivedCount={archivedCount}
              usedCount={usedCount}
              creating={creating}
              savedMsg={savedMsg}
              rank={activeIndex + 1}
              total={previewRows.length}
              canGoPrevious={activeIndex > 0}
              canGoNext={activeIndex < previewRows.length - 1}
              onNew={handleNewVoicemail}
              onPrevious={() => setActiveIndex((index) => Math.max(0, index - 1))}
              onNext={() => setActiveIndex((index) => Math.min(previewRows.length - 1, index + 1))}
              onCancelCreate={() => setCreating(false)}
              onCreated={(drop) => {
                setDrops((prev) => [drop, ...prev]);
                setSelectedId(drop.id);
                setActiveIndex(0);
                setCreating(false);
                setSavedMsg("Created");
                setTimeout(() => setSavedMsg(""), 2500);
                void loadDrops();
              }}
              onSave={saveDrop}
              onArchive={(drop) => saveDrop(drop.id, { status: "ARCHIVED", isDefault: false })}
              onRestore={(drop) => saveDrop(drop.id, { status: "READY" })}
            />
          </CRMWorkspaceRightRail>
        </CRMWorkspaceBody>
      </CRMWorkspaceShell>

    </CRMPageShell>
    </PermissionGate>
  );
}

function KpiCard({
  icon,
  label,
  value,
  micro,
  accent,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  micro: string;
  accent: "blue" | "violet" | "green" | "amber" | "rose" | "cyan";
}) {
  return (
    <div className={cn(crm.queueCountPill, `crm-queue-kpi-${accent}`, "relative overflow-hidden bg-crm-surface-2")}>
      <span className="flex w-full items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="crm-queue-kpi-label block text-[10px] font-bold uppercase tracking-wide text-crm-muted">{label}</span>
          <span className="crm-queue-kpi-value mt-1 block text-2xl font-bold tabular-nums leading-none tracking-tight text-crm-text">
            {value}
          </span>
        </span>
        <span className="crm-queue-kpi-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-crm border border-crm-border/55 bg-crm-surface/70 text-crm-accent">
          {icon}
        </span>
      </span>
      <span className="crm-queue-kpi-micro text-[10px] font-medium text-crm-muted">{micro}</span>
    </div>
  );
}

function VoicemailRow({
  drop,
  rank,
  selected,
  onSelect,
}: {
  drop: CrmVoicemailDrop;
  rank: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  const src = withToken(drop.streamUrl);
  const color = statusColor(drop.status);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-selected={selected}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "crm-queue-row crm-contact-row voicemail-drop-row group",
        selected && "crm-queue-row-selected",
        drop.status === "ARCHIVED" && "crm-queue-row-readonly opacity-90",
      )}
    >
      <div className="crm-queue-row-grid">
        <label
          className="crm-contact-row-check"
          onClick={(event) => event.stopPropagation()}
          aria-label={`Select ${drop.name}`}
        >
          <input type="checkbox" checked={false} readOnly onChange={onSelect} />
        </label>
        <span className="crm-queue-row-rank tabular-nums">{rank}</span>

        <div
          className="crm-queue-row-avatar"
          style={{
            background: `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 42%, #6366f1))`,
          }}
          aria-hidden
        >
          {initialsFromName(drop.name)}
        </div>

        <div className="crm-queue-row-main min-w-0">
          <div className="crm-queue-row-title-line">
            <span className="crm-queue-row-name truncate">{drop.name}</span>
            <span className={cn("crm-queue-pill", statusPillClass(drop.status))}>
              {drop.status}
            </span>
            {drop.isDefault ? <span className="crm-queue-pill crm-queue-pill-stage">Default</span> : null}
          </div>
          <p className="crm-queue-row-sub truncate">
            Voicemail drop · {fmtDuration(drop.durationSeconds)} · Used {drop.usageCount} times
          </p>
          {playing && src ? <audio className="mt-2 w-full max-w-md" src={src} controls autoPlay onEnded={() => setPlaying(false)} /> : null}
        </div>

        <div className="crm-queue-row-phone hidden md:flex">
          <Voicemail className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{drop.campaign?.name || "General"}</span>
        </div>

        <div className="crm-queue-row-email hidden lg:flex">
          <FileAudio className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{drop.originalFileName || drop.pbxFormat || "Audio recording"}</span>
        </div>

        <div className="crm-queue-row-meta hidden xl:flex">
          <span className="crm-queue-pill crm-queue-pill-muted inline-flex items-center gap-0.5">
            <Clock3 className="h-3 w-3" />
            {timeAgo(drop.updatedAt)}
          </span>
        </div>

        <button
          type="button"
          disabled={!src || drop.status !== "READY"}
          onClick={(event) => {
            event.stopPropagation();
            setPlaying((value) => !value);
          }}
          className="crm-queue-row-status shrink-0 crm-queue-pill crm-queue-pill-stage"
          aria-label={playing ? "Pause voicemail preview" : "Play voicemail preview"}
        >
          <Play className="h-3 w-3 fill-current" />
          Preview
        </button>

        <ChevronRight className="crm-queue-row-chevron h-4 w-4 shrink-0" />
      </div>
    </div>
  );
}

function PanelSection({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("crm-queue-detail-actions-card", className)}>
      <p className="crm-queue-detail-section-label">{title}</p>
      <div>{children}</div>
    </section>
  );
}

function DetailMetric({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-crm border border-crm-border/50 bg-crm-surface/70 p-3">
      <div className="flex items-center gap-2 text-crm-muted">
        {icon}
        <span className="text-[10px] font-bold uppercase tracking-wider">{label}</span>
      </div>
      <p className="mt-2 text-lg font-black tabular-nums text-crm-text">{value}</p>
      {detail ? <p className="mt-0.5 text-[11px] font-medium text-crm-muted">{detail}</p> : null}
    </div>
  );
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-t border-crm-border/45 py-2 first:border-t-0 first:pt-0 last:pb-0">
      <span className="text-[11px] font-bold uppercase tracking-wider text-crm-muted">{label}</span>
      <span className="max-w-[12rem] text-right text-xs font-semibold text-crm-text">{value}</span>
    </div>
  );
}

function ReadinessRing({ percent, tone }: { percent: number; tone: ReturnType<typeof readiness>["tone"] }) {
  const color = tone === "success" ? "#22c55e" : tone === "warning" ? "#f59e0b" : tone === "danger" ? "#ef4444" : "#64748b";
  return (
    <div
      className="relative flex h-20 w-20 shrink-0 items-center justify-center rounded-full"
      style={{
        background: `conic-gradient(${color} ${percent * 3.6}deg, rgba(148,163,184,0.22) 0deg)`,
      }}
      aria-label={`Voicemail readiness ${percent}%`}
    >
      <div className="absolute inset-2 rounded-full border border-crm-border/55 bg-crm-surface" />
      <span className="relative text-lg font-black tabular-nums text-crm-text">{percent}%</span>
    </div>
  );
}

function VoicemailTag({ icon, label, tone = "neutral" }: { icon?: ReactNode; label: string; tone?: "neutral" | "accent" | "success" | "warning" | "danger" }) {
  return (
    <span className={cn("voicemail-drops-tag-chip", `voicemail-drops-tag-${tone}`)}>
      {icon}
      {label}
    </span>
  );
}

function VoicemailWaveform({ muted = false }: { muted?: boolean }) {
  const bars = [36, 58, 42, 78, 54, 88, 44, 68, 96, 52, 74, 40, 84, 62, 46, 72, 50, 90];
  return (
    <div className={cn("voicemail-drops-waveform", muted && "voicemail-drops-waveform-muted")} aria-hidden>
      {bars.map((height, index) => (
        <span key={`${height}-${index}`} style={{ height: `${height}%` }} />
      ))}
    </div>
  );
}

function NewVoicemailPanel({ onClose, onCreated }: { onClose: () => void; onCreated: (drop: CrmVoicemailDrop) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!file || !name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiUploadCrmVoicemailDrop({
        name: name.trim(),
        description: description.trim() || undefined,
        isDefault,
        file,
      }) as { voicemailDrop: CrmVoicemailDrop };
      onCreated(res.voicemailDrop);
    } catch (err: any) {
      setError(err?.message || "Failed to upload voicemail");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="crm-queue-detail-panel crm-contact-detail-panel voicemail-drops-studio-panel flex min-h-full flex-col gap-4 p-4" role="region" aria-label="Create voicemail drop">
      <div className="crm-queue-detail-glow" aria-hidden />
      <header className="voicemail-drops-studio-hero relative z-[1] flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="voicemail-drops-orb flex h-11 w-11 shrink-0 items-center justify-center rounded-crm border border-crm-border bg-crm-surface-2 text-crm-accent">
            <Upload className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-black uppercase tracking-wider text-crm-muted">Studio upload</p>
            <h2 className="truncate text-lg font-black text-crm-text">New Voicemail Drop</h2>
          </div>
        </div>
        <button type="button" onClick={onClose} className="rounded-xl p-2 text-crm-muted hover:bg-crm-surface-2 hover:text-crm-text" aria-label="Close create panel">
          <X className="h-4 w-4" />
        </button>
      </header>

      {error ? (
        <div className={cn(crm.bannerDanger, "relative z-[1] flex gap-2 rounded-crm p-3 text-sm")}>
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
      ) : null}

      <div className="relative z-[1] flex flex-col gap-4">
        <PanelSection title="Voicemail identity" className="voicemail-drops-section-card">
          <div className="space-y-3">
            <label className="block">
              <span className={cn(crm.label, "mb-1 block")}>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} className={crm.input} placeholder="Standard Voicemail" />
            </label>
            <label className="block">
              <span className={cn(crm.label, "mb-1 block")}>Description / notes</span>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} className={cn(crm.input, "min-h-24 resize-y")} placeholder="Short context for agents" />
            </label>
          </div>
        </PanelSection>

        <PanelSection title="Audio source" className="voicemail-drops-section-card voicemail-drops-upload-section">
          <div className={cn("voicemail-drops-upload-zone", file && "voicemail-drops-upload-zone-ready")}>
            <label className="flex cursor-pointer flex-col items-center justify-center gap-3 text-center">
              <span className="voicemail-drops-upload-icon">
                <Upload className="h-6 w-6" />
              </span>
              <span className="text-sm font-black text-crm-text">{file ? file.name : "Drop in any audio or media file"}</span>
              <span className="text-xs leading-relaxed text-crm-muted">
                {file ? `${file.type || "Media file"} ${fmtFileSize(file.size) ? `· ${fmtFileSize(file.size)}` : ""}` : "Connect extracts audio and converts uploads to a PBX-safe voicemail format."}
              </span>
              <VoicemailWaveform muted={!file} />
              <input
                type="file"
                accept="audio/*,video/*,.wav,.mp3,.m4a,.ogg,.oga,.opus,.aac,.flac,.webm,.mp4,.mov,.mkv,.amr,.aif,.aiff"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
          </div>
          <label className="mt-3 flex items-center justify-between rounded-crm border border-crm-border bg-crm-surface/70 px-3 py-2.5 text-sm font-semibold text-crm-text">
            Set as default voicemail drop
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} className={crm.checkbox} />
          </label>
        </PanelSection>
      </div>

      <footer className="relative z-[1] mt-auto flex flex-col gap-2 border-t border-crm-border/60 pt-4">
        <button type="button" disabled={saving || !name.trim() || !file} onClick={() => void submit()} className="tasks-primary-action w-full justify-center">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock3 className="h-4 w-4" />}
          Create Voicemail
        </button>
        <button type="button" onClick={onClose} className={crm.btnSecondary}>Cancel</button>
      </footer>
    </div>
  );
}

function VoicemailDetailPanel({
  drop,
  drops,
  stats,
  readyCount,
  archivedCount,
  usedCount,
  creating,
  savedMsg,
  rank,
  total,
  canGoPrevious,
  canGoNext,
  onNew,
  onPrevious,
  onNext,
  onCancelCreate,
  onCreated,
  onSave,
  onArchive,
  onRestore,
}: {
  drop: CrmVoicemailDrop | null;
  drops: CrmVoicemailDrop[];
  stats: DropsResponse["stats"];
  readyCount: number;
  archivedCount: number;
  usedCount: number;
  creating: boolean;
  savedMsg: string;
  rank: number;
  total: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onNew: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onCancelCreate: () => void;
  onCreated: (drop: CrmVoicemailDrop) => void;
  onSave: (id: string, body: Record<string, unknown>) => Promise<CrmVoicemailDrop>;
  onArchive: (drop: CrmVoicemailDrop) => Promise<CrmVoicemailDrop>;
  onRestore: (drop: CrmVoicemailDrop) => Promise<CrmVoicemailDrop>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setEditing(false);
    setLocalError(null);
    setName(drop?.name ?? "");
    setDescription(drop?.description ?? "");
    setIsDefault(Boolean(drop?.isDefault));
  }, [drop?.id, drop?.name, drop?.description, drop?.isDefault]);

  if (creating) {
    return <NewVoicemailPanel onClose={onCancelCreate} onCreated={onCreated} />;
  }

  const report = readiness(drop);

  async function saveEdit() {
    if (!drop || !name.trim()) return;
    setSaving(true);
    setLocalError(null);
    try {
      await onSave(drop.id, {
        name: name.trim(),
        description: description.trim() || null,
        isDefault,
      });
      setEditing(false);
    } catch (err: any) {
      setLocalError(err?.message || "Failed to save voicemail drop");
    } finally {
      setSaving(false);
    }
  }

  async function archiveOrRestore() {
    if (!drop) return;
    setSaving(true);
    setLocalError(null);
    try {
      if (drop.status === "ARCHIVED") {
        await onRestore(drop);
      } else {
        await onArchive(drop);
      }
    } catch (err: any) {
      setLocalError(err?.message || "Failed to update voicemail status");
    } finally {
      setSaving(false);
    }
  }

  if (!drop) {
    return (
      <aside className="crm-queue-detail-panel crm-contact-detail-panel flex min-h-full flex-col gap-4 p-4" aria-label="Voicemail drops summary">
        <div className="crm-queue-detail-glow" aria-hidden />
        <div className="relative z-[1] rounded-crm border border-crm-border/55 bg-crm-surface-2/45 p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-crm border border-crm-border bg-crm-surface text-crm-accent">
              <Voicemail className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[11px] font-black uppercase tracking-wider text-crm-muted">Library</p>
              <h2 className="text-lg font-black text-crm-text">Select a voicemail drop</h2>
              <p className="mt-1 text-xs leading-relaxed text-crm-muted">Open a row to review audio, readiness, metadata, and usage reporting.</p>
            </div>
          </div>
        </div>
        <div className="relative z-[1] grid grid-cols-2 gap-2">
          <DetailMetric icon={<FileAudio className="h-4 w-4" />} label="Recordings" value={String(drops.length)} />
          <DetailMetric icon={<CheckCircle2 className="h-4 w-4" />} label="Ready" value={String(readyCount)} />
          <DetailMetric icon={<TrendingUp className="h-4 w-4" />} label="Used" value={String(usedCount)} />
          <DetailMetric icon={<Archive className="h-4 w-4" />} label="Archived" value={String(archivedCount)} />
        </div>
        <PanelSection title="Library readiness">
          <div className="flex items-center gap-4">
            <ReadinessRing percent={drops.length ? Math.round((readyCount / drops.length) * 100) : 0} tone={readyCount ? "success" : "muted"} />
            <div>
              <p className="text-sm font-black text-crm-text">{readyCount} ready recordings</p>
              <p className="mt-1 text-xs leading-relaxed text-crm-muted">Create a new drop or select an existing row to manage campaign-ready voicemail audio.</p>
            </div>
          </div>
        </PanelSection>
        <button type="button" onClick={onNew} className="tasks-primary-action relative z-[1] mt-auto w-full justify-center">
          <Plus className="h-4 w-4" />
          New Voicemail
        </button>
      </aside>
    );
  }

  const src = withToken(drop.streamUrl);

  return (
    <aside className="crm-queue-detail-panel crm-contact-detail-panel flex min-h-full flex-col gap-4 p-4" aria-label="Voicemail drop details">
      <div className="crm-queue-detail-glow" aria-hidden />
      <header className="voicemail-drops-studio-hero relative z-[1] flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="voicemail-drops-orb flex h-11 w-11 shrink-0 items-center justify-center rounded-crm border border-crm-border bg-crm-surface-2 text-crm-accent">
            <Headphones className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold", statusPillClass(drop.status))}>{drop.status}</span>
              {drop.isDefault ? <span className="rounded-full border border-crm-accent/35 bg-crm-accent/10 px-2 py-0.5 text-[11px] font-bold text-crm-accent">Default</span> : null}
            </div>
            <h2 className="mt-2 truncate text-lg font-black text-crm-text">{drop.name}</h2>
            <p className="mt-1 text-xs leading-relaxed text-crm-muted">{drop.description || "No script notes or agent guidance added yet."}</p>
          </div>
        </div>
        <button type="button" onClick={() => setEditing((value) => !value)} className={crm.btnSecondary}>
          {editing ? <X className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
          {editing ? "Close" : "Edit"}
        </button>
      </header>

      <div className="voicemail-drops-rail-pager relative z-[1] flex items-center justify-between gap-2">
        <button type="button" onClick={onPrevious} disabled={!canGoPrevious} className={crm.btnSecondary} aria-label="Previous voicemail drop">
          <ChevronLeft className="h-4 w-4" />
          Prev
        </button>
        <span className="text-[11px] font-bold uppercase tracking-wider text-crm-muted">
          {rank} / {total || 1}
        </span>
        <button type="button" onClick={onNext} disabled={!canGoNext} className={crm.btnSecondary} aria-label="Next voicemail drop">
          Next
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {savedMsg ? (
        <div className={cn(crm.bannerSuccess, "relative z-[1] flex items-center gap-2 rounded-crm px-3 py-2 text-sm font-semibold")}>
          <Check className="h-4 w-4" />
          {savedMsg}
        </div>
      ) : null}
      {localError ? (
        <div className={cn(crm.bannerDanger, "relative z-[1] flex items-center gap-2 rounded-crm px-3 py-2 text-sm")}>
          <AlertCircle className="h-4 w-4" />
          {localError}
        </div>
      ) : null}

      <section className="voicemail-drops-command-card relative z-[1]">
        <div className="voicemail-drops-command-grid">
          <ReadinessRing percent={report.percent} tone={report.tone} />
          <div className="min-w-0">
            <p className="text-[11px] font-black uppercase tracking-[0.16em] text-crm-muted">Voicemail studio</p>
            <h3 className="mt-1 text-base font-black text-crm-text">{report.label}</h3>
            <p className="mt-1 text-xs leading-relaxed text-crm-muted">{report.detail}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <VoicemailTag icon={<CheckCircle2 className="h-3 w-3" />} label={drop.status} tone={report.tone === "danger" ? "danger" : report.tone === "warning" ? "warning" : report.tone === "success" ? "success" : "neutral"} />
              <VoicemailTag icon={<FileAudio className="h-3 w-3" />} label={drop.pbxFormat || drop.conversionStatus || "Pending format"} tone="accent" />
              {drop.isDefault ? <VoicemailTag icon={<Sparkles className="h-3 w-3" />} label="Default" tone="accent" /> : null}
            </div>
            <div className={cn("voicemail-drops-readiness-track mt-4", progressToneClass(report.tone))}>
              <span style={{ width: `${report.percent}%` }} />
            </div>
          </div>
        </div>
      </section>

      {editing ? (
        <PanelSection title="Edit voicemail drop">
          <div className="space-y-3">
            <label className="block">
              <span className={cn(crm.label, "mb-1 block")}>Name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} className={crm.input} />
            </label>
            <label className="block">
              <span className={cn(crm.label, "mb-1 block")}>Description / script notes</span>
              <textarea value={description} onChange={(event) => setDescription(event.target.value)} className={cn(crm.input, "min-h-24 resize-y")} />
            </label>
            <label className="flex items-center justify-between rounded-crm border border-crm-border bg-crm-surface/70 px-3 py-2.5 text-sm font-semibold text-crm-text">
              Default voicemail drop
              <input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} className={crm.checkbox} />
            </label>
            <button type="button" disabled={saving || !name.trim()} onClick={() => void saveEdit()} className={cn(crm.btnPrimary, "w-full")}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save Changes
            </button>
          </div>
        </PanelSection>
      ) : null}

      <PanelSection title="Creation / upload / play" className="voicemail-drops-section-card voicemail-drops-audio-section">
        <div className="voicemail-drops-audio-studio">
          <div className={cn("voicemail-drops-play-core", !src || drop.status !== "READY" ? "voicemail-drops-play-core-muted" : "")}>
            <span className="voicemail-drops-play-button" aria-hidden>
              <Play className="h-5 w-5 fill-current" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-black text-crm-text">{src && drop.status === "READY" ? "Ready to preview" : "Preview pending"}</p>
              <p className="mt-0.5 text-xs text-crm-muted">{drop.originalFileName || "No original filename recorded"}</p>
            </div>
            <span className="text-xs font-black tabular-nums text-crm-text">{fmtDuration(drop.durationSeconds)}</span>
          </div>
          <VoicemailWaveform muted={!src || drop.status !== "READY"} />
          {src && drop.status === "READY" ? (
            <audio className="voicemail-drops-native-audio w-full" controls src={src} />
          ) : (
            <div className="voicemail-drops-audio-empty">
              <AlertCircle className="h-4 w-4" />
              <span>Audio preview is unavailable until conversion finishes or a stream URL is available.</span>
            </div>
          )}
        </div>
      </PanelSection>

      <PanelSection title="Tags and routing" className="voicemail-drops-section-card">
        <div className="flex flex-wrap gap-2">
          <VoicemailTag icon={<Voicemail className="h-3 w-3" />} label={drop.campaign?.name || "General library"} tone="accent" />
          <VoicemailTag icon={<Timer className="h-3 w-3" />} label={fmtDuration(drop.durationSeconds)} />
          <VoicemailTag icon={<BarChart3 className="h-3 w-3" />} label={`Used ${drop.usageCount} times`} tone={drop.usageCount ? "success" : "neutral"} />
          <VoicemailTag icon={<Clock3 className="h-3 w-3" />} label={drop.lastUsedAt ? `Last used ${fmtDate(drop.lastUsedAt)}` : "Not used yet"} />
        </div>
      </PanelSection>

      <PanelSection title="Agent script context" className="voicemail-drops-section-card voicemail-drops-script-section">
        <div className="rounded-crm border border-crm-border/45 bg-crm-surface/70 p-3">
          <div className="flex items-center gap-2 text-crm-muted">
            <FileText className="h-4 w-4" />
            <span className="text-[10px] font-bold uppercase tracking-wider">Talk track</span>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-crm-text">{drop.description || "No script or content notes attached. Add a concise agent cue in edit mode."}</p>
        </div>
      </PanelSection>

      <div className="relative z-[1] grid grid-cols-2 gap-2">
        <DetailMetric icon={<Timer className="h-4 w-4" />} label="Duration" value={fmtDuration(drop.durationSeconds)} />
        <DetailMetric icon={<BarChart3 className="h-4 w-4" />} label="Usage" value={String(drop.usageCount)} detail={drop.lastUsedAt ? `Last used ${fmtDate(drop.lastUsedAt)}` : "No drops yet"} />
        <DetailMetric icon={<TrendingUp className="h-4 w-4" />} label="Success" value={`${Math.round(stats.dropSuccessRate)}%`} />
        <DetailMetric icon={<CheckCircle2 className="h-4 w-4" />} label="Library Ready" value={`${readyCount}/${drops.length || 0}`} />
      </div>

      <PanelSection title="File metadata">
        <MetadataRow label="Campaign" value={drop.campaign?.name || "General"} />
        <MetadataRow label="Original file" value={drop.originalFileName || "Not recorded"} />
        <MetadataRow label="Source type" value={drop.originalMimeType || "Not recorded"} />
        <MetadataRow label="PBX format" value={drop.pbxFormat || drop.conversionStatus || "Pending"} />
        <MetadataRow label="Created" value={fmtDate(drop.createdAt)} />
        <MetadataRow label="Updated" value={fmtDate(drop.updatedAt)} />
      </PanelSection>

      <footer className="relative z-[1] mt-auto grid gap-2 border-t border-crm-border/60 pt-4">
        <button type="button" disabled={saving} onClick={() => void archiveOrRestore()} className={drop.status === "ARCHIVED" ? crm.btnSecondary : crm.btnDanger}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : drop.status === "ARCHIVED" ? <RotateCcw className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
          {drop.status === "ARCHIVED" ? "Restore Drop" : "Archive Drop"}
        </button>
      </footer>
    </aside>
  );
}
