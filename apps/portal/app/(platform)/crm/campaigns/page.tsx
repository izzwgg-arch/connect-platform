"use client";

import { useEffect, useState, useCallback, useMemo, useRef, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Activity,
  Archive,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileUp,
  Filter,
  Grid2X2,
  ListOrdered,
  Megaphone,
  Palette,
  PhoneCall,
  Plus,
  Search,
  Send,
  Sparkles,
  Tag,
  Target,
  Users,
  X,
  Zap,
} from "lucide-react";
import {
  CRMPageShell,
  CRMPageHeader,
  CRMActionBar,
  CRMWorkspaceShell,
  CRMWorkspaceChrome,
  CRMWorkspaceHeader,
  CRMWorkspaceToolbar,
  CRMWorkspaceBody,
  CRMWorkspaceMain,
  CRMWorkspaceScrollRegion,
  CRMWorkspaceRightRail,
  CampaignGuidedEmpty,
  type CampaignListItem,
  type CampaignReportRow,
  type CampaignStatus,
} from "../../../../components/crm";
import { crm } from "../../../../components/crm/crmClasses";
import { ConnectSelect } from "../../../../components/ConnectSelect";
import { ViewportDropdown } from "../../../../components/ViewportDropdown";
import { mk } from "../../../../components/crm/campaign/campaignCinemaClasses";
import { apiGet, apiPost, apiPatch, apiDelete } from "../../../../services/apiClient";
import { CrmConfirmModal } from "../../../../components/crm/CrmConfirmModal";
import { CrmRowActionMenu } from "../../../../components/crm/CrmRowActionMenu";
import { EditCampaignModal } from "../../../../components/crm/campaign/EditCampaignModal";
import { useAppContext } from "../../../../hooks/useAppContext";
import { cn } from "../../../../components/crm/cn";
import { CAMPAIGN_PRIORITY_LABELS, CAMPAIGN_STATUS_LABELS } from "../../../../components/crm/campaign/campaignTypes";
import { formatShortDate, queueHref } from "../../../../components/crm/campaign/campaignUtils";

type CampaignSort = "status" | "updated" | "name";
type CampaignQuickFilter = "all" | CampaignStatus | "SCHEDULED";
type CampaignTypeFilter = "all" | "LOW" | "NORMAL" | "HIGH" | "URGENT" | "SCRIPTED" | "CHECKLIST";
type CampaignTagDraft = {
  id: string;
  label: string;
  color: { r: number; g: number; b: number };
};

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

const DEFAULT_TAG_RGB = { r: 109, g: 93, b: 252 };

function clampRgbChannel(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbToHex({ r, g, b }: CampaignTagDraft["color"]) {
  return `#${[r, g, b].map((channel) => clampRgbChannel(channel).toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgb(hex: string) {
  const normalized = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return DEFAULT_TAG_RGB;
  const value = Number.parseInt(normalized, 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function campaignTagPillStyle({ r, g, b }: CampaignTagDraft["color"]) {
  const textR = Math.max(20, Math.round(r * 0.42));
  const textG = Math.max(28, Math.round(g * 0.42));
  const textB = Math.max(42, Math.round(b * 0.42));

  return {
    "--campaign-tag-rgb": `${r} ${g} ${b}`,
    backgroundColor: `rgba(${r}, ${g}, ${b}, 0.14)`,
    borderColor: `rgba(${r}, ${g}, ${b}, 0.32)`,
    color: `rgb(${textR}, ${textG}, ${textB})`,
  } as CSSProperties;
}

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
  const accent = tone === "orange" ? "amber" : tone === "red" ? "rose" : tone;

  return (
    <div
      className={cn(
        crm.queueCountPill,
        `crm-queue-kpi-${accent}`,
        "relative overflow-hidden bg-crm-surface-2",
      )}
    >
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
      <span className="crm-queue-kpi-micro text-[10px] font-medium text-crm-muted">{trend}</span>
    </div>
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

function CampaignDetailMetric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="campaigns-detail-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

function CampaignListDetailPanel({
  campaign,
  metrics,
  rank,
  total,
  canQueue,
  canManageCampaigns,
  canGoPrevious,
  canGoNext,
  onPrevious,
  onNext,
  onOpen,
  onEdit,
  onDelete,
}: {
  campaign: CampaignListItem;
  metrics?: CampaignReportRow | null;
  rank: number;
  total: number;
  canQueue: boolean;
  canManageCampaigns: boolean;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const contacts = campaign.memberCount ?? metrics?.total ?? 0;
  const contacted = metrics?.contacted ?? 0;
  const converted = metrics?.converted ?? 0;
  const callbacks = metrics?.callbacks ?? 0;
  const pending = metrics?.pending ?? 0;
  const dnc = metrics?.dnc ?? 0;
  const totalAttempts = metrics?.totalAttempts ?? 0;
  const conversionRate = metrics?.conversionRate ?? 0;
  const campaignType = campaignTypeLabel(campaign);
  const owner = campaignOwnerLabel(campaign);
  const sparkTone = conversionRate >= 15 ? "green" : conversionRate >= 8 ? "blue" : campaign.status === "PAUSED" ? "orange" : "violet";

  return (
    <aside className="crm-queue-detail-panel crm-contact-detail-panel campaigns-detail-panel custom-scrollbar" aria-label="Campaign details">
      <div className="crm-queue-detail-glow" aria-hidden />

      <header className="crm-queue-detail-header">
        <div className="flex flex-wrap items-center gap-2">
          <CampaignStatusPill status={campaign.status} />
          {campaign.status === "ARCHIVED" ? (
            <span className="crm-queue-pill crm-queue-pill-warning inline-flex items-center gap-1">
              <Archive className="h-3 w-3" />
              Archived
            </span>
          ) : null}
        </div>
        <span className="crm-queue-detail-position tabular-nums">
          {rank} <span className="text-crm-muted/60">/</span> {total}
        </span>
      </header>

      <section className="crm-queue-detail-identity">
        <div className={cn("crm-queue-detail-avatar campaigns-detail-icon", CAMPAIGN_STATUS_TONE[campaign.status])}>
          <Megaphone className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="crm-queue-detail-name truncate">{campaign.name}</h2>
          <p className="crm-queue-detail-sub truncate">
            {campaignType} · {owner}
          </p>
        </div>
      </section>

      <section className="crm-queue-detail-contact-strip campaigns-detail-summary">
        <p>{campaign.description?.trim() || "No campaign description yet."}</p>
        <div className="crm-queue-detail-lines">
          <div className="crm-queue-detail-line">
            <CalendarDays className="h-3.5 w-3.5 shrink-0 text-crm-accent" />
            <span>Updated {formatShortDate(campaign.updatedAt)}</span>
          </div>
          <div className="crm-queue-detail-line">
            <Clock3 className="h-3.5 w-3.5 shrink-0 text-crm-accent" />
            <span>Created {formatShortDate(campaign.createdAt)}</span>
          </div>
        </div>
      </section>

      <section className="crm-queue-detail-actions-card">
        <p className="crm-queue-detail-section-label">Campaign actions</p>
        <button
          type="button"
          onClick={onOpen}
          className={cn(crm.btnPrimary, "crm-queue-detail-primary-action w-full justify-center gap-2")}
        >
          <ExternalLink className="h-4 w-4" />
          Open campaign
        </button>
        <div className="crm-queue-detail-action-grid">
          {canQueue ? (
            <Link href={queueHref(campaign.id)} className="crm-queue-detail-secondary-action">
              <PhoneCall className="h-4 w-4" />
              Queue
            </Link>
          ) : null}
          {canManageCampaigns && campaign.status !== "ARCHIVED" ? (
            <button type="button" onClick={onEdit} className="crm-queue-detail-secondary-action">
              <Activity className="h-4 w-4" />
              Edit
            </button>
          ) : null}
          {canManageCampaigns && campaign.status !== "ARCHIVED" ? (
            <button type="button" onClick={onDelete} className="crm-queue-detail-secondary-action crm-queue-detail-danger-action">
              <Archive className="h-4 w-4" />
              Delete
            </button>
          ) : null}
        </div>
      </section>

      <section className="crm-queue-detail-actions-card campaigns-detail-analytics">
        <div className="campaigns-detail-section-head">
          <p className="crm-queue-detail-section-label">Analytics</p>
          <Sparkline seed={`${campaign.id}-${totalAttempts}`} tone={sparkTone} />
        </div>
        <div className="campaigns-detail-metric-grid">
          <CampaignDetailMetric label="Contacts" value={formatNumber(contacts)} hint="Roster size" />
          <CampaignDetailMetric label="Contacted" value={formatNumber(contacted)} hint={`${formatNumber(totalAttempts)} attempts`} />
          <CampaignDetailMetric label="Converted" value={formatNumber(converted)} hint={`${formatPercent(conversionRate)} rate`} />
          <CampaignDetailMetric label="Callbacks" value={formatNumber(callbacks)} hint="Waiting" />
          <CampaignDetailMetric label="Queue" value={formatNumber(pending)} hint="Pending" />
          <CampaignDetailMetric label="DNC" value={formatNumber(dnc)} hint="Do not call" />
        </div>
      </section>

      <section className="crm-queue-detail-actions-card campaigns-detail-meta-card">
        <p className="crm-queue-detail-section-label">Setup</p>
        <dl>
          <div>
            <dt>Priority</dt>
            <dd>{CAMPAIGN_PRIORITY_LABELS[campaign.priority]}</dd>
          </div>
          <div>
            <dt>Script</dt>
            <dd>{campaign.script?.name ?? "None assigned"}</dd>
          </div>
          <div>
            <dt>Checklist</dt>
            <dd>{campaign.checklist?.name ?? "None assigned"}</dd>
          </div>
        </dl>
      </section>

      <footer className="crm-queue-detail-footer">
        <button
          type="button"
          onClick={onPrevious}
          disabled={!canGoPrevious}
          className={cn(crm.btnSecondary, "crm-queue-detail-nav flex-1 justify-center gap-1.5")}
        >
          <ChevronLeft className="h-4 w-4" />
          Previous
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!canGoNext}
          className={cn(crm.btnSecondary, "crm-queue-detail-nav flex-1 justify-center gap-1.5")}
        >
          Next
          <ChevronRight className="h-4 w-4" />
        </button>
      </footer>
    </aside>
  );
}

function CampaignListDetailPlaceholder() {
  return (
    <aside className="crm-queue-detail-panel crm-contact-detail-panel crm-queue-detail-placeholder campaigns-detail-panel custom-scrollbar" aria-label="Campaign details">
      <div className="crm-queue-detail-glow" aria-hidden />
      <div className="crm-queue-detail-placeholder-icon">
        <Megaphone size={22} />
      </div>
      <h2>Select a campaign</h2>
      <p>Choose a campaign row to review analytics, setup details, and campaign actions.</p>
    </aside>
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
  const [tagLabel, setTagLabel] = useState("");
  const [tagColor, setTagColor] = useState(DEFAULT_TAG_RGB);
  const [tags, setTags] = useState<CampaignTagDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [tagError, setTagError] = useState("");

  const tagHex = rgbToHex(tagColor);

  function handleTagChannelChange(channel: keyof CampaignTagDraft["color"], value: string) {
    setTagColor((current) => ({
      ...current,
      [channel]: clampRgbChannel(Number.parseInt(value || "0", 10)),
    }));
  }

  function handleAddTag() {
    const label = tagLabel.trim();
    setTagError("");
    if (!label) {
      setTagError("Give the tag a label first.");
      return;
    }
    if (tags.some((tag) => tag.label.toLowerCase() === label.toLowerCase())) {
      setTagError("That tag is already staged.");
      return;
    }

    setTags((current) => [
      ...current,
      {
        id: `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`,
        label,
        color: {
          r: clampRgbChannel(tagColor.r),
          g: clampRgbChannel(tagColor.g),
          b: clampRgbChannel(tagColor.b),
        },
      },
    ]);
    setTagLabel("");
  }

  async function handleSubmit(e: FormEvent) {
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
      <div className="campaign-create-modal-card w-full max-w-2xl">
        <div className="campaign-create-modal-glow" aria-hidden />
        <div className="campaign-create-modal-inner">
          <header className="campaign-create-modal-header">
            <div className="campaign-create-modal-icon">
              <Sparkles className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0">
              <p className="campaign-create-modal-eyebrow">Campaign cockpit</p>
              <h2>{importAfterCreate ? "Create campaign & import leads" : "New campaign"}</h2>
              <p>
                {importAfterCreate
                  ? "Name the mission, stage its vibe, then drop into CSV import with everything ready."
                  : "Spin up a polished campaign shell with priority and color-coded signals."}
              </p>
            </div>
          </header>

          <form onSubmit={handleSubmit} className="campaign-create-form">
            <section className="campaign-create-section">
              <div className="campaign-create-section-head">
                <div>
                  <p className="campaign-create-section-kicker">Basics</p>
                  <h3>Give the team a clear brief</h3>
                </div>
                <span className="campaign-create-mini-pill">Draft first</span>
              </div>
              <label className="campaign-create-label">Campaign name</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
                className="campaign-create-input"
                placeholder="e.g. Q3 Outbound Blitz"
              maxLength={200}
            />
              <label className="campaign-create-label">
              Description <span className="text-crm-muted font-normal">(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
                className="campaign-create-input campaign-create-textarea"
              rows={3}
                placeholder="Objective, audience, offer, and the one thing agents should not forget..."
              maxLength={2000}
            />
            </section>

            <section className="campaign-create-section">
              <div className="campaign-create-section-head">
                <div>
                  <p className="campaign-create-section-kicker">Priority</p>
                  <h3>Set the queue energy</h3>
                </div>
              </div>
              <div className="campaign-create-priority-grid" role="group" aria-label="Queue priority">
              {(["NORMAL", "HIGH", "URGENT"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority(p)}
                  className={cn(
                      "campaign-create-priority-card",
                      priority === p && "campaign-create-priority-card-active",
                      priority === p && p === "URGENT" && "campaign-create-priority-card-urgent",
                      priority === p && p === "HIGH" && "campaign-create-priority-card-high",
                  )}
                >
                    <span>{CAMPAIGN_PRIORITY_LABELS[p]}</span>
                    <small>
                      {p === "URGENT" ? "Move now" : p === "HIGH" ? "Hot lane" : "Steady tempo"}
                    </small>
                </button>
              ))}
            </div>
            </section>

            <section className="campaign-create-section campaign-create-tag-section">
              <div className="campaign-create-section-head">
                <div>
                  <p className="campaign-create-section-kicker">Tags</p>
                  <h3>Stage custom RGB labels</h3>
                </div>
                <Tag className="h-4 w-4 text-crm-accent" aria-hidden />
              </div>
              <div className="campaign-create-tag-builder">
                <div className="campaign-create-tag-label-wrap">
                  <label className="campaign-create-label">Tag label</label>
                  <input
                    value={tagLabel}
                    onChange={(e) => setTagLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddTag();
                      }
                    }}
                    className="campaign-create-input"
                    placeholder="e.g. VIP, Renewal, spicy lead"
                    maxLength={36}
                  />
                </div>
                <div className="campaign-create-color-control">
                  <label className="campaign-create-label">Color</label>
                  <div className="campaign-create-color-row">
                    <input
                      type="color"
                      value={tagHex}
                      onChange={(e) => setTagColor(hexToRgb(e.target.value))}
                      className="campaign-create-color-picker"
                      aria-label="Tag color picker"
                    />
                    <span className="campaign-create-color-value">{tagHex.toUpperCase()}</span>
                  </div>
                </div>
              </div>
              <div className="campaign-create-rgb-grid" aria-label="RGB color values">
                {(["r", "g", "b"] as const).map((channel) => (
                  <label key={channel} className="campaign-create-rgb-field">
                    <span>{channel.toUpperCase()}</span>
                    <input
                      type="number"
                      min={0}
                      max={255}
                      value={tagColor[channel]}
                      onChange={(e) => handleTagChannelChange(channel, e.target.value)}
                      className="campaign-create-rgb-input"
                    />
                  </label>
                ))}
                <button type="button" onClick={handleAddTag} className="campaign-create-add-tag">
                  <Plus className="h-4 w-4" />
                  Add tag
                </button>
              </div>
              <div className="campaign-create-tag-preview">
                {tags.length > 0 ? (
                  tags.map((tag) => (
                    <span key={tag.id} className="campaign-create-tag-pill" style={campaignTagPillStyle(tag.color)}>
                      <span className="campaign-create-tag-dot" />
                      {tag.label}
                      <button
                        type="button"
                        onClick={() => setTags((current) => current.filter((item) => item.id !== tag.id))}
                        aria-label={`Remove ${tag.label} tag`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))
                ) : (
                  <span className="campaign-create-empty-tags">
                    <Palette className="h-3.5 w-3.5" />
                    Add tags to preview the pill system.
                  </span>
                )}
              </div>
              <p className="campaign-create-tag-note">
                RGB tag styling is ready here; persistence waits for campaign tag storage in the API.
              </p>
              {tagError ? <p className="campaign-create-inline-error">{tagError}</p> : null}
            </section>

            {error ? <p className="campaign-create-inline-error">{error}</p> : null}
            <footer className="campaign-create-footer">
              <button type="button" onClick={onClose} className="campaign-create-secondary-btn">
              Cancel
            </button>
              <button type="submit" disabled={saving || !name.trim()} className="campaign-create-primary-btn">
                {saving ? "Creating..." : importAfterCreate ? "Create & import leads" : "Launch draft"}
            </button>
            </footer>
        </form>
        </div>
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
    can("can_manage_crm") ||
    can("can_view_crm_campaigns");

  const canManageCampaigns = can("can_view_crm_campaigns");

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
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [editingCampaign, setEditingCampaign] = useState<CampaignListItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CampaignListItem | null>(null);
  const [deleteWorking, setDeleteWorking] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const filtersButtonRef = useRef<HTMLButtonElement>(null);

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

  async function handleSaveCampaignEdit(data: {
    name: string;
    description?: string | null;
    priority: CampaignListItem["priority"];
    status?: CampaignListItem["status"];
  }) {
    if (!editingCampaign) return;
    const res = await apiPatch<{ campaign: CampaignListItem }>(
      `/crm/campaigns/${editingCampaign.id}`,
      data,
      token,
    );
    setCampaigns((prev) => prev.map((c) => (c.id === editingCampaign.id ? { ...c, ...res.campaign } : c)));
    setToast({ kind: "ok", text: "Campaign saved" });
  }

  async function handleDeleteCampaign() {
    if (!deleteTarget) return;
    setDeleteWorking(true);
    try {
      await apiDelete(`/crm/campaigns/${deleteTarget.id}`, token);
      setCampaigns((prev) =>
        prev.map((c) => (c.id === deleteTarget.id ? { ...c, status: "ARCHIVED" as const } : c)),
      );
      setToast({ kind: "ok", text: "Campaign deleted" });
      setDeleteTarget(null);
    } catch (err: unknown) {
      setToast({ kind: "err", text: (err as Error)?.message ?? "Delete failed" });
    } finally {
      setDeleteWorking(false);
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

  const listEmptyNoCampaigns = !loading && !error && campaigns.length === 0;
  const listEmptyAfterFilter = !loading && !error && campaigns.length > 0 && filtered.length === 0;
  const hasActiveFilters = search !== "" || statusFilter !== "all" || typeFilter !== "all" || ownerFilter !== "all" || dateFilter !== "all";

  useEffect(() => {
    if (filtered.length === 0) {
      if (selectedCampaignId !== null) setSelectedCampaignId(null);
      return;
    }
    if (!selectedCampaignId || !filtered.some((campaign) => campaign.id === selectedCampaignId)) {
      setSelectedCampaignId(filtered[0].id);
    }
  }, [filtered, selectedCampaignId]);

  const activeCampaignIndex = useMemo(() => {
    if (!selectedCampaignId) return -1;
    return filtered.findIndex((campaign) => campaign.id === selectedCampaignId);
  }, [filtered, selectedCampaignId]);

  const activeCampaign = activeCampaignIndex >= 0 ? filtered[activeCampaignIndex] : null;

  function resetFilters() {
    setSearch("");
    setStatusFilter("all");
    setTypeFilter("all");
    setOwnerFilter("all");
    setDateFilter("all");
    setFiltersOpen(false);
  }

  return (
    <CRMPageShell
      className={cn("campaigns-page-shell", crm.queueWorkspace)}
      innerClassName={cn(crm.pageInnerQueue, mk.workspace, "campaigns-page-inner")}
    >
      {toast ? (
        <div
          className={cn(
            "rounded-crm border px-4 py-2 text-sm font-medium",
            toast.kind === "ok"
              ? "border-crm-success/30 bg-crm-success/10 text-crm-success"
              : "border-crm-danger/30 bg-crm-danger/10 text-crm-danger",
          )}
        >
          {toast.text}
        </div>
      ) : null}

      {editingCampaign ? (
        <EditCampaignModal
          campaign={editingCampaign}
          onClose={() => setEditingCampaign(null)}
          onSave={handleSaveCampaignEdit}
        />
      ) : null}

      <CrmConfirmModal
        open={!!deleteTarget}
        title="Delete campaign?"
        description={
          deleteTarget?.status === "ACTIVE"
            ? "This campaign is active. Deleting removes it from default lists and queue work. Members, timeline, and import history are preserved."
            : "Deleted campaigns are hidden from default lists. Members and history are preserved."
        }
        confirmLabel="Delete"
        destructive
        loading={deleteWorking}
        onConfirm={() => void handleDeleteCampaign()}
        onCancel={() => setDeleteTarget(null)}
      />

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

      <CRMWorkspaceShell className="campaigns-workspace-shell">
        <CRMWorkspaceChrome>
          <CRMWorkspaceHeader>
            <CRMPageHeader
              compact
              className={cn(crm.contactsHeaderPanel, "campaigns-command-header")}
              icon={<Megaphone className="h-6 w-6" aria-hidden />}
              title="Campaigns"
              subtitle="Create, manage, and analyze outbound programs with live operational context."
              actions={
                <div className="campaigns-hero-actions">
              {canQueue && (
                <>
                  <Link href="/crm/queue" className="campaigns-btn-secondary">
                    <ListOrdered className="h-4 w-4" />
                    Queue
                    {summary.queueWork > 0 ? ` (${summary.queueWork})` : ""}
                  </Link>
                  <Link href="/crm/queue?filter=overdue" className="campaigns-btn-secondary">
                    <PhoneCall className="h-4 w-4" />
                    Callbacks
                    {summary.callbacks > 0 ? ` (${summary.callbacks})` : ""}
                  </Link>
                </>
              )}
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
              }
            />
          </CRMWorkspaceHeader>

          <CRMWorkspaceToolbar className="flex flex-col gap-3">

          {!loading && !error && campaigns.length > 0 ? (
            <section className="crm-queue-kpi-strip grid w-full grid-cols-2 items-stretch gap-3 md:grid-cols-3 xl:grid-cols-6" aria-label="Campaign metrics">
              <CampaignKpiTile label="Total Campaigns" value={formatNumber(campaigns.length)} trend="+ across all statuses" tone="blue" icon={<CalendarDays className="h-4 w-4" />} />
              <CampaignKpiTile label="Active Campaigns" value={formatNumber(summary.active)} trend={summary.paused > 0 ? `${summary.paused} paused` : "All live programs clear"} tone="violet" icon={<Zap className="h-4 w-4" />} />
              <CampaignKpiTile label="Total Contacts" value={formatNumber(summary.members)} trend="Across campaign rosters" tone="green" icon={<Users className="h-4 w-4" />} />
              <CampaignKpiTile label="Contacted" value={formatNumber(summary.contacted)} trend={`${formatNumber(summary.attempts)} total attempts`} tone="cyan" icon={<Send className="h-4 w-4" />} />
              <CampaignKpiTile label="Converted" value={formatNumber(summary.converted)} trend={`${summary.callbacks} callbacks waiting`} tone="orange" icon={<CheckCircle2 className="h-4 w-4" />} />
              <CampaignKpiTile label="Conversion Rate" value={formatPercent(summary.avgConversionRate)} trend="Average by campaign" tone="red" icon={<Target className="h-4 w-4" />} />
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
          <ConnectSelect
            value={typeFilter}
            onChange={(value) => setTypeFilter(value as CampaignTypeFilter)}
            className="campaigns-select"
            size="sm"
            options={TYPE_FILTER_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
          />
          <ConnectSelect
            value={ownerFilter}
            onChange={(value) => setOwnerFilter(value)}
            className="campaigns-select"
            size="sm"
            options={[
              { value: "all", label: "All owners" },
              ...ownerOptions.map((owner) => ({ value: owner, label: owner })),
            ]}
          />
          <button
            ref={filtersButtonRef}
            type="button"
            onClick={() => setFiltersOpen((open) => !open)}
            className={cn("campaigns-filter-button campaigns-filter-button-selectlike", statusFilter !== "all" && "campaigns-filter-button-active")}
            aria-label="Open campaign filters"
            aria-haspopup="dialog"
            aria-expanded={filtersOpen}
          >
            <Filter className="h-4 w-4" />
            Filters
          </button>
        </div>
      </CRMActionBar>
      <ViewportDropdown
        open={filtersOpen}
        triggerRef={filtersButtonRef}
        onClose={() => setFiltersOpen(false)}
        width={340}
        sideOffset={8}
        className="campaigns-filter-dropdown contacts-filter-panel"
      >
        <div className="contacts-filter-panel-inner" role="dialog" aria-label="Campaign filters">
          <div className="contacts-filter-panel-head">
            <div>
              <p className="text-sm font-bold text-crm-text">Filters</p>
              <p className="text-xs text-crm-muted">Campaign status and saved views</p>
            </div>
            <button type="button" onClick={resetFilters} className="contacts-filter-reset" disabled={!hasActiveFilters}>
              Reset
            </button>
          </div>
          <div className="campaigns-filter-panel-section">
            <span className="campaigns-filter-panel-label">Date range</span>
            <ConnectSelect
              value={dateFilter}
              onChange={(value) => setDateFilter(value)}
              className="campaigns-filter-date-select"
              size="sm"
              options={[
                { value: "all", label: "Any time" },
                { value: "7d", label: "Last 7 days" },
                { value: "30d", label: "Last 30 days" },
                { value: "90d", label: "Last 90 days" },
              ]}
            />
          </div>
          <div className="campaigns-filter-panel-section">
            <span className="campaigns-filter-panel-label">Status</span>
            <div className="contacts-filter-panel-grid" role="group" aria-label="Campaign status filters">
              {QUICK_FILTER_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    setStatusFilter(opt.value);
                    setFiltersOpen(false);
                  }}
                  className={cn("campaigns-filter-option", statusFilter === opt.value && "campaigns-filter-option-active")}
                >
                  <span>{opt.label}</span>
                  <strong>{campaignCountForFilter(campaigns, opt.value)}</strong>
                </button>
              ))}
            </div>
          </div>
        </div>
      </ViewportDropdown>

          </CRMWorkspaceToolbar>
        </CRMWorkspaceChrome>

        <CRMWorkspaceBody split={!loading && !error && !listEmptyNoCampaigns && !listEmptyAfterFilter}>
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
        <>
          <CRMWorkspaceMain className="crm-queue-main-workspace">
            <CRMWorkspaceScrollRegion className="crm-queue-center-workspace campaigns-list-scroll-region flex min-w-0 flex-col gap-3">
              <section className="campaigns-table-card campaigns-list-card crm-queue-list-panel" aria-label="Campaign list">
            <div className="campaigns-table-head">
              <div>
                <h2>Campaign portfolio</h2>
                <p>Showing {filtered.length} of {campaigns.length} campaigns</p>
              </div>
              <label className="campaigns-sort-control">
                Sort
                <ConnectSelect
                  value={sortBy}
                  onChange={(value) => setSortBy(value as CampaignSort)}
                  size="sm"
                  options={[
                    { value: "status", label: "Status" },
                    { value: "updated", label: "Updated" },
                    { value: "name", label: "Name" },
                  ]}
                />
              </label>
            </div>
            <div className="campaigns-list-scroll">
              <div className="crm-queue-row-list campaigns-row-list">
                {filtered.map((campaign, index) => {
                  const isSelected = activeCampaign?.id === campaign.id;
                  return (
                    <div
                      key={campaign.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedCampaignId(campaign.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedCampaignId(campaign.id);
                        }
                      }}
                      className={cn("crm-queue-row campaigns-list-row group", isSelected && "crm-queue-row-selected")}
                    >
                      <div className="crm-queue-row-grid">
                        <span className="crm-queue-row-rank tabular-nums">{index + 1}</span>
                        <span className={cn("campaigns-row-icon", CAMPAIGN_STATUS_TONE[campaign.status])} aria-hidden>
                          <Megaphone className="h-4 w-4" />
                        </span>
                        <div className="crm-queue-row-main min-w-0">
                          <div className="crm-queue-row-title-line">
                            <Link
                              href={`/crm/campaigns/${campaign.id}`}
                              onClick={(e) => e.stopPropagation()}
                              className="crm-queue-row-name campaigns-row-title truncate"
                            >
                              {campaign.name}
                            </Link>
                            <CampaignStatusPill status={campaign.status} />
                            <span className="campaigns-type-pill">{campaignTypeLabel(campaign)}</span>
                          </div>
                          <p className="crm-queue-row-sub truncate">
                            {campaign.description?.trim() || `${campaignOwnerLabel(campaign)} · updated ${formatShortDate(campaign.updatedAt)}`}
                          </p>
                        </div>
                        <div className="campaigns-row-actions flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                          {canQueue ? <Link href={queueHref(campaign.id)}>Queue</Link> : null}
                          {canManageCampaigns ? (
                            <CrmRowActionMenu
                              label={campaign.name}
                              onEdit={
                                campaign.status !== "ARCHIVED"
                                  ? () => setEditingCampaign(campaign)
                                  : undefined
                              }
                              onDelete={
                                campaign.status !== "ARCHIVED"
                                  ? () => setDeleteTarget(campaign)
                                  : undefined
                              }
                            />
                          ) : null}
                        </div>
                        <button
                          type="button"
                          className="crm-queue-row-chevron-button shrink-0"
                          onClick={(event) => {
                            event.stopPropagation();
                            router.push(`/crm/campaigns/${campaign.id}`);
                          }}
                          aria-label={`Open campaign ${campaign.name}`}
                          title="Open campaign"
                        >
                          <ChevronRight className="crm-queue-row-chevron h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
              </section>
            </CRMWorkspaceScrollRegion>
          </CRMWorkspaceMain>

          <CRMWorkspaceRightRail
            className="campaigns-right-rail crm-queue-detail-rail flex flex-col min-h-0"
            scrollClassName="campaigns-right-rail-scroll"
          >
            {activeCampaign ? (
              <CampaignListDetailPanel
                campaign={activeCampaign}
                metrics={reportById.get(activeCampaign.id)}
                rank={activeCampaignIndex + 1}
                total={filtered.length}
                canQueue={canQueue}
                canManageCampaigns={canManageCampaigns}
                canGoPrevious={activeCampaignIndex > 0}
                canGoNext={activeCampaignIndex < filtered.length - 1}
                onPrevious={() => setSelectedCampaignId(filtered[Math.max(0, activeCampaignIndex - 1)]?.id ?? activeCampaign.id)}
                onNext={() => setSelectedCampaignId(filtered[Math.min(filtered.length - 1, activeCampaignIndex + 1)]?.id ?? activeCampaign.id)}
                onOpen={() => router.push(`/crm/campaigns/${activeCampaign.id}`)}
                onEdit={() => setEditingCampaign(activeCampaign)}
                onDelete={() => setDeleteTarget(activeCampaign)}
              />
            ) : (
              <CampaignListDetailPlaceholder />
            )}
          </CRMWorkspaceRightRail>
        </>
      )}
        </CRMWorkspaceBody>
      </CRMWorkspaceShell>
    </CRMPageShell>
  );
}
