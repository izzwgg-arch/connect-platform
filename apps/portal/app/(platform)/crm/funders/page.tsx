"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Clock,
  Download,
  FileUp,
  HandCoins,
  Mail,
  Palette,
  Phone,
  Plus,
  Search,
  SlidersHorizontal,
  Tag,
  Upload,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  crm,
  cn,
  CRMPageShell,
  CRMPageHeader,
  CRMWorkspaceShell,
  CRMWorkspaceChrome,
  CRMWorkspaceHeader,
  CRMWorkspaceToolbar,
  CRMWorkspaceBody,
  CRMWorkspaceMain,
  CRMWorkspaceScrollRegion,
  CRMWorkspaceRightRail,
  FunderListDetailPanel,
  FunderListDetailPlaceholder,
} from "../../../../components/crm";
import { ConnectSelect } from "../../../../components/ConnectSelect";
import { ViewportDropdown } from "../../../../components/ViewportDropdown";
import { BulkEmailModal } from "../../../../components/crm/email/BulkEmailModal";
import { avatarGradient } from "../../../../components/crm/contact/contactFormatters";
import { apiGet, apiPost, apiDelete } from "../../../../services/apiClient";
import { useAppContext } from "../../../../hooks/useAppContext";
import { CrmConfirmModal } from "../../../../components/crm/CrmConfirmModal";

// ── Types ──────────────────────────────────────────────────────────────────────

type FunderStatus = "ACTIVE" | "INACTIVE" | "PROSPECT" | "PENDING";

type FunderTag = {
  id: string;
  name: string;
  color?: string | null;
};

type FunderTagDraft = {
  id: string;
  label: string;
  color: { r: number; g: number; b: number };
};

const DEFAULT_TAG_RGB = { r: 109, g: 93, b: 252 };

function clampRgbChannel(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbToHex({ r, g, b }: FunderTagDraft["color"]) {
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

function funderTagPillStyle(color: FunderTagDraft["color"] | string | null | undefined) {
  const rgb = typeof color === "string" ? hexToRgb(color) : color ?? DEFAULT_TAG_RGB;
  const { r, g, b } = rgb;
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

type Funder = {
  id: string;
  tenantId: string;
  name: string;
  organization?: string | null;
  email?: string | null;
  phone?: string | null;
  phone2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  notes?: string | null;
  status: FunderStatus;
  active: boolean;
  archivedAt?: string | null;
  tags: FunderTag[];
  createdAt: string;
  updatedAt: string;
};

type FundersResponse = {
  rows: Funder[];
  total: number;
  page: number;
  limit: number;
};

type FunderStats = {
  total: number;
  active: number;
  prospects: number;
  recentlyAdded: number;
};

// ── Constants ──────────────────────────────────────────────────────────────────

const PAGE_LIMIT = 50;

const STATUS_LABELS: Record<FunderStatus | "all", string> = {
  all: "All",
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  PROSPECT: "Prospect",
  PENDING: "Pending",
};

const STATUS_COLORS: Record<FunderStatus, string> = {
  ACTIVE: "bg-emerald-500/15 text-emerald-600 border-emerald-400/30",
  INACTIVE: "bg-gray-400/15 text-gray-500 border-gray-400/30",
  PROSPECT: "bg-blue-500/15 text-blue-600 border-blue-400/30",
  PENDING: "bg-amber-500/15 text-amber-600 border-amber-400/30",
};

const DEV_FUNDER_ROWS: Funder[] = [
  {
    id: "dev-funder-1",
    tenantId: "local-dev",
    name: "SW Sun Wellness Foundation",
    organization: "Foundation",
    email: "grants@swsunwellness.org",
    phone: "(555) 204-1180",
    phone2: "(555) 204-1181",
    city: "Austin",
    state: "TX",
    zip: "78701",
    notes: "Supports community health, wellness, and outreach programs.",
    status: "ACTIVE",
    active: true,
    archivedAt: null,
    tags: [
      { id: "dev-tag-health", name: "Health", color: "#10b981" },
      { id: "dev-tag-community", name: "Community", color: "#f97316" },
    ],
    createdAt: "2026-06-01T14:30:00.000Z",
    updatedAt: "2026-06-04T16:45:00.000Z",
  },
  {
    id: "dev-funder-2",
    tenantId: "local-dev",
    name: "Bright Path Grantmakers",
    organization: "Grantmaker",
    email: "programs@brightpath.org",
    phone: "(555) 310-9021",
    city: "Phoenix",
    state: "AZ",
    zip: "85004",
    notes: "Priority funder for workforce and family stability initiatives.",
    status: "PROSPECT",
    active: true,
    archivedAt: null,
    tags: [
      { id: "dev-tag-grants", name: "Grants", color: "#8b5cf6" },
      { id: "dev-tag-workforce", name: "Workforce", color: "#2563eb" },
    ],
    createdAt: "2026-05-28T10:15:00.000Z",
    updatedAt: "2026-06-03T18:10:00.000Z",
  },
  {
    id: "dev-funder-3",
    tenantId: "local-dev",
    name: "Lakeside Community Fund",
    organization: "Nonprofit",
    email: "partners@lakesidefund.org",
    phone: "(555) 618-4400",
    city: "Chicago",
    state: "IL",
    zip: "60601",
    notes: "Interested in regional community benefit campaigns.",
    status: "PENDING",
    active: true,
    archivedAt: null,
    tags: [
      { id: "dev-tag-community", name: "Community", color: "#f97316" },
      { id: "dev-tag-regional", name: "Regional", color: "#0ea5e9" },
    ],
    createdAt: "2026-05-22T12:00:00.000Z",
    updatedAt: "2026-06-02T13:25:00.000Z",
  },
  {
    id: "dev-funder-4",
    tenantId: "local-dev",
    name: "Civic Bridge Capital",
    organization: "Financial Partner",
    email: "hello@civicbridge.capital",
    phone: "(555) 455-7712",
    city: "Denver",
    state: "CO",
    zip: "80202",
    notes: "Potential partner for matched funding and sponsored programs.",
    status: "ACTIVE",
    active: true,
    archivedAt: null,
    tags: [
      { id: "dev-tag-finance", name: "Finance", color: "#64748b" },
      { id: "dev-tag-sponsor", name: "Sponsor", color: "#d97706" },
    ],
    createdAt: "2026-05-18T09:45:00.000Z",
    updatedAt: "2026-06-01T15:00:00.000Z",
  },
  {
    id: "dev-funder-5",
    tenantId: "local-dev",
    name: "North Star Family Trust",
    organization: "Foundation",
    email: "giving@northstartrust.org",
    phone: "(555) 772-6314",
    city: "Minneapolis",
    state: "MN",
    zip: "55401",
    notes: "Family foundation focused on youth, family services, and local care access.",
    status: "PROSPECT",
    active: true,
    archivedAt: null,
    tags: [
      { id: "dev-tag-family", name: "Family", color: "#ec4899" },
      { id: "dev-tag-health", name: "Health", color: "#10b981" },
    ],
    createdAt: "2026-05-12T11:20:00.000Z",
    updatedAt: "2026-05-30T17:35:00.000Z",
  },
  {
    id: "dev-funder-6",
    tenantId: "local-dev",
    name: "Greenline Corporate Giving",
    organization: "Corporation",
    email: "csr@greenline.example",
    phone: "(555) 890-2219",
    city: "Seattle",
    state: "WA",
    zip: "98101",
    notes: "Corporate social responsibility team for quarterly sponsorship opportunities.",
    status: "ACTIVE",
    active: true,
    archivedAt: null,
    tags: [
      { id: "dev-tag-corporate", name: "Corporate", color: "#16a34a" },
      { id: "dev-tag-sponsor", name: "Sponsor", color: "#d97706" },
    ],
    createdAt: "2026-05-06T08:10:00.000Z",
    updatedAt: "2026-05-29T12:40:00.000Z",
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function initials(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

function parseCsvLocally(text: string): string[][] {
  const rows: string[][] = [];
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let pos = 0;
  const len = lines.length;
  while (pos < len) {
    const row: string[] = [];
    while (pos < len) {
      if (lines[pos] === '"') {
        pos++;
        let field = "";
        while (pos < len) {
          if (lines[pos] === '"') {
            if (lines[pos + 1] === '"') { field += '"'; pos += 2; }
            else { pos++; break; }
          } else { field += lines[pos++]; }
        }
        row.push(field);
        if (pos < len && lines[pos] === ",") pos++;
      } else {
        const start = pos;
        while (pos < len && lines[pos] !== "," && lines[pos] !== "\n") pos++;
        row.push(lines.slice(start, pos).trim());
        if (pos < len && lines[pos] === ",") pos++;
      }
      if (pos < len && lines[pos] === "\n") { pos++; break; }
    }
    if (row.length > 0 && !(row.length === 1 && row[0] === "")) rows.push(row);
  }
  return rows;
}

function FunderKpiTile({
  label,
  value,
  hint,
  icon: Icon,
  tone,
  loading,
}: {
  label: string;
  value: number;
  hint: string;
  icon: LucideIcon;
  tone: "blue" | "green" | "violet" | "amber" | "rose" | "cyan";
  loading?: boolean;
}) {
  return (
    <div className={cn(crm.queueCountPill, `crm-queue-kpi-${tone}`, "relative overflow-hidden bg-crm-surface-2")}>
      <span className="flex w-full items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="crm-queue-kpi-label block text-[10px] font-bold uppercase tracking-wide text-crm-muted">
            {label}
          </span>
          {loading ? (
            <span className="crm-queue-kpi-value mt-1 block h-7 w-12 animate-pulse rounded bg-crm-surface-2" />
          ) : (
            <span className="crm-queue-kpi-value mt-1 block text-2xl font-bold tabular-nums leading-none tracking-tight text-crm-text">
              {value}
            </span>
          )}
        </span>
        <span className="crm-queue-kpi-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-crm border border-crm-border/55 bg-crm-surface/70 text-crm-accent">
          <Icon className="h-4 w-4" />
        </span>
      </span>
      <span className="crm-queue-kpi-micro text-[10px] font-medium text-crm-muted">{hint}</span>
    </div>
  );
}

// ── Modal: New Funder ─────────────────────────────────────────────────────────

const EMPTY_FUNDER_FORM = {
  name: "",
  organization: "",
  website: "",
  email: "",
  phone: "",
  phone2: "",
  address: "",
  city: "",
  state: "",
  zip: "",
  notes: "",
  status: "ACTIVE" as FunderStatus,
};

type NewFunderModalProps = {
  open: boolean;
  tags: FunderTag[];
  onClose: () => void;
  onCreated: (funder: Funder) => void;
};

function NewFunderModal({ open, tags, onClose, onCreated }: NewFunderModalProps) {
  const [form, setForm] = useState(EMPTY_FUNDER_FORM);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [stagedTags, setStagedTags] = useState<FunderTagDraft[]>([]);
  const [tagLabel, setTagLabel] = useState("");
  const [tagColor, setTagColor] = useState(DEFAULT_TAG_RGB);
  const [tagError, setTagError] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const tagHex = rgbToHex(tagColor);
  const selectedExistingTags = tags.filter((tag) => selectedTagIds.includes(tag.id));
  const hasAssignedTags = selectedExistingTags.length > 0 || stagedTags.length > 0;

  if (!open) return null;

  const field = (key: keyof typeof form) => (
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }))
  );

  function handleTagChannelChange(channel: keyof FunderTagDraft["color"], value: string) {
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
    const normalized = label.toLowerCase();
    if (
      stagedTags.some((tag) => tag.label.toLowerCase() === normalized) ||
      tags.some((tag) => tag.name.toLowerCase() === normalized)
    ) {
      setTagError("That tag already exists or is staged.");
      return;
    }

    setStagedTags((current) => [
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

  function resetForm() {
    setForm(EMPTY_FUNDER_FORM);
    setSelectedTagIds([]);
    setStagedTags([]);
    setTagLabel("");
    setTagColor(DEFAULT_TAG_RGB);
    setTagError("");
    setErr(null);
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      setErr("Name is required");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const createdTagIds: string[] = [];
      for (const stagedTag of stagedTags) {
        const created = await apiPost<FunderTag>("/crm/funder-tags", {
          name: stagedTag.label,
          color: rgbToHex(stagedTag.color),
        });
        createdTagIds.push(created.id);
      }

      const enrichedNotes = [
        form.website.trim() ? `Website: ${form.website.trim()}` : "",
        form.address.trim() ? `Address: ${form.address.trim()}` : "",
        form.notes.trim(),
      ]
        .filter(Boolean)
        .join("\n\n");

      const funder = await apiPost<Funder>("/crm/funders", {
        name: form.name.trim(),
        organization: form.organization,
        email: form.email,
        phone: form.phone,
        phone2: form.phone2,
        city: form.city,
        state: form.state,
        zip: form.zip,
        notes: enrichedNotes,
        status: form.status,
        tagIds: [...selectedTagIds, ...createdTagIds],
      });
      onCreated(funder);
      resetForm();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to create funder");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={cn(
        crm.campaignModalBackdrop,
        "items-start justify-center overflow-y-auto py-[max(1.25rem,env(safe-area-inset-top,0px))] sm:items-center sm:py-6",
      )}
      onClick={onClose}
    >
      <div
        className="campaign-create-modal-card my-auto w-full max-w-xl max-h-[min(90dvh,calc(100dvh-6rem))]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="campaign-create-modal-glow" aria-hidden />
        <div className="campaign-create-modal-inner custom-scrollbar !max-h-[min(90dvh,calc(100dvh-6rem))]">
          <div className="mb-1 flex items-start gap-3">
            <header className="campaign-create-modal-header !mb-0 min-w-0 flex-1">
              <div className="campaign-create-modal-icon">
                <HandCoins className="h-5 w-5" aria-hidden />
              </div>
              <div className="min-w-0">
                <p className="campaign-create-modal-eyebrow">Funder workspace</p>
                <h2>Add new funder</h2>
                <p>Create a funding partner profile for grants, referrals, and financial relationships.</p>
              </div>
            </header>
            <button
              type="button"
              onClick={onClose}
              className="campaign-create-secondary-btn !min-h-0 shrink-0 !rounded-full !p-2"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="campaign-create-form">
            {err ? <p className="campaign-create-inline-error">{err}</p> : null}

            <section className="campaign-create-section">
              <div className="campaign-create-section-head">
                <div>
                  <p className="campaign-create-section-kicker">Organization</p>
                  <h3>Core identity</h3>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label className="campaign-create-label">Funder name *</label>
                  <input
                    autoFocus
                    className="campaign-create-input"
                    value={form.name}
                    onChange={field("name")}
                    placeholder="Enter funder name"
                  />
                </div>
                <div>
                  <label className="campaign-create-label">Organization type</label>
                  <ConnectSelect
                    className="campaign-create-input mt-[0.38rem]"
                    value={form.organization}
                    onChange={(value) => setForm((f) => ({ ...f, organization: value }))}
                    placeholder="Select type"
                    options={[
                      { value: "Foundation", label: "Foundation" },
                      { value: "Grantmaker", label: "Grantmaker" },
                      { value: "Nonprofit", label: "Nonprofit" },
                      { value: "Corporation", label: "Corporation" },
                      { value: "Government", label: "Government" },
                      { value: "Financial Partner", label: "Financial Partner" },
                    ]}
                  />
                </div>
                <div>
                  <label className="campaign-create-label">Status</label>
                  <ConnectSelect
                    className="campaign-create-input mt-[0.38rem]"
                    value={form.status}
                    onChange={(value) => setForm((f) => ({ ...f, status: value as FunderStatus }))}
                    options={(["ACTIVE", "INACTIVE", "PROSPECT", "PENDING"] as FunderStatus[]).map((s) => ({
                      value: s,
                      label: STATUS_LABELS[s],
                    }))}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="campaign-create-label">Website</label>
                  <input
                    className="campaign-create-input"
                    value={form.website}
                    onChange={field("website")}
                    placeholder="https://example.org"
                  />
                </div>
              </div>
            </section>

            <section className="campaign-create-section">
              <div className="campaign-create-section-head">
                <div>
                  <p className="campaign-create-section-kicker">Contact</p>
                  <h3>Outreach details</h3>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="sm:col-span-3">
                  <label className="campaign-create-label">Email</label>
                  <input
                    type="email"
                    className="campaign-create-input"
                    value={form.email}
                    onChange={field("email")}
                    placeholder="email@example.org"
                  />
                </div>
                <div>
                  <label className="campaign-create-label">Primary phone</label>
                  <input className="campaign-create-input" value={form.phone} onChange={field("phone")} placeholder="(555) 000-0000" />
                </div>
                <div className="sm:col-span-2">
                  <label className="campaign-create-label">Secondary phone</label>
                  <input className="campaign-create-input" value={form.phone2} onChange={field("phone2")} placeholder="(555) 000-0000" />
                </div>
              </div>
            </section>

            <section className="campaign-create-section">
              <div className="campaign-create-section-head">
                <div>
                  <p className="campaign-create-section-kicker">Location</p>
                  <h3>Mailing address</h3>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-6">
                <div className="sm:col-span-6">
                  <label className="campaign-create-label">Street address</label>
                  <input className="campaign-create-input" value={form.address} onChange={field("address")} placeholder="Street address" />
                </div>
                <div className="sm:col-span-2">
                  <label className="campaign-create-label">City</label>
                  <input className="campaign-create-input" value={form.city} onChange={field("city")} placeholder="City" />
                </div>
                <div className="sm:col-span-2">
                  <label className="campaign-create-label">State</label>
                  <input className="campaign-create-input" value={form.state} onChange={field("state")} placeholder="State" />
                </div>
                <div className="sm:col-span-2">
                  <label className="campaign-create-label">ZIP code</label>
                  <input className="campaign-create-input" value={form.zip} onChange={field("zip")} placeholder="ZIP code" />
                </div>
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
                    placeholder="e.g. Grants, Foundation, VIP"
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
              {tags.length > 0 ? (
                <div className="mt-3">
                  <p className="campaign-create-label !mb-2">Tag library</p>
                  <div className="campaign-create-tag-preview !mt-0">
                    {tags.map((tag) => {
                      const selected = selectedTagIds.includes(tag.id);
                      return (
                        <button
                          key={tag.id}
                          type="button"
                          onClick={() =>
                            setSelectedTagIds((prev) =>
                              prev.includes(tag.id) ? prev.filter((id) => id !== tag.id) : [...prev, tag.id],
                            )
                          }
                          className={cn("campaign-create-tag-pill transition-opacity", !selected && "opacity-55 hover:opacity-80")}
                          style={funderTagPillStyle(tag.color)}
                        >
                          <span className="campaign-create-tag-dot" />
                          {tag.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              <div className="campaign-create-tag-preview">
                {hasAssignedTags ? (
                  <>
                    {selectedExistingTags.map((tag) => (
                      <span key={tag.id} className="campaign-create-tag-pill" style={funderTagPillStyle(tag.color)}>
                        <span className="campaign-create-tag-dot" />
                        {tag.name}
                        <button
                          type="button"
                          onClick={() => setSelectedTagIds((prev) => prev.filter((id) => id !== tag.id))}
                          aria-label={`Remove ${tag.name} tag`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                    {stagedTags.map((tag) => (
                      <span key={tag.id} className="campaign-create-tag-pill" style={funderTagPillStyle(tag.color)}>
                        <span className="campaign-create-tag-dot" />
                        {tag.label}
                        <button
                          type="button"
                          onClick={() => setStagedTags((current) => current.filter((item) => item.id !== tag.id))}
                          aria-label={`Remove ${tag.label} tag`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </>
                ) : (
                  <span className="campaign-create-empty-tags">
                    <Palette className="h-3.5 w-3.5" />
                    Add tags to preview the pill system.
                  </span>
                )}
              </div>
              <p className="campaign-create-tag-note">
                New tags are saved to your funder tag library when you create this funder.
              </p>
              {tagError ? <p className="campaign-create-inline-error">{tagError}</p> : null}
            </section>

            <section className="campaign-create-section">
              <div className="campaign-create-section-head">
                <div>
                  <p className="campaign-create-section-kicker">Notes</p>
                  <h3>Internal context</h3>
                </div>
              </div>
              <label className="campaign-create-label">Notes</label>
              <textarea
                className="campaign-create-input campaign-create-textarea"
                value={form.notes}
                onChange={field("notes")}
                rows={3}
                placeholder="Add notes about this funder..."
              />
            </section>

            <footer className="campaign-create-footer">
              <button type="button" onClick={onClose} className="campaign-create-secondary-btn">
                Cancel
              </button>
              <button type="submit" disabled={saving || !form.name.trim()} className="campaign-create-primary-btn">
                {saving ? "Saving..." : "Save funder"}
              </button>
            </footer>
          </form>
        </div>
      </div>
    </div>
  );
}

// ── Modal: New Tag ────────────────────────────────────────────────────────────

type NewTagModalProps = {
  open: boolean;
  onClose: () => void;
  onCreated: (tag: FunderTag) => void;
};

function NewTagModal({ open, onClose, onCreated }: NewTagModalProps) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#6366f1");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setErr("Tag name required"); return; }
    setSaving(true); setErr(null);
    try {
      const tag = await apiPost<FunderTag>("/crm/funder-tags", { name: name.trim(), color });
      onCreated(tag);
      setName(""); setColor("#6366f1");
    } catch (e: any) {
      setErr(e?.message ?? "Failed to create tag");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={crm.contactsModalBackdrop} onClick={onClose}>
      <div className={cn(crm.contactsModalPanel, "max-w-sm w-full")} onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-crm-text">New Tag</h2>
          <button onClick={onClose} className={crm.btnGhost} style={{ padding: "0.375rem" }}><X size={16} /></button>
        </div>
        {err && <div className={cn(crm.bannerDanger, "mb-3 rounded-crm px-3 py-2 text-sm")}>{err}</div>}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div>
            <label className={crm.label}>Tag Name</label>
            <input className={cn(crm.input, "mt-1")} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Insurance, Medicaid" autoFocus />
          </div>
          <div className="flex items-center gap-3">
            <div>
              <label className={crm.label}>Color</label>
              <input type="color" className="mt-1 h-9 w-16 cursor-pointer rounded-crm border border-crm-border bg-crm-surface-2 p-0.5" value={color} onChange={(e) => setColor(e.target.value)} />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className={crm.btnSecondary}>Cancel</button>
            <button type="submit" disabled={saving} className={crm.btnPrimary}>{saving ? "Creating…" : "Create Tag"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Modal: Import ─────────────────────────────────────────────────────────────

type ImportModalProps = {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
};

const SPREADSHEET_EXTS = /\.(xlsx|xls|ods|numbers)$/i;

async function fileToCSV(file: File): Promise<string> {
  if (SPREADSHEET_EXTS.test(file.name)) {
    const XLSX = await import("xlsx");
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]!];
    return XLSX.utils.sheet_to_csv(ws ?? {});
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => resolve((ev.target?.result as string) ?? "");
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsText(file);
  });
}

function ImportModal({ open, onClose, onImported }: ImportModalProps) {
  const [phase, setPhase] = useState<"upload" | "preview" | "result">("upload");
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState("import.csv");
  const [preview, setPreview] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setErr(null);
    try {
      const text = await fileToCSV(file);
      setCsvText(text);
    } catch {
      setErr("Could not read file. Please try a CSV, Excel (.xlsx), or spreadsheet file.");
    }
  };

  const handlePreview = async () => {
    if (!csvText) { setErr("No file selected"); return; }
    setLoading(true); setErr(null);
    try {
      const data = await apiPost<any>("/crm/funders/import/preview", { csvText });
      setPreview(data);
      setPhase("preview");
    } catch (e: any) {
      setErr(e?.message ?? "Preview failed");
    } finally {
      setLoading(false);
    }
  };

  const handleExecute = async () => {
    setLoading(true); setErr(null);
    try {
      const data = await apiPost<any>("/crm/funders/import/execute", { csvText, fileName, mapping: preview?.mapping });
      setResult(data);
      setPhase("result");
    } catch (e: any) {
      setErr(e?.message ?? "Import failed");
    } finally {
      setLoading(false);
    }
  };

  const handleDone = () => {
    onImported();
    onClose();
    setPhase("upload");
    setCsvText("");
    setPreview(null);
    setResult(null);
    setErr(null);
  };

  return (
    <div className={crm.contactsModalBackdrop} onClick={onClose}>
      <div className={cn(crm.contactsModalPanel, "max-w-xl w-full max-h-[85vh] overflow-y-auto")} onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-crm-text">Import Funders</h2>
          <button onClick={onClose} className={crm.btnGhost} style={{ padding: "0.375rem" }}><X size={16} /></button>
        </div>
        {err && <div className={cn(crm.bannerDanger, "mb-3 rounded-crm px-3 py-2 text-sm")}>{err}</div>}

        {phase === "upload" && (
          <div className="flex flex-col gap-4">
            <p className={crm.muted}>Upload a CSV, Excel (.xlsx / .xls), or spreadsheet file with funder records. Supported columns: name, organization, email, phone, phone2, city, state, zip, notes, tags.</p>
            <div
              className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-crm-lg border-2 border-dashed border-crm-border bg-crm-surface-2/40 px-6 py-10 transition-colors hover:border-crm-accent/50 hover:bg-crm-surface-2/60"
              onClick={() => fileRef.current?.click()}
            >
              <Upload size={32} className="text-crm-muted" />
              <span className={crm.muted}>{fileName !== "import.csv" ? fileName : "Click to select a file"}</span>
              <span className="text-xs text-crm-border">CSV · Excel (.xlsx, .xls) · ODS spreadsheet</span>
              {csvText && <span className="text-xs text-crm-accent">✓ File loaded — {parseCsvLocally(csvText).length - 1} rows</span>}
            </div>
            <input ref={fileRef} type="file" accept=".csv,text/csv,.xlsx,.xls,.ods,.numbers,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" className="hidden" onChange={handleFile} />
            <div className="flex justify-end gap-2">
              <button onClick={onClose} className={crm.btnSecondary}>Cancel</button>
              <button onClick={handlePreview} disabled={!csvText || loading} className={crm.btnPrimary}>
                {loading ? "Loading…" : "Preview Mapping"}
              </button>
            </div>
          </div>
        )}

        {phase === "preview" && preview && (
          <div className="flex flex-col gap-4">
            <div className="rounded-crm border border-crm-border bg-crm-surface-2/40 p-3">
              <p className={cn(crm.muted, "text-xs mb-2")}>Detected column mapping ({preview.totalDataRows} rows)</p>
              <div className="flex flex-wrap gap-2">
                {Object.entries(preview.mapping).map(([col, field]) => (
                  <span key={col} className={crm.chip}>
                    <span className="text-crm-accent">{preview.headers[Number(col)]}</span>
                    <span className="mx-1 text-crm-border">→</span>
                    <span>{String(field)}</span>
                  </span>
                ))}
              </div>
            </div>
            {preview.preview?.length > 0 && (
              <div>
                <p className={cn(crm.label, "mb-2")}>Preview (first {preview.preview.length} rows)</p>
                <div className="overflow-x-auto rounded-crm border border-crm-border">
                  <table className="min-w-full text-xs">
                    <thead className="bg-crm-surface-2/60">
                      <tr>
                        {Object.keys(preview.preview[0]).map((k) => (
                          <th key={k} className="border-b border-crm-border px-3 py-2 text-left font-semibold text-crm-muted">{k}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.preview.map((row: any, i: number) => (
                        <tr key={i} className="border-b border-crm-border/50 last:border-0">
                          {Object.values(row).map((v: any, j) => (
                            <td key={j} className="px-3 py-2 text-crm-text">{v || <span className="text-crm-border">—</span>}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setPhase("upload")} className={crm.btnSecondary}>Back</button>
              <button onClick={handleExecute} disabled={loading} className={crm.btnPrimary}>
                {loading ? "Importing…" : `Import ${preview.totalDataRows} rows`}
              </button>
            </div>
          </div>
        )}

        {phase === "result" && result && (
          <div className="flex flex-col gap-4">
            <div className={cn("rounded-crm border px-4 py-3", result.errorCount === result.totalRows ? crm.bannerDanger : crm.bannerSuccess)}>
              <p className="font-semibold">{result.status === "DONE" ? "Import complete" : result.status === "PARTIAL" ? "Import completed with some errors" : "Import failed"}</p>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                { label: "Created", value: result.createdCount, color: "text-crm-success" },
                { label: "Updated", value: result.updatedCount, color: "text-crm-accent" },
                { label: "Skipped", value: result.skippedCount, color: "text-crm-muted" },
                { label: "Errors", value: result.errorCount, color: "text-crm-danger" },
              ].map((m) => (
                <div key={m.label} className="rounded-crm border border-crm-border bg-crm-surface-2/40 p-3 text-center">
                  <div className={cn("text-2xl font-bold tabular-nums", m.color)}>{m.value}</div>
                  <div className={crm.muted}>{m.label}</div>
                </div>
              ))}
            </div>
            {result.errors?.length > 0 && (
              <details className="rounded-crm border border-crm-danger/30 bg-crm-danger/5 p-3">
                <summary className="cursor-pointer text-sm font-medium text-crm-danger">View {result.errors.length} errors</summary>
                <ul className="mt-2 space-y-1 text-xs text-crm-muted">
                  {result.errors.map((e: any, i: number) => (
                    <li key={i}>Row {e.row}: {e.reason}</li>
                  ))}
                </ul>
              </details>
            )}
            <div className="flex justify-end">
              <button onClick={handleDone} className={crm.btnPrimary}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function FundersPage() {
  const router = useRouter();
  const { can, backendJwtRole } = useAppContext();
  const canManage = can("can_view_crm_funders");
  const canManageFunders = can("can_view_crm_funders");

  const [funders, setFunders] = useState<Funder[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<FunderStatus | "all">("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [tags, setTags] = useState<FunderTag[]>([]);
  const [stats, setStats] = useState<FunderStats | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeIndex, setActiveIndex] = useState(0);
  const [bulkTagId, setBulkTagId] = useState("");
  const [bulkAction, setBulkAction] = useState<"assign" | "remove">("assign");
  const [bulkWorking, setBulkWorking] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showNewTag, setShowNewTag] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showBulkEmail, setShowBulkEmail] = useState(false);
  const [bulkEmailToast, setBulkEmailToast] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Funder | null>(null);
  const [deleteWorking, setDeleteWorking] = useState(false);
  const [actionToast, setActionToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const filtersButtonRef = useRef<HTMLButtonElement>(null);

  const fetchFunders = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("q", debouncedSearch);
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (tagFilter) params.set("tagId", tagFilter);
      params.set("page", String(page));
      params.set("limit", String(PAGE_LIMIT));

      const [data, statsData] = await Promise.all([
        apiGet<FundersResponse>(`/crm/funders?${params.toString()}`),
        apiGet<FunderStats>("/crm/funders/stats"),
      ]);
      setFunders(data.rows);
      setTotal(data.total);
      setStats(statsData);
    } catch {
      setFunders([]);
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, statusFilter, tagFilter, page]);

  const fetchTags = useCallback(async () => {
    try {
      const data = await apiGet<{ tags: FunderTag[] }>("/crm/funder-tags");
      setTags(data.tags);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchFunders();
  }, [fetchFunders]);

  useEffect(() => {
    fetchTags();
  }, [fetchTags]);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(0);
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [search]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const shouldUsePreviewFunders = process.env.NODE_ENV === "development" && funders.length === 0;
  const showLoadingState = loading && !shouldUsePreviewFunders;
  const sourceFunders = shouldUsePreviewFunders
    ? DEV_FUNDER_ROWS.filter((funder) => {
        const q = debouncedSearch.trim().toLowerCase();
        const matchesSearch = !q || [
          funder.name,
          funder.organization,
          funder.email,
          funder.phone,
          funder.city,
          funder.state,
        ].some((value) => value?.toLowerCase().includes(q));
        const matchesStatus = statusFilter === "all" || funder.status === statusFilter;
        const matchesTag = !tagFilter || funder.tags.some((tag) => tag.id === tagFilter);
        return matchesSearch && matchesStatus && matchesTag;
      })
    : funders;
  const displayTotal = shouldUsePreviewFunders ? sourceFunders.length : total;
  const totalPages = Math.ceil(displayTotal / PAGE_LIMIT);

  const typeOptions = Array.from(
    new Set(sourceFunders.map((f) => f.organization).filter((value): value is string => Boolean(value))),
  ).sort((a, b) => a.localeCompare(b));
  const visibleFunders = typeFilter === "all"
    ? sourceFunders
    : sourceFunders.filter((f) => (f.organization || "Other") === typeFilter);
  const activeFunder = visibleFunders[activeIndex] ?? null;

  useEffect(() => {
    setActiveIndex((index) => {
      if (visibleFunders.length === 0) return 0;
      return Math.min(index, visibleFunders.length - 1);
    });
  }, [visibleFunders.length]);

  const selectAll = () => setSelected(new Set(visibleFunders.map((f) => f.id)));
  const clearSelection = () => setSelected(new Set());

  const handleBulkTag = async () => {
    if (!bulkTagId || selected.size === 0) return;
    setBulkWorking(true);
    try {
      await apiPost("/crm/funders/bulk-tag", {
        funderIds: [...selected],
        tagId: bulkTagId,
        action: bulkAction,
      });
      await fetchFunders();
      clearSelection();
    } catch { /* ignore */ } finally {
      setBulkWorking(false);
    }
  };

  const handleDeleteFunder = async () => {
    if (!deleteTarget) return;
    setDeleteWorking(true);
    try {
      await apiDelete(`/crm/funders/${deleteTarget.id}`);
      setFunders((prev) => prev.filter((f) => f.id !== deleteTarget.id));
      setTotal((t) => Math.max(0, t - 1));
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(deleteTarget.id);
        return next;
      });
      setActionToast({ kind: "ok", text: "Funder deleted" });
      setDeleteTarget(null);
    } catch (e: any) {
      setActionToast({ kind: "err", text: e?.message ?? "Delete failed" });
    } finally {
      setDeleteWorking(false);
    }
  };

  const handleExport = () => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("q", debouncedSearch);
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (tagFilter) params.set("tagId", tagFilter);
    if (selected.size > 0) params.set("ids", [...selected].join(","));
    window.open(`/api/crm/funders/export?${params.toString()}`, "_blank");
  };

  const totalFunders = shouldUsePreviewFunders ? sourceFunders.length : stats?.total ?? total;
  const activeFunders = shouldUsePreviewFunders ? sourceFunders.filter((f) => f.status === "ACTIVE").length : stats?.active ?? 0;
  const prospectFunders = shouldUsePreviewFunders ? sourceFunders.filter((f) => f.status === "PROSPECT").length : stats?.prospects ?? 0;
  const inactiveFunders = Math.max(totalFunders - activeFunders - prospectFunders, 0);
  const selectedCount = selected.size;
  const insightTags = shouldUsePreviewFunders
    ? Array.from(
        new Map(
          sourceFunders.flatMap((funder) => funder.tags).map((tag) => [tag.id, tag]),
        ).values(),
      )
    : tags;
  const topTags = [...insightTags]
    .map((tag) => ({
      ...tag,
      count: sourceFunders.filter((f) => f.tags.some((funderTag) => funderTag.id === tag.id)).length,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const statusBreakdown = (["ACTIVE", "INACTIVE", "PROSPECT"] as FunderStatus[]).map((status) => ({
    status,
    label: STATUS_LABELS[status],
    count: status === "ACTIVE" ? activeFunders : status === "PROSPECT" ? prospectFunders : inactiveFunders,
  }));
  const donutColors: Record<string, string> = {
    ACTIVE: "#10b981",
    INACTIVE: "#cbd5e1",
    PROSPECT: "#f59e0b",
  };

  const resetInsightFilters = () => {
    setStatusFilter("all");
    setTagFilter(null);
    setPage(0);
  };

  return (
    <CRMPageShell className={cn(crm.queueWorkspace, crm.fundersWorkspace)} innerClassName={crm.pageInnerQueue}>
      <CrmConfirmModal
        open={!!deleteTarget}
        title="Delete funder?"
        description="This removes the funder from active lists. Import and tag history are preserved."
        confirmLabel="Delete"
        destructive
        loading={deleteWorking}
        onConfirm={() => void handleDeleteFunder()}
        onCancel={() => setDeleteTarget(null)}
      />

      {showBulkEmail && (
        <BulkEmailModal
          audience={{
            sourceType: "FUNDERS",
            funderIds: Array.from(selected),
            selectAll: false,
            tagId: tagFilter ?? undefined,
          }}
          onClose={() => setShowBulkEmail(false)}
          onQueued={(res) => {
            setShowBulkEmail(false);
            clearSelection();
            setBulkEmailToast(
              `Bulk email queued: ${res.queuedCount} recipients${res.skippedCount > 0 ? `, ${res.skippedCount} skipped` : ""}`,
            );
            setTimeout(() => setBulkEmailToast(null), 6000);
          }}
        />
      )}
      <CRMWorkspaceShell>
        <CRMWorkspaceChrome>
          <CRMWorkspaceHeader>
            <CRMPageHeader
              compact
              className={cn(crm.contactsHeaderPanel, "campaigns-command-header")}
              icon={<HandCoins className="h-6 w-6" aria-hidden />}
              title="Funders"
              subtitle="Manage funding sources, grant organizations, and financial partners."
              actions={
                <div className="campaigns-hero-actions">
                  <button type="button" onClick={() => setShowImport(true)} className="campaigns-btn-secondary">
                    <FileUp className="h-4 w-4" />
                    Import CSV
                  </button>
                  <button type="button" onClick={handleExport} className="campaigns-btn-secondary">
                    <Download className="h-4 w-4" />
                    Export CSV
                  </button>
                  <button type="button" onClick={() => setShowNew(true)} className="campaigns-btn-primary">
                    <Plus className="h-4 w-4" />
                    Add Funder
                  </button>
                </div>
              }
            />
          </CRMWorkspaceHeader>

          <CRMWorkspaceToolbar className="flex flex-col gap-3">
            <section
              className="crm-queue-kpi-strip grid w-full grid-cols-2 items-stretch gap-3 md:grid-cols-4 xl:grid-cols-4"
              aria-label="Funder metrics"
            >
              <FunderKpiTile
                label="Total"
                value={totalFunders}
                hint="All funders in your CRM"
                icon={Users}
                tone="blue"
                loading={showLoadingState}
              />
              <FunderKpiTile
                label="Active"
                value={activeFunders}
                hint="Currently active funders"
                icon={Activity}
                tone="green"
                loading={showLoadingState}
              />
              <FunderKpiTile
                label="Inactive"
                value={inactiveFunders}
                hint="Not currently active"
                icon={BarChart3}
                tone="cyan"
                loading={showLoadingState}
              />
              <FunderKpiTile
                label="Prospects"
                value={prospectFunders}
                hint="Potential funders"
                icon={CircleDollarSign}
                tone="amber"
                loading={showLoadingState}
              />
            </section>

            <div className="funders-filter-card crm-queue-filter-bar">
              <div className="funders-filter-grid">
                <div className="funders-search-field relative min-w-0">
                  <Search size={16} className="funders-search-icon pointer-events-none absolute text-slate-400" />
                  <input
                    className="funders-control funders-control-search"
                    placeholder="Search funders..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <ConnectSelect
                  className="funders-control"
                  size="sm"
                  value={statusFilter}
                  onChange={(value) => { setStatusFilter(value as any); setPage(0); }}
                  options={(["all", "ACTIVE", "INACTIVE", "PROSPECT", "PENDING"] as const).map((s) => ({
                    value: s,
                    label: s === "all" ? "All Status" : STATUS_LABELS[s],
                  }))}
                />
                <ConnectSelect
                  className="funders-control"
                  size="sm"
                  value={typeFilter}
                  onChange={(value) => { setTypeFilter(value); setPage(0); }}
                  options={[
                    { value: "all", label: "All Types" },
                    ...typeOptions.map((type) => ({ value: type, label: type })),
                  ]}
                />
                <ConnectSelect
                  className="funders-control"
                  size="sm"
                  value={tagFilter ?? ""}
                  onChange={(value) => { setTagFilter(value || null); setPage(0); }}
                  options={[
                    { value: "", label: "All Tags" },
                    ...tags.map((t) => ({ value: t.id, label: t.name })),
                  ]}
                />
                <button
                  ref={filtersButtonRef}
                  type="button"
                  onClick={() => setFiltersOpen((open) => !open)}
                  className={cn(
                    "funders-btn funders-btn-filter",
                    (statusFilter !== "all" || tagFilter) && "funders-filter-chip-active",
                  )}
                  aria-haspopup="dialog"
                  aria-expanded={filtersOpen}
                >
                  <SlidersHorizontal size={15} /> Filters
                </button>
              </div>
            </div>

            <ViewportDropdown
              open={filtersOpen}
              triggerRef={filtersButtonRef}
              onClose={() => setFiltersOpen(false)}
              width={360}
              sideOffset={8}
              className="funders-filter-panel contacts-filter-panel"
            >
              <div className="contacts-filter-panel-inner" role="dialog" aria-label="Funder filters">
                <div className="contacts-filter-panel-head">
                  <div>
                    <p className="text-sm font-bold text-crm-text">Filters</p>
                    <p className="text-xs text-crm-muted">Status mix and top tags</p>
                  </div>
                  <button type="button" onClick={resetInsightFilters} className="contacts-filter-reset">
                    Reset
                  </button>
                </div>
                <div className="funders-filter-insight-group">
                  <span className="funders-filter-insight-label">Status Mix</span>
                  <div className="funders-filter-chip-row">
                    {statusBreakdown.map((item) => (
                      <button
                        type="button"
                        key={item.status}
                        onClick={() => { setStatusFilter(statusFilter === item.status ? "all" : item.status); setPage(0); }}
                        className={cn("funders-filter-chip", statusFilter === item.status && "funders-filter-chip-active")}
                      >
                        <span className="funders-filter-chip-dot" style={{ background: donutColors[item.status] }} />
                        {item.label}
                        <strong>{item.count}</strong>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="funders-filter-insight-group funders-filter-insight-group-tags">
                  <span className="funders-filter-insight-label">Top Tags</span>
                  <div className="funders-filter-chip-row">
                    {topTags.length === 0 ? (
                      <button
                        type="button"
                        onClick={() => { setShowNewTag(true); setFiltersOpen(false); }}
                        className="funders-filter-chip"
                      >
                        <Plus size={13} /> New tag
                      </button>
                    ) : topTags.map((tag) => (
                      <button
                        key={tag.id}
                        type="button"
                        onClick={() => { setTagFilter(tagFilter === tag.id ? null : tag.id); setPage(0); }}
                        className={cn("funders-filter-chip", tagFilter === tag.id && "funders-filter-chip-active")}
                      >
                        <span className="funders-filter-chip-dot" style={{ background: tag.color || "#7c3aed" }} />
                        {tag.name}
                        <strong>{tag.count}</strong>
                      </button>
                    ))}
                    {topTags.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => { setShowNewTag(true); setFiltersOpen(false); }}
                        className="funders-filter-chip funders-filter-chip-ghost"
                      >
                        <Plus size={13} /> New tag
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            </ViewportDropdown>

            {bulkEmailToast && (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
                {bulkEmailToast}
              </div>
            )}
            {actionToast && (
              <div
                className={cn(
                  "rounded-2xl border px-4 py-3 text-sm font-semibold",
                  actionToast.kind === "ok"
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-red-200 bg-red-50 text-red-700",
                )}
              >
                {actionToast.text}
              </div>
            )}

            {selectedCount > 0 && (
              <div className="funders-bulk-toolbar">
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-sm font-semibold text-slate-800">{selectedCount} selected</span>
                  <button onClick={clearSelection} className="rounded-full p-1 text-slate-400 transition hover:bg-white hover:text-slate-700">
                    <X size={14} />
                  </button>
                </div>
                <div className="funders-bulk-actions">
                  <button
                    type="button"
                    onClick={() => setShowBulkEmail(true)}
                    className="funders-bulk-action"
                  >
                    <Mail size={14} /> Send Email
                  </button>
                  <ConnectSelect
                    className="funders-bulk-select"
                    size="sm"
                    value={bulkTagId}
                    onChange={(value) => setBulkTagId(value)}
                    placeholder="Add Tag"
                    options={tags.map((t) => ({ value: t.id, label: t.name }))}
                  />
                  <ConnectSelect
                    className="funders-bulk-select"
                    size="sm"
                    value={bulkAction}
                    onChange={(value) => setBulkAction(value as any)}
                    options={[
                      { value: "assign", label: "Assign" },
                      { value: "remove", label: "Remove" },
                    ]}
                  />
                  <button
                    onClick={handleBulkTag}
                    disabled={!bulkTagId || bulkWorking}
                    className="funders-bulk-action"
                  >
                    <Tag size={14} /> {bulkWorking ? "Working..." : "Apply"}
                  </button>
                  <button
                    onClick={handleExport}
                    className="funders-bulk-action"
                  >
                    <Download size={14} /> Export
                  </button>
                </div>
              </div>
            )}
          </CRMWorkspaceToolbar>
        </CRMWorkspaceChrome>

        <CRMWorkspaceBody split={visibleFunders.length > 0}>
          <CRMWorkspaceMain className="crm-queue-main-workspace">
            <CRMWorkspaceScrollRegion className="crm-queue-center-workspace flex min-w-0 flex-col gap-3">
              {showLoadingState ? (
                <div className="py-24 text-center text-sm text-crm-muted/80" aria-busy="true">
                  Loading funders...
                </div>
              ) : visibleFunders.length === 0 ? (
                <div className="crm-queue-list-panel px-6 py-14 text-center">
                  <HandCoins className="mx-auto mb-3 h-10 w-10 text-crm-border" aria-hidden />
                  <p className="text-lg font-semibold text-crm-text">No funders found</p>
                  <p className="mx-auto mt-2 max-w-md text-sm text-crm-muted">
                    {search || statusFilter !== "all" || tagFilter || typeFilter !== "all"
                      ? "Try adjusting your filters."
                      : "Add your first funder to get started."}
                  </p>
                  {!search && statusFilter === "all" && !tagFilter && typeFilter === "all" ? (
                    <button type="button" onClick={() => setShowNew(true)} className="campaigns-btn-primary mx-auto mt-6">
                      <Plus className="h-4 w-4" /> Add Funder
                    </button>
                  ) : null}
                </div>
              ) : (
                <>
                  <div className="crm-funder-list-controls-card">
                    <div className="crm-queue-list-head">
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-crm-muted">
                        <input
                          type="checkbox"
                          className={crm.checkbox}
                          checked={visibleFunders.length > 0 && visibleFunders.every((f) => selected.has(f.id))}
                          onChange={() => visibleFunders.length > 0 && visibleFunders.every((f) => selected.has(f.id)) ? clearSelection() : selectAll()}
                          title="Select all visible funders"
                        />
                        <span>Select active on this page</span>
                      </label>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-semibold text-crm-muted tabular-nums">
                          {visibleFunders.length} shown · {displayTotal} total
                        </span>
                        <button type="button" onClick={() => setShowNewTag(true)} className="funders-mini-action">
                          <Plus size={13} /> New Tag
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="crm-queue-list-panel crm-funder-list-rows-card">
                    <div className="crm-queue-row-list">
                      {visibleFunders.map((f, index) => {
                        const location = [f.city, f.state].filter(Boolean).join(", ");
                        return (
                          <div
                            key={f.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => setActiveIndex(index)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setActiveIndex(index);
                            }
                          }}
                          className={cn("crm-queue-row crm-contact-row crm-funder-row group", activeFunder?.id === f.id && "crm-queue-row-selected")}
                        >
                          <div className="crm-queue-row-grid">
                            <label
                              className="crm-contact-row-check"
                              onClick={(e) => e.stopPropagation()}
                              aria-label={`Select ${f.name}`}
                            >
                              <input
                                type="checkbox"
                                checked={selected.has(f.id)}
                                onChange={() => toggleSelect(f.id)}
                              />
                            </label>
                            <span className="crm-queue-row-rank tabular-nums">{page * PAGE_LIMIT + index + 1}</span>
                            <div
                              className="crm-queue-row-avatar funders-avatar"
                              style={{ background: avatarGradient(f.id ?? f.name) }}
                              aria-hidden
                            >
                              {initials(f.name)}
                            </div>
                            <div className="crm-queue-row-main min-w-0">
                              <div className="crm-queue-row-title-line">
                                <span className="crm-queue-row-name truncate">{f.name}</span>
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); setStatusFilter(f.status); setPage(0); }}
                                  className={cn("funders-status-pill", `funders-status-${f.status.toLowerCase()}`)}
                                >
                                  {STATUS_LABELS[f.status]}
                                </button>
                                {f.tags.slice(0, 2).map((tag) => (
                                  <button
                                    type="button"
                                    key={tag.id}
                                    onClick={(e) => { e.stopPropagation(); setTagFilter(tagFilter === tag.id ? null : tag.id); setPage(0); }}
                                    className="funders-tag-pill"
                                    style={tag.color ? { borderColor: `${tag.color}40`, color: tag.color, background: `${tag.color}12` } : undefined}
                                  >
                                    {tag.name}
                                  </button>
                                ))}
                                {f.tags.length > 2 ? <span className="funders-tag-pill">+{f.tags.length - 2}</span> : null}
                              </div>
                              <p className="crm-queue-row-sub truncate">
                                {f.organization || "Other"}
                                {location ? ` · ${location}` : ""}
                              </p>
                            </div>
                            <div className="crm-queue-row-phone hidden md:flex">
                              <Phone className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate font-mono">{f.phone || "No phone"}</span>
                            </div>
                            <div className="crm-queue-row-email hidden lg:flex">
                              <Mail className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate">{f.email || "No email"}</span>
                            </div>
                            <div className="crm-queue-row-meta hidden xl:flex">
                              <span className="crm-queue-pill crm-queue-pill-muted inline-flex items-center gap-0.5">
                                <Clock className="h-3 w-3" />
                                {formatShortDate(f.createdAt)}
                              </span>
                            </div>
                            <span className={cn("crm-queue-row-status funders-status-pill shrink-0", `funders-status-${f.status.toLowerCase()}`)}>
                              {STATUS_LABELS[f.status]}
                            </span>
                            <ChevronRight className="crm-queue-row-chevron h-4 w-4 shrink-0" />
                          </div>
                        </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </CRMWorkspaceScrollRegion>

            {totalPages > 1 && (
              <div className="funders-pagination">
                <span>
                  Showing {page * PAGE_LIMIT + 1} to {Math.min((page + 1) * PAGE_LIMIT, displayTotal)} of {displayTotal} funders
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="funders-page-button"
                  >
                    <ChevronLeft size={15} />
                  </button>
                  <span className="px-2 text-sm font-semibold text-slate-700">{page + 1} / {totalPages}</span>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                    className="funders-page-button"
                  >
                    <ChevronRight size={15} />
                  </button>
                </div>
              </div>
            )}
          </CRMWorkspaceMain>
          {visibleFunders.length > 0 ? (
            <CRMWorkspaceRightRail className="crm-queue-right-rail crm-queue-detail-rail flex flex-col min-h-0">
              {activeFunder ? (
                <FunderListDetailPanel
                  funder={activeFunder}
                  rank={activeIndex + 1}
                  total={visibleFunders.length}
                  canGoPrevious={activeIndex > 0}
                  canGoNext={activeIndex < visibleFunders.length - 1}
                  onPrevious={() => setActiveIndex((i) => Math.max(0, i - 1))}
                  onNext={() => setActiveIndex((i) => Math.min(visibleFunders.length - 1, i + 1))}
                  onOpen={() => router.push(`/crm/funders/${activeFunder.id}`)}
                  onOpenWorkspace={(tab = "timeline") => router.push(`/crm/funders/${activeFunder.id}/workspace?tab=${tab}`)}
                  onEdit={!activeFunder.archivedAt && activeFunder.active !== false ? () => router.push(`/crm/funders/${activeFunder.id}?edit=1`) : undefined}
                  onDelete={canManageFunders && !activeFunder.archivedAt && activeFunder.active !== false ? () => setDeleteTarget(activeFunder) : undefined}
                />
              ) : (
                <FunderListDetailPlaceholder />
              )}
            </CRMWorkspaceRightRail>
          ) : null}
        </CRMWorkspaceBody>
      </CRMWorkspaceShell>

      {/* ── Modals ───────────────────────────────────────────────────────────── */}
      <NewFunderModal
        open={showNew}
        tags={tags}
        onClose={() => setShowNew(false)}
        onCreated={() => { setShowNew(false); void fetchFunders(); void fetchTags(); }}
      />
      <NewTagModal
        open={showNewTag}
        onClose={() => setShowNewTag(false)}
        onCreated={(t) => { setTags((prev) => [...prev, t].sort((a, b) => a.name.localeCompare(b.name))); setShowNewTag(false); }}
      />
      <ImportModal open={showImport} onClose={() => setShowImport(false)} onImported={fetchFunders} />
    </CRMPageShell>
  );
}
