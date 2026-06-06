"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  Building2,
  ChevronDown,
  HandCoins,
  Mail,
  MessageSquareDot,
  MoreHorizontal,
  NotebookPen,
  Phone,
  Plus,
  Save,
  Send,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import {
  CRMCard,
  CRMPageHeader,
  CRMWorkspaceBody,
  CRMWorkspaceChrome,
  CRMWorkspaceHeader,
  CRMWorkspaceMain,
  CRMWorkspaceRightRail,
  CRMWorkspaceScrollRegion,
  CRMWorkspaceShell,
  CRMWorkspaceToolbar,
  crm,
  cn,
} from "../../../../../components/crm";
import { ConnectSelect } from "../../../../../components/ConnectSelect";
import { apiGet, apiPost, apiPatch, apiDelete } from "../../../../../services/apiClient";
import { CrmConfirmModal } from "../../../../../components/crm/CrmConfirmModal";
import { useAppContext } from "../../../../../hooks/useAppContext";
import { isSmsTextOverLimit, SmsCharCounter } from "../../../../../components/chat/SmsCharCounter";

// ── Types ──────────────────────────────────────────────────────────────────────

type FunderStatus = "ACTIVE" | "INACTIVE" | "PROSPECT" | "PENDING";

type FunderTag = {
  id: string;
  name: string;
  color?: string | null;
};

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

type FunderWorkspaceTab = "timeline" | "sms" | "email" | "notes";

type FunderTimelineEvent = {
  id: string;
  type: string;
  title: string;
  body?: string | null;
  metadata?: Record<string, unknown> | null;
  linkedId?: string | null;
  createdAt: string;
  createdBy?: { id: string; displayName: string } | null;
};

// ── Constants ──────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<FunderStatus, string> = {
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
  return name.split(" ").map((p) => p[0]).filter(Boolean).join("").slice(0, 2).toUpperCase();
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch { return "—"; }
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FunderDetailPage() {
  const params = useParams();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { backendJwtRole, can } = useAppContext();
  const id = params?.id as string;
  const isWorkspaceRoute = pathname?.includes(`/crm/funders/${id}/workspace`) ?? false;

  const canManageFunders = can("can_view_crm_funders");

  const [funder, setFunder] = useState<Funder | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [allTags, setAllTags] = useState<FunderTag[]>([]);

  // Edit mode state
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Funder & { tagIds: string[] }>>({});
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // Tag assign panel
  const [showTagPanel, setShowTagPanel] = useState(false);
  const [tagWorking, setTagWorking] = useState(false);

  // Archive / delete
  const [confirming, setConfirming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<FunderWorkspaceTab>("timeline");
  const [timeline, setTimeline] = useState<FunderTimelineEvent[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [smsBody, setSmsBody] = useState("");
  const [smsSending, setSmsSending] = useState(false);
  const [smsError, setSmsError] = useState<string | null>(null);
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [emailSending, setEmailSending] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [noteBody, setNoteBody] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  const fetchFunder = useCallback(async () => {
    setLoading(true);
    setNotFound(false);
    try {
      const data = await apiGet<Funder>(`/crm/funders/${id}`);
      setFunder(data);
    } catch (e: any) {
      const previewFunder = process.env.NODE_ENV === "development"
        ? DEV_FUNDER_ROWS.find((row) => row.id === id)
        : null;
      if (previewFunder) {
        setFunder(previewFunder);
        return;
      }
      if (e?.status === 404 || e?.message?.includes("404")) setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  const fetchAllTags = useCallback(async () => {
    try {
      const data = await apiGet<{ tags: FunderTag[] }>("/crm/funder-tags");
      setAllTags(data.tags);
    } catch { /* ignore */ }
  }, []);

  const fetchTimeline = useCallback(async () => {
    if (process.env.NODE_ENV === "development" && id.startsWith("dev-funder-")) {
      setTimeline([]);
      setTimelineError(null);
      return;
    }
    setTimelineLoading(true);
    setTimelineError(null);
    try {
      const data = await apiGet<{ events: FunderTimelineEvent[] }>(`/crm/funders/${id}/timeline`);
      setTimeline(data.events ?? []);
    } catch (e: any) {
      setTimelineError(e?.message || "Failed to load funder timeline");
    } finally {
      setTimelineLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchFunder(); fetchAllTags(); }, [fetchFunder, fetchAllTags]);

  useEffect(() => {
    if (isWorkspaceRoute || searchParams.get("workspace") === "1") setWorkspaceOpen(true);
    const tab = searchParams.get("tab");
    if (tab === "sms" || tab === "email" || tab === "notes" || tab === "timeline") {
      setWorkspaceTab(tab);
      setWorkspaceOpen(true);
    }
  }, [isWorkspaceRoute, searchParams]);

  useEffect(() => {
    if (workspaceOpen) void fetchTimeline();
  }, [workspaceOpen, fetchTimeline]);

  const startEdit = () => {
    if (!funder) return;
    setForm({
      name: funder.name,
      organization: funder.organization ?? "",
      email: funder.email ?? "",
      phone: funder.phone ?? "",
      phone2: funder.phone2 ?? "",
      city: funder.city ?? "",
      state: funder.state ?? "",
      zip: funder.zip ?? "",
      notes: funder.notes ?? "",
      status: funder.status,
    });
    setSaveErr(null);
    setEditing(true);
  };

  useEffect(() => {
    if (searchParams.get("edit") === "1" && funder && !editing) {
      startEdit();
    }
  }, [searchParams, funder?.id, editing]);

  const handleSave = async () => {
    if (!form.name?.trim()) { setSaveErr("Name is required"); return; }
    setSaving(true); setSaveErr(null);
    try {
      const patch: Record<string, unknown> = {};
      if (form.name !== undefined) patch.name = form.name.trim();
      if ("organization" in form) patch.organization = form.organization || null;
      if ("email" in form) patch.email = form.email || null;
      if ("phone" in form) patch.phone = form.phone || null;
      if ("phone2" in form) patch.phone2 = form.phone2 || null;
      if ("city" in form) patch.city = form.city || null;
      if ("state" in form) patch.state = form.state || null;
      if ("zip" in form) patch.zip = form.zip || null;
      if ("notes" in form) patch.notes = form.notes || null;
      if (form.status) patch.status = form.status;

      const updated = await apiPatch<Funder>(`/crm/funders/${id}`, patch);
      setFunder(updated);
      setEditing(false);
      setToast({ kind: "ok", text: "Funder saved" });
    } catch (e: any) {
      setSaveErr(e?.message ?? "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleTagAssign = async (tagId: string, action: "assign" | "remove") => {
    if (!funder) return;
    setTagWorking(true);
    try {
      if (action === "assign") {
        await apiPost(`/crm/funders/${id}/tags`, { tagId });
      } else {
        await apiDelete(`/crm/funders/${id}/tags/${tagId}`);
      }
      await fetchFunder();
    } catch { /* ignore */ } finally {
      setTagWorking(false);
    }
  };

  const handleDelete = async () => {
    setArchiving(true);
    try {
      await apiDelete(`/crm/funders/${id}`);
      setToast({ kind: "ok", text: "Funder deleted" });
      router.push("/crm/funders");
    } catch (e: any) {
      setToast({ kind: "err", text: e?.message ?? "Delete failed" });
    } finally {
      setArchiving(false);
      setConfirming(false);
    }
  };

  const openWorkspace = (tab: FunderWorkspaceTab = "timeline") => {
    setWorkspaceTab(tab);
    setWorkspaceOpen(true);
    router.push(`/crm/funders/${id}/workspace?tab=${tab}`);
  };

  const handleSendSms = async () => {
    if (!smsBody.trim() || !funder?.phone || smsSending || isSmsTextOverLimit(smsBody)) return;
    setSmsSending(true);
    setSmsError(null);
    try {
      await apiPost(`/crm/funders/${id}/sms`, { message: smsBody.trim(), phone: funder.phone });
      setSmsBody("");
      setToast({ kind: "ok", text: "SMS queued" });
      await fetchTimeline();
    } catch (e: any) {
      setSmsError(e?.message || "Failed to send SMS");
    } finally {
      setSmsSending(false);
    }
  };

  const handleSendEmail = async () => {
    if (!emailSubject.trim() || !emailBody.trim() || !funder?.email || emailSending) return;
    setEmailSending(true);
    setEmailError(null);
    try {
      await apiPost("/crm/email/send", {
        funderId: id,
        toEmail: funder.email,
        subject: emailSubject.trim(),
        bodyText: emailBody.trim(),
      });
      setEmailSubject("");
      setEmailBody("");
      setToast({ kind: "ok", text: "Email queued" });
      await fetchTimeline();
    } catch (e: any) {
      setEmailError(e?.message || "Failed to send email");
    } finally {
      setEmailSending(false);
    }
  };

  const handleSaveNote = async () => {
    if (!noteBody.trim() || noteSaving) return;
    setNoteSaving(true);
    setNoteError(null);
    try {
      await apiPost(`/crm/funders/${id}/notes`, { body: noteBody.trim() });
      setNoteBody("");
      await fetchTimeline();
    } catch (e: any) {
      setNoteError(e?.message || "Failed to save note");
    } finally {
      setNoteSaving(false);
    }
  };

  if (loading) {
    return (
      <div className={crm.fundersWorkspace}>
        <div className={crm.pageInnerFunders + " p-8 text-center"}>
          <span className={crm.muted}>Loading…</span>
        </div>
      </div>
    );
  }

  if (notFound || !funder) {
    return (
      <div className={crm.fundersWorkspace}>
        <div className={cn(crm.pageInnerFunders, "p-8 text-center")}>
          <p className={crm.emptyTitle}>Funder not found</p>
          <Link href="/crm/funders" className={cn(crm.btnSecondary, "mt-4 inline-flex")}>
            <ArrowLeft size={14} /> Back to Funders
          </Link>
        </div>
      </div>
    );
  }

  const assignedTagIds = new Set(funder.tags.map((t) => t.id));

  const fieldEl = (
    label: string,
    key: keyof typeof form,
    opts?: { type?: string; multiline?: boolean }
  ) => {
    const val = (form[key] as string) ?? "";
    return (
      <div>
        <label className={crm.label}>{label}</label>
        {opts?.multiline ? (
          <textarea
            className={cn(crm.input, "mt-1 min-h-[80px] resize-y")}
            value={val}
            onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
          />
        ) : (
          <input
            type={opts?.type ?? "text"}
            className={cn(crm.input, "mt-1")}
            value={val}
            onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
          />
        )}
      </div>
    );
  };

  const workspaceTabs: Array<{ id: FunderWorkspaceTab; label: string; icon: typeof Activity }> = [
    { id: "timeline", label: "Timeline", icon: Activity },
    { id: "sms", label: "SMS", icon: MessageSquareDot },
    { id: "email", label: "Email", icon: Mail },
    { id: "notes", label: "Notes", icon: NotebookPen },
  ];

  const funderLocation = [funder.city, funder.state, funder.zip].filter(Boolean).join(", ");

  if (isWorkspaceRoute) {
    return (
      <CRMWorkspaceShell className={crm.fundersWorkspace}>
        <CRMWorkspaceChrome>
          <CRMWorkspaceHeader>
            <CRMPageHeader
              compact
              icon={<HandCoins className="h-5 w-5" />}
              title={funder.name}
              subtitle={[
                "Funder Workspace",
                funder.organization || "Funding partner",
                funderLocation,
                `Status: ${STATUS_LABELS[funder.status]}`,
              ].filter(Boolean).join(" · ")}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/crm/funders/${id}`} className={crm.btnSecondary}>
                    <ArrowLeft size={14} /> Profile
                  </Link>
                  <button
                    type="button"
                    onClick={() => funder.phone && window.dispatchEvent(new CustomEvent("crm:dial", { detail: { target: funder.phone } }))}
                    disabled={!funder.phone}
                    className={crm.btnSecondary}
                  >
                    <Phone size={14} /> Call
                  </button>
                </div>
              }
            />
          </CRMWorkspaceHeader>

          <CRMWorkspaceToolbar className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { label: "Primary phone", value: funder.phone || "No phone", icon: Phone },
                { label: "Primary email", value: funder.email || "No email", icon: Mail },
                { label: "Activity", value: timelineLoading ? "Loading..." : `${timeline.length} events`, icon: Activity },
                { label: "Tags", value: `${funder.tags.length} assigned`, icon: Tag },
              ].map(({ label, value, icon: Icon }) => (
                <div key={label} className="rounded-crm-lg border border-crm-border bg-crm-surface px-3.5 py-3 shadow-crm">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-crm-muted">{label}</p>
                      <p className="mt-1 truncate text-sm font-semibold text-crm-text">{value}</p>
                    </div>
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-crm border border-crm-accent/25 bg-crm-accent/10 text-crm-accent">
                      <Icon className="h-4 w-4" />
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2 rounded-crm-lg border border-crm-border bg-crm-surface p-2 shadow-crm">
              {workspaceTabs.map(({ id: tabId, label, icon: Icon }) => (
                <button
                  key={tabId}
                  type="button"
                  onClick={() => openWorkspace(tabId)}
                  className={cn(
                    "inline-flex items-center justify-center gap-2 rounded-crm border px-3 py-2 text-sm font-semibold transition-colors",
                    workspaceTab === tabId
                      ? "border-crm-accent/45 bg-crm-accent text-white shadow-[0_10px_26px_-14px_rgba(56,189,248,0.75)]"
                      : "border-transparent bg-transparent text-crm-muted hover:border-crm-border hover:bg-crm-surface-2 hover:text-crm-text",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </div>
          </CRMWorkspaceToolbar>
        </CRMWorkspaceChrome>

        <CRMWorkspaceBody split>
          <CRMWorkspaceMain>
            <CRMWorkspaceScrollRegion className="p-0">
              <section className="rounded-crm-lg border border-crm-border bg-crm-surface shadow-crm">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-crm-border/70 px-4 py-3 sm:px-5">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-crm-accent">{workspaceTab}</p>
                    <h2 className="mt-1 text-lg font-bold text-crm-text">
                      {workspaceTab === "timeline"
                        ? "Activity timeline"
                        : workspaceTab === "sms"
                          ? "Send SMS"
                          : workspaceTab === "email"
                            ? "Send email"
                            : "Workspace note"}
                    </h2>
                    <p className="mt-1 text-sm text-crm-muted">
                      {workspaceTab === "timeline"
                        ? "Track funder calls, notes, SMS, and email activity in one place."
                        : workspaceTab === "sms"
                          ? "Send a text message to the funder's primary phone."
                          : workspaceTab === "email"
                            ? "Queue a CRM email and mirror it to this funder timeline."
                            : "Capture internal context without adding this funder to contacts."}
                    </p>
                  </div>
                  {workspaceTab === "timeline" ? (
                    <button type="button" onClick={() => void fetchTimeline()} className={cn(crm.btnSecondary, "px-3 py-1.5 text-xs")}>
                      Refresh
                    </button>
                  ) : null}
                </div>

                <div className="p-4 sm:p-5">
                  {workspaceTab === "timeline" ? (
                    <div className="flex flex-col gap-3">
                      {timelineLoading ? <p className={crm.muted}>Loading activity...</p> : null}
                      {timelineError ? <p className="text-sm text-crm-danger">{timelineError}</p> : null}
                      {!timelineLoading && timeline.length === 0 ? (
                        <div className="rounded-crm-lg border border-dashed border-crm-border bg-crm-surface-2/45 p-5">
                          <p className="text-sm font-semibold text-crm-text">No funder activity yet</p>
                          <p className="mt-1 text-sm text-crm-muted">
                            Send an SMS, queue an email, or add a note to start this workspace timeline.
                          </p>
                        </div>
                      ) : null}
                      {timeline.map((event) => (
                        <div key={event.id} className="rounded-crm border border-crm-border/75 bg-crm-surface-2/45 p-3.5">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <p className="text-sm font-bold text-crm-text">{event.title}</p>
                              <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-crm-muted">{event.type.replaceAll("_", " ")}</p>
                            </div>
                            <span className="text-xs text-crm-muted">{formatDate(event.createdAt)}</span>
                          </div>
                          {event.body ? <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-crm-text">{event.body}</p> : null}
                          {event.createdBy ? <p className="mt-2 text-xs text-crm-muted">By {event.createdBy.displayName}</p> : null}
                        </div>
                      ))}
                    </div>
                  ) : workspaceTab === "sms" ? (
                    <div className="grid max-w-3xl gap-3">
                      <p className="text-sm text-crm-muted">
                        {funder.phone ? `Texting ${funder.phone}.` : "Add a phone number before sending SMS."}
                      </p>
                      <textarea
                        value={smsBody}
                        onChange={(e) => setSmsBody(e.target.value)}
                        rows={6}
                        disabled={!funder.phone}
                        placeholder="Type SMS message..."
                        className={cn(crm.input, "min-h-[10rem] resize-y")}
                      />
                      <div className="rounded-crm border border-crm-border/70 bg-crm-surface-2/45 px-3 py-2 text-xs text-crm-muted">
                        <SmsCharCounter text={smsBody} />
                      </div>
                      {smsError ? <p className="text-sm text-crm-danger">{smsError}</p> : null}
                      <div>
                        <button
                          type="button"
                          onClick={() => void handleSendSms()}
                          disabled={!funder.phone || !smsBody.trim() || smsSending || isSmsTextOverLimit(smsBody)}
                          className={crm.btnPrimary}
                        >
                          <Send size={14} /> {smsSending ? "Sending..." : "Send SMS"}
                        </button>
                      </div>
                    </div>
                  ) : workspaceTab === "email" ? (
                    <div className="grid max-w-4xl gap-3">
                      <p className="text-sm text-crm-muted">
                        {funder.email ? `Emailing ${funder.email}.` : "Add an email address before sending email."}
                      </p>
                      <input
                        value={emailSubject}
                        onChange={(e) => setEmailSubject(e.target.value)}
                        disabled={!funder.email}
                        placeholder="Subject"
                        className={crm.input}
                      />
                      <textarea
                        value={emailBody}
                        onChange={(e) => setEmailBody(e.target.value)}
                        rows={10}
                        disabled={!funder.email}
                        placeholder="Write email..."
                        className={cn(crm.input, "min-h-[16rem] resize-y")}
                      />
                      {emailError ? <p className="text-sm text-crm-danger">{emailError}</p> : null}
                      <div>
                        <button
                          type="button"
                          onClick={() => void handleSendEmail()}
                          disabled={!funder.email || !emailSubject.trim() || !emailBody.trim() || emailSending}
                          className={crm.btnPrimary}
                        >
                          <Send size={14} /> {emailSending ? "Queueing..." : "Send Email"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="grid max-w-3xl gap-3">
                      <textarea
                        value={noteBody}
                        onChange={(e) => setNoteBody(e.target.value)}
                        rows={8}
                        placeholder="Add a funder note..."
                        className={cn(crm.input, "min-h-[14rem] resize-y")}
                      />
                      {noteError ? <p className="text-sm text-crm-danger">{noteError}</p> : null}
                      <div>
                        <button
                          type="button"
                          onClick={() => void handleSaveNote()}
                          disabled={!noteBody.trim() || noteSaving}
                          className={crm.btnPrimary}
                        >
                          <Save size={14} /> {noteSaving ? "Saving..." : "Save Note"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            </CRMWorkspaceScrollRegion>
          </CRMWorkspaceMain>

          <CRMWorkspaceRightRail>
            <div className="flex flex-col gap-3">
              <section className="rounded-crm-lg border border-crm-border bg-crm-surface p-4 shadow-crm">
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-crm-lg bg-crm-accent/15 text-base font-bold text-crm-accent">
                    {initials(funder.name)}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-crm-text">{funder.name}</p>
                    <p className="truncate text-xs text-crm-muted">{funder.organization || "Funder"}</p>
                  </div>
                </div>
                <div className="mt-4 grid gap-2 text-sm">
                  <div className="flex justify-between gap-3">
                    <span className={crm.muted}>Status</span>
                    <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", STATUS_COLORS[funder.status])}>
                      {STATUS_LABELS[funder.status]}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className={crm.muted}>Phone</span>
                    <span className="truncate text-crm-text">{funder.phone || "None"}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className={crm.muted}>Email</span>
                    <span className="truncate text-crm-text">{funder.email || "None"}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className={crm.muted}>Location</span>
                    <span className="truncate text-crm-text">{funderLocation || "Unknown"}</span>
                  </div>
                </div>
              </section>

              <section className="rounded-crm-lg border border-crm-border bg-crm-surface p-4 shadow-crm">
                <p className={crm.label}>Workspace Actions</p>
                <div className="mt-3 grid gap-2">
                  <button type="button" onClick={() => openWorkspace("sms")} disabled={!funder.phone} className={cn(crm.btnSecondary, "justify-start")}>
                    <MessageSquareDot size={14} /> SMS
                  </button>
                  <button type="button" onClick={() => openWorkspace("email")} disabled={!funder.email} className={cn(crm.btnSecondary, "justify-start")}>
                    <Mail size={14} /> Email
                  </button>
                  <button type="button" onClick={() => openWorkspace("notes")} className={cn(crm.btnSecondary, "justify-start")}>
                    <NotebookPen size={14} /> Note
                  </button>
                </div>
              </section>

              {funder.tags.length > 0 ? (
                <section className="rounded-crm-lg border border-crm-border bg-crm-surface p-4 shadow-crm">
                  <p className={crm.label}>Tags</p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {funder.tags.map((tag) => (
                      <span
                        key={tag.id}
                        className="rounded-full border px-2.5 py-1 text-xs font-semibold"
                        style={tag.color ? { borderColor: `${tag.color}55`, color: tag.color, background: `${tag.color}18` } : undefined}
                      >
                        {tag.name}
                      </span>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          </CRMWorkspaceRightRail>
        </CRMWorkspaceBody>
      </CRMWorkspaceShell>
    );
  }

  return (
    <div className={crm.fundersWorkspace}>
      <div className={crm.pageInnerFunders}>
        {/* Back nav */}
        <div>
          <Link href="/crm/funders" className={cn(crm.btnGhost, "inline-flex text-sm")}>
            <ArrowLeft size={14} /> Back to Funders
          </Link>
        </div>

        {/* Header */}
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-crm-lg bg-crm-accent/15 text-xl font-bold text-crm-accent">
            {initials(funder.name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className={crm.title}>{funder.name}</h1>
              <span className={cn("rounded-full border px-2.5 py-0.5 text-xs font-medium", STATUS_COLORS[funder.status])}>
                {STATUS_LABELS[funder.status]}
              </span>
            </div>
            {funder.organization && (
              <div className="mt-1 flex items-center gap-1.5 text-sm text-crm-muted">
                <Building2 size={13} />{funder.organization}
              </div>
            )}
            {funder.tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {funder.tags.map((t) => (
                  <span
                    key={t.id}
                    className="rounded-full border px-2.5 py-0.5 text-xs font-medium"
                    style={t.color ? { borderColor: `${t.color}55`, color: t.color, background: `${t.color}18` } : {}}
                  >
                    {t.name}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {!editing && (
              <>
                <button onClick={() => openWorkspace("timeline")} className={crm.btnPrimary}>
                  <Activity size={14} /> Open Workspace
                </button>
                <button onClick={startEdit} className={crm.btnPrimary}>Edit</button>
                <button onClick={() => setShowTagPanel(!showTagPanel)} className={crm.btnSecondary}>
                  <Tag size={14} /> Tags
                </button>
                {canManageFunders ? (
                  <button onClick={() => setConfirming(true)} className={crm.btnDanger}>
                    <Trash2 size={14} /> Delete
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>

        {workspaceOpen ? (
          <CRMCard className="p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-crm-border/60 pb-4">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-crm-accent">Funder Workspace</p>
                <h2 className="mt-1 text-xl font-bold text-crm-text">{funder.name}</h2>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {workspaceTabs.map(({ id: tabId, label, icon: Icon }) => (
                  <button
                    key={tabId}
                    type="button"
                    onClick={() => openWorkspace(tabId)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-bold transition-colors",
                      workspaceTab === tabId
                        ? "border-crm-accent/35 bg-crm-accent/10 text-crm-accent"
                        : "border-crm-border bg-crm-surface-2 text-crm-muted hover:text-crm-text",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setWorkspaceOpen(false);
                    if (isWorkspaceRoute) router.push(`/crm/funders/${id}`);
                  }}
                  className={cn(crm.btnGhost, "px-2 py-1.5")}
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            {workspaceTab === "timeline" ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <p className={crm.label}>Activity Timeline</p>
                  <button type="button" onClick={() => void fetchTimeline()} className={cn(crm.btnSecondary, "px-3 py-1.5 text-xs")}>
                    Refresh
                  </button>
                </div>
                {timelineLoading ? <p className={crm.muted}>Loading activity...</p> : null}
                {timelineError ? <p className="text-sm text-crm-danger">{timelineError}</p> : null}
                {!timelineLoading && timeline.length === 0 ? (
                  <div className="rounded-crm border border-dashed border-crm-border bg-crm-surface-2/40 p-4 text-sm text-crm-muted">
                    No funder activity yet. Send an SMS, queue an email, or add a note to start the workspace timeline.
                  </div>
                ) : null}
                {timeline.map((event) => (
                  <div key={event.id} className="rounded-crm border border-crm-border/70 bg-crm-surface-2/45 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-bold text-crm-text">{event.title}</p>
                        <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-crm-muted">{event.type.replaceAll("_", " ")}</p>
                      </div>
                      <span className="text-xs text-crm-muted">{formatDate(event.createdAt)}</span>
                    </div>
                    {event.body ? <p className="mt-2 whitespace-pre-wrap text-sm text-crm-text">{event.body}</p> : null}
                    {event.createdBy ? <p className="mt-2 text-xs text-crm-muted">By {event.createdBy.displayName}</p> : null}
                  </div>
                ))}
              </div>
            ) : workspaceTab === "sms" ? (
              <div className="grid gap-3">
                <div>
                  <p className={crm.label}>SMS</p>
                  <p className="mt-1 text-sm text-crm-muted">
                    {funder.phone ? `Send to ${funder.phone}.` : "Add a phone number before sending SMS."}
                  </p>
                </div>
                <textarea
                  value={smsBody}
                  onChange={(e) => setSmsBody(e.target.value)}
                  rows={4}
                  disabled={!funder.phone}
                  placeholder="Type SMS message..."
                  className={cn(crm.input, "min-h-[7rem] resize-y")}
                />
                <div className="text-xs text-crm-muted">
                  <SmsCharCounter text={smsBody} />
                </div>
                {smsError ? <p className="text-sm text-crm-danger">{smsError}</p> : null}
                <div>
                  <button
                    type="button"
                    onClick={() => void handleSendSms()}
                    disabled={!funder.phone || !smsBody.trim() || smsSending || isSmsTextOverLimit(smsBody)}
                    className={crm.btnPrimary}
                  >
                    <Send size={14} /> {smsSending ? "Sending..." : "Send SMS"}
                  </button>
                </div>
              </div>
            ) : workspaceTab === "email" ? (
              <div className="grid gap-3">
                <div>
                  <p className={crm.label}>Email</p>
                  <p className="mt-1 text-sm text-crm-muted">
                    {funder.email ? `Queue email to ${funder.email}.` : "Add an email address before sending email."}
                  </p>
                </div>
                <input
                  value={emailSubject}
                  onChange={(e) => setEmailSubject(e.target.value)}
                  disabled={!funder.email}
                  placeholder="Subject"
                  className={crm.input}
                />
                <textarea
                  value={emailBody}
                  onChange={(e) => setEmailBody(e.target.value)}
                  rows={8}
                  disabled={!funder.email}
                  placeholder="Write email..."
                  className={cn(crm.input, "min-h-[12rem] resize-y")}
                />
                {emailError ? <p className="text-sm text-crm-danger">{emailError}</p> : null}
                <div>
                  <button
                    type="button"
                    onClick={() => void handleSendEmail()}
                    disabled={!funder.email || !emailSubject.trim() || !emailBody.trim() || emailSending}
                    className={crm.btnPrimary}
                  >
                    <Send size={14} /> {emailSending ? "Queueing..." : "Send Email"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid gap-3">
                <p className={crm.label}>Workspace Note</p>
                <textarea
                  value={noteBody}
                  onChange={(e) => setNoteBody(e.target.value)}
                  rows={5}
                  placeholder="Add a funder note..."
                  className={cn(crm.input, "min-h-[9rem] resize-y")}
                />
                {noteError ? <p className="text-sm text-crm-danger">{noteError}</p> : null}
                <div>
                  <button
                    type="button"
                    onClick={() => void handleSaveNote()}
                    disabled={!noteBody.trim() || noteSaving}
                    className={crm.btnPrimary}
                  >
                    <Save size={14} /> {noteSaving ? "Saving..." : "Save Note"}
                  </button>
                </div>
              </div>
            )}
          </CRMCard>
        ) : null}

        {!isWorkspaceRoute ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] lg:items-start">
          {/* Main content */}
          <div className="flex flex-col gap-4 min-w-0">
            {editing ? (
              <CRMCard className="p-5">
                <h2 className={cn(crm.label, "mb-4")}>Edit Funder</h2>
                {saveErr && (
                  <div className={cn(crm.bannerDanger, "mb-3 rounded-crm px-3 py-2 text-sm")}>{saveErr}</div>
                )}
                <div className="flex flex-col gap-3">
                  <div className="grid grid-cols-2 gap-3">
                    {fieldEl("Name *", "name")}
                    <div>
                      <label className={crm.label}>Status</label>
                      <ConnectSelect
                        className={cn("mt-1")}
                        value={form.status ?? ""}
                        onChange={(value) => setForm((f) => ({ ...f, status: value as FunderStatus }))}
                        options={(["ACTIVE", "INACTIVE", "PROSPECT", "PENDING"] as FunderStatus[]).map((s) => ({
                          value: s,
                          label: STATUS_LABELS[s],
                        }))}
                      />
                    </div>
                  </div>
                  {fieldEl("Organization", "organization")}
                  {fieldEl("Email", "email", { type: "email" })}
                  <div className="grid grid-cols-2 gap-3">
                    {fieldEl("Phone", "phone")}
                    {fieldEl("Phone 2", "phone2")}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {fieldEl("City", "city")}
                    {fieldEl("State", "state")}
                    {fieldEl("Zip", "zip")}
                  </div>
                  {fieldEl("Notes", "notes", { multiline: true })}
                  <div className="flex justify-end gap-2 pt-2">
                    <button onClick={() => setEditing(false)} className={crm.btnSecondary} disabled={saving}>Cancel</button>
                    <button onClick={handleSave} disabled={saving} className={crm.btnPrimary}>
                      <Save size={14} /> {saving ? "Saving…" : "Save Changes"}
                    </button>
                  </div>
                </div>
              </CRMCard>
            ) : (
              <CRMCard className="p-5">
                <h2 className={cn(crm.label, "mb-4")}>Contact Info</h2>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {[
                    { label: "Name", value: funder.name },
                    { label: "Organization", value: funder.organization },
                    { label: "Email", value: funder.email },
                    { label: "Phone", value: funder.phone },
                    { label: "Phone 2", value: funder.phone2 },
                    { label: "City", value: funder.city },
                    { label: "State", value: funder.state },
                    { label: "Zip", value: funder.zip },
                  ].map((row) => (
                    row.value ? (
                      <div key={row.label}>
                        <div className={crm.label}>{row.label}</div>
                        <div className="mt-0.5 text-sm text-crm-text">{row.value}</div>
                      </div>
                    ) : null
                  ))}
                </div>
                {funder.notes && (
                  <div className="mt-4 border-t border-crm-border/50 pt-4">
                    <div className={crm.label}>Notes</div>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-crm-text">{funder.notes}</p>
                  </div>
                )}
              </CRMCard>
            )}
          </div>

          {/* Sidebar */}
          <div className="flex flex-col gap-3 min-w-0">
            {/* Tag assignment panel */}
            {showTagPanel && (
              <CRMCard className="p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className={crm.label}>Assign Tags</h3>
                  <button onClick={() => setShowTagPanel(false)} className={crm.btnGhost} style={{ padding: "0.25rem" }}>
                    <X size={14} />
                  </button>
                </div>
                {allTags.length === 0 ? (
                  <p className={crm.muted}>No tags yet. Create tags from the Funders list.</p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {allTags.map((t) => {
                      const assigned = assignedTagIds.has(t.id);
                      return (
                        <button
                          key={t.id}
                          disabled={tagWorking}
                          onClick={() => handleTagAssign(t.id, assigned ? "remove" : "assign")}
                          className={cn(
                            "flex items-center justify-between rounded-crm border px-3 py-2 text-sm transition-colors",
                            assigned
                              ? "border-crm-accent/40 bg-crm-accent/10 text-crm-accent"
                              : "border-crm-border text-crm-muted hover:border-crm-border/80 hover:text-crm-text"
                          )}
                          style={t.color && !assigned ? { borderColor: `${t.color}55`, color: t.color } : {}}
                        >
                          <span>{t.name}</span>
                          {assigned && <span className="text-xs font-semibold">✓ Assigned</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </CRMCard>
            )}

            {/* Metadata */}
            <CRMCard className="p-4">
              <h3 className={cn(crm.label, "mb-3")}>Details</h3>
              <div className="flex flex-col gap-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className={crm.muted}>Status</span>
                  <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", STATUS_COLORS[funder.status])}>
                    {STATUS_LABELS[funder.status]}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className={crm.muted}>Created</span>
                  <span className="text-crm-text">{formatDate(funder.createdAt)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className={crm.muted}>Updated</span>
                  <span className="text-crm-text">{formatDate(funder.updatedAt)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className={crm.muted}>Tags</span>
                  <span className="text-crm-text">{funder.tags.length}</span>
                </div>
              </div>
            </CRMCard>

            {toast ? (
              <p className={cn("text-sm", toast.kind === "ok" ? "text-crm-success" : "text-crm-danger")}>{toast.text}</p>
            ) : null}

            <CrmConfirmModal
              open={confirming}
              title="Delete funder?"
              description="This removes the funder from active lists. Import history is preserved."
              confirmLabel="Delete"
              destructive
              loading={archiving}
              onConfirm={() => void handleDelete()}
              onCancel={() => setConfirming(false)}
            />
          </div>
        </div>
        ) : null}
      </div>
    </div>
  );
}
