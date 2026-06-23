"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Users, Search,
  PhoneCall, X, Download, UserPlus,
  Shuffle, Upload, Mail, Target, TrendingUp,
} from "lucide-react";
import {
  CRMPageShell,
  CRMWorkspaceShell,
  CRMWorkspaceChrome,
  CRMWorkspaceHeader,
  CRMWorkspaceToolbar,
  CRMWorkspaceBody,
  CRMWorkspaceMain,
  CRMWorkspaceScrollRegion,
  CRMWorkspaceRightRail,
  CampaignGuidedEmpty,
  CampaignCommandHeader,
  CampaignMemberCard,
  deriveCampaignHealth,
  type CampaignDetail,
  type CampaignMember,
} from "../../../../../components/crm";
import { crm } from "../../../../../components/crm/crmClasses";
import { ConnectSelect } from "../../../../../components/ConnectSelect";
import { mk } from "../../../../../components/crm/campaign/campaignCinemaClasses";
import { cn } from "../../../../../components/crm/cn";
import { BulkEmailModal } from "../../../../../components/crm/email/BulkEmailModal";
import { apiGet, apiPost, apiPatch, apiDelete, browserTenantContext } from "../../../../../services/apiClient";
import { CrmConfirmModal } from "../../../../../components/crm/CrmConfirmModal";
import { EditCampaignModal } from "../../../../../components/crm/campaign/EditCampaignModal";
import { useAppContext } from "../../../../../hooks/useAppContext";

// ── Types ──────────────────────────────────────────────────────────────────────

type CampaignStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "COMPLETED" | "ARCHIVED";
type CampaignPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
type MemberStatus = "PENDING" | "IN_PROGRESS" | "CONTACTED" | "CALLBACK" | "CONVERTED" | "SKIPPED" | "DO_NOT_CALL";

type Campaign = {
  id: string;
  name: string;
  description: string | null;
  status: CampaignStatus;
  priority: CampaignPriority;
  scriptId: string | null;
  checklistId: string | null;
  script: { id: string; name: string } | null;
  checklist: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  statusCounts: Record<string, number>;
};

type Member = {
  id: string;
  contactId: string;
  queueWorkEligible?: boolean;
  contact: {
    id: string;
    displayName: string;
    company: string | null;
    active?: boolean;
    archivedAt?: string | null;
    primaryPhone: string | null;
    primaryEmail: string | null;
    crmStage: string | null;
    lastActivityAt: string | null;
    lastDisposition: string | null;
  } | null;
  assignedTo: { id: string; displayName: string; email: string } | null;
  assignedToUserId: string | null;
  status: MemberStatus;
  attemptCount: number;
  lastAttemptAt: string | null;
  callbackAt: string | null;
  callbackNote: string | null;
  sortOrder: number;
  createdAt: string;
};

type AvailableContact = {
  id: string;
  displayName: string;
  company: string | null;
  primaryPhone: string | null;
  primaryEmail: string | null;
  crmStage: string | null;
};

type CrmUser = {
  userId: string;
  displayName: string;
  email: string;
  crmRole: string | null;
  crmEnabled: boolean;
};

type CampaignImportHistoryRow = {
  id: string;
  createdAt: string;
  completedAt: string | null;
  status: string;
  fileName: string;
  totalRows: number;
  processedRows: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  createdBy: { id: string; displayName: string } | null;
};

const CAMPAIGN_IMPORT_STATUS_STYLE: Record<string, string> = {
  PENDING: "bg-crm-surface-2 text-crm-text border-crm-border",
  PROCESSING: "bg-crm-accent/15 text-crm-accent border-crm-accent/30",
  DONE: "bg-crm-success/10 text-crm-success border-crm-success/30",
  PARTIAL: "bg-crm-warning/10 text-crm-warning border-crm-warning/35",
  FAILED: "bg-crm-danger/15 text-crm-danger border-crm-danger/35",
};

function campaignImportStatusLabel(s: string) {
  switch (s) {
    case "PENDING":
      return "Pending";
    case "PROCESSING":
      return "Processing";
    case "DONE":
      return "Done";
    case "PARTIAL":
      return "Partial";
    case "FAILED":
      return "Failed";
    default:
      return s;
  }
}

type CampaignImportSummary = {
  batchId: string;
  campaignId: string;
  fileName: string;
  status: string;
  totalRows: number;
  createdContacts: number;
  updatedContacts: number;
  skippedRows: number;
  addedMembers: number;
  skippedExistingMembers: number;
  errorCount: number;
  auditErrorCount?: number;
  errors: { row: number; reason: string }[];
  detectedHeaders?: string[];
  mapping?: Record<string, string>;
  assignedToUserId: string | null;
};

type CampaignImportPreview = {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  wouldCreateContacts: number;
  wouldUpdateContacts: number;
  wouldAddMembers: number;
  wouldSkipExistingMembers: number;
  sampleRows: {
    row: number;
    phone?: string;
    email?: string;
    /** API: create | update | skip — optional for older responses */
    outcome?: string;
    reason?: string;
    /** API: would_add | skip_already_in_campaign | skip_duplicate_in_file | n_a */
    member?: string;
  }[];
  errors: { row: number; reason: string }[];
  campaignId?: string;
  fileName?: string;
  detectedHeaders?: string[];
  mapping?: Record<string, string>;
  assignedToUserId?: string | null;
};

/** Snapshot of preview totals kept for post-import comparison (honest vs actual import). */
type ImportPreviewExpectation = {
  wouldCreateContacts: number;
  wouldUpdateContacts: number;
  wouldAddMembers: number;
  wouldSkipExistingMembers: number;
  invalidRows: number;
};

type PreviewSampleBucket =
  | "new_contact_member"
  | "updated_contact_member"
  | "already_in_campaign"
  | "duplicate_in_file"
  | "invalid_row"
  | "unknown";

const PREVIEW_SAMPLE_BUCKET_ORDER: PreviewSampleBucket[] = [
  "new_contact_member",
  "updated_contact_member",
  "already_in_campaign",
  "duplicate_in_file",
  "invalid_row",
  "unknown",
];

const PREVIEW_SAMPLE_BUCKET_LABEL: Record<PreviewSampleBucket, string> = {
  new_contact_member: "New contacts (will be created)",
  updated_contact_member: "Existing contacts (will be updated)",
  already_in_campaign: "Already in this campaign",
  duplicate_in_file: "Duplicate rows in this file",
  invalid_row: "Invalid / missing phone & email",
  unknown: "Other sample rows",
};
const CAMPAIGN_MEMBER_PAGE_SIZE = 250;
const ADD_CONTACTS_PAGE_SIZE = 250;
const SPREADSHEET_EXTS = /\.(xlsx|xls|ods|numbers)$/i;

const IMPORT_FIELD_OPTIONS = [
  { value: "", label: "Do not import" },
  { value: "company", label: "Company name" },
  { value: "displayName", label: "Owner / contact name" },
  { value: "firstName", label: "First name" },
  { value: "lastName", label: "Last name" },
  { value: "title", label: "Title" },
  { value: "phone", label: "Phone number (repeatable)" },
  { value: "email", label: "Email (repeatable)" },
  { value: "address", label: "Address" },
  { value: "city", label: "City" },
  { value: "state", label: "State" },
  { value: "zip", label: "Zip" },
  { value: "externalId", label: "ID" },
  { value: "ssn", label: "Social security number" },
  { value: "monthlyRevenue", label: "Monthly revenue" },
  { value: "notes", label: "Notes" },
  { value: "tags", label: "Tags" },
];

const IMPORT_HEADER_ALIASES: Record<string, string> = {
  company: "company",
  "company name": "company",
  business: "company",
  "business name": "company",
  organization: "company",
  organisation: "company",
  name: "displayName",
  owner: "displayName",
  "owner name": "displayName",
  "owner nme": "displayName",
  contact: "displayName",
  "contact name": "displayName",
  "first name": "firstName",
  firstname: "firstName",
  "last name": "lastName",
  lastname: "lastName",
  title: "title",
  "job title": "title",
  phone: "phone",
  phone1: "phone",
  phone2: "phone",
  phone3: "phone",
  mobile: "phone",
  cell: "phone",
  telephone: "phone",
  "phone number": "phone",
  "primary phone": "phone",
  email: "email",
  email1: "email",
  email2: "email",
  email3: "email",
  "email address": "email",
  "e-mail": "email",
  address: "address",
  "street address": "address",
  city: "city",
  state: "state",
  st: "state",
  zip: "zip",
  zipcode: "zip",
  "zip code": "zip",
  id: "externalId",
  "id number": "externalId",
  "external id": "externalId",
  "lead id": "externalId",
  "merchant id": "externalId",
  "account id": "externalId",
  ssn: "ssn",
  "social security": "ssn",
  "social security number": "ssn",
  tin: "ssn",
  "monthly revenue": "monthlyRevenue",
  "monthly rev": "monthlyRevenue",
  "monthly income": "monthlyRevenue",
  "monthly sales": "monthlyRevenue",
  revenue: "monthlyRevenue",
  notes: "notes",
  note: "notes",
  tags: "tags",
};

function parseCsvLocally(text: string): string[][] {
  const rows: string[][] = [];
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let pos = 0;
  while (pos < lines.length) {
    const row: string[] = [];
    while (pos < lines.length) {
      if (lines[pos] === '"') {
        pos++;
        let field = "";
        while (pos < lines.length) {
          if (lines[pos] === '"') {
            if (lines[pos + 1] === '"') {
              field += '"';
              pos += 2;
            } else {
              pos++;
              break;
            }
          } else {
            field += lines[pos++];
          }
        }
        row.push(field);
        if (lines[pos] === ",") pos++;
      } else {
        const start = pos;
        while (pos < lines.length && lines[pos] !== "," && lines[pos] !== "\n") pos++;
        row.push(lines.slice(start, pos).trim());
        if (lines[pos] === ",") pos++;
      }
      if (lines[pos] === "\n") {
        pos++;
        break;
      }
    }
    if (row.length > 0 && !(row.length === 1 && row[0] === "")) rows.push(row);
  }
  return rows;
}

async function readCampaignImportFile(file: File): Promise<{ uploadFile: File; csvText: string }> {
  if (SPREADSHEET_EXTS.test(file.name)) {
    const XLSX = await import("xlsx");
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0] ?? ""];
    const csvText = XLSX.utils.sheet_to_csv(ws ?? {});
    const uploadName = file.name.replace(/\.[^.]+$/, "") || "import";
    return {
      csvText,
      uploadFile: new File([csvText], `${uploadName}.csv`, { type: "text/csv", lastModified: file.lastModified }),
    };
  }

  const csvText = await file.text();
  return { csvText, uploadFile: file };
}

function inferImportMapping(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  const usedSingleFields = new Set<string>();
  for (let i = 0; i < headers.length; i++) {
    const mapped = IMPORT_HEADER_ALIASES[headers[i]?.toLowerCase().trim() ?? ""];
    if (!mapped) continue;
    if (mapped !== "phone" && mapped !== "email") {
      if (usedSingleFields.has(mapped)) continue;
      usedSingleFields.add(mapped);
    }
    mapping[String(i)] = mapped;
  }
  return mapping;
}

function importPreviewContextKey(file: File | null, assigneeId: string, mappingFingerprint: string): string | null {
  if (!file) return null;
  return `${file.name}:${file.size}:${file.lastModified}|assignee:${assigneeId || ""}|mapping:${mappingFingerprint}`;
}

function bucketPreviewSampleRow(s: CampaignImportPreview["sampleRows"][number]): PreviewSampleBucket {
  const outcome = s.outcome;
  const member = s.member;
  if (member === "skip_already_in_campaign") return "already_in_campaign";
  if (member === "skip_duplicate_in_file") return "duplicate_in_file";
  if (outcome === "skip" || member === "n_a") return "invalid_row";
  if (outcome === "create" && member === "would_add") return "new_contact_member";
  if (outcome === "update" && member === "would_add") return "updated_contact_member";
  if (outcome === "create" || outcome === "update") return "unknown";
  return "unknown";
}

function labelContactOutcome(outcome: string | undefined): string {
  switch (outcome) {
    case "create":
      return "Create contact";
    case "update":
      return "Update contact";
    case "skip":
      return "Skipped";
    default:
      return outcome?.length ? outcome : "—";
  }
}

function labelMemberOutcome(member: string | undefined): string {
  switch (member) {
    case "would_add":
      return "Add to campaign";
    case "skip_already_in_campaign":
      return "Already enrolled";
    case "skip_duplicate_in_file":
      return "Duplicate in file";
    case "n_a":
      return "—";
    default:
      return member?.length ? member : "—";
  }
}

function previewExpectationFromResponse(p: CampaignImportPreview): ImportPreviewExpectation {
  return {
    wouldCreateContacts: p.wouldCreateContacts,
    wouldUpdateContacts: p.wouldUpdateContacts,
    wouldAddMembers: p.wouldAddMembers,
    wouldSkipExistingMembers: p.wouldSkipExistingMembers,
    invalidRows: p.invalidRows,
  };
}

/** Core enroll path — compare to import result. */
function importCoreCountsDiffer(exp: ImportPreviewExpectation, sum: CampaignImportSummary): boolean {
  return (
    exp.wouldCreateContacts !== sum.createdContacts ||
    exp.wouldUpdateContacts !== sum.updatedContacts ||
    exp.wouldAddMembers !== sum.addedMembers ||
    exp.wouldSkipExistingMembers !== sum.skippedExistingMembers
  );
}

type WorkloadRow = {
  userId: string | null;
  displayName: string;
  pending: number;
  inProgress: number;
  callbacks: number;
  contacted: number;
  converted: number;
  skipped: number;
  dnc: number;
  total: number;
};

// ── Constants ──────────────────────────────────────────────────────────────────

const MEMBER_STATUS_LABELS: Record<MemberStatus, string> = {
  PENDING: "Pending", IN_PROGRESS: "In Progress", CONTACTED: "Contacted",
  CALLBACK: "Callback", CONVERTED: "Converted", SKIPPED: "Skipped", DO_NOT_CALL: "DNC",
};

function formatMetricNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function CampaignDetailRightRail({
  campaign,
  health,
  canQueue,
}: {
  campaign: Campaign;
  health: ReturnType<typeof deriveCampaignHealth>;
  canQueue: boolean;
}) {
  const healthScore = health.total > 0
    ? Math.round(((health.contactedProgress + health.converted + Math.max(0, health.total - health.unassignedMembers)) / (health.total * 3)) * 100)
    : 0;
  const total = Math.max(health.total, 1);
  const conversionRate = Math.round((health.converted / total) * 100);
  const contactedRate = Math.round((health.contactedProgress / total) * 100);
  const queueRate = Math.round((health.activeQueueWork / total) * 100);
  const callbackRate = Math.round((health.callback / total) * 100);
  const assignedRate = Math.round(((health.total - health.unassignedMembers) / total) * 100);
  const pendingRate = Math.round((health.pending / total) * 100);
  const inProgressRate = Math.round((health.inProgress / total) * 100);
  const unassignedRate = Math.round((health.unassignedMembers / total) * 100);
  const metricCards = [
    { label: "Campaign health", value: `${healthScore}/100`, hint: "Live readiness score", tone: "blue", icon: <TrendingUp className="h-4 w-4" />, progress: healthScore },
    { label: "Total members", value: formatMetricNumber(health.total), hint: `${formatMetricNumber(health.total - health.unassignedMembers)} assigned`, tone: "violet", icon: <Users className="h-4 w-4" />, progress: assignedRate },
    { label: "Queue work", value: formatMetricNumber(health.activeQueueWork), hint: `${queueRate}% of roster`, tone: "cyan", icon: <PhoneCall className="h-4 w-4" />, progress: queueRate },
    { label: "Contacted", value: formatMetricNumber(health.contactedProgress), hint: `${contactedRate}% reached`, tone: "emerald", icon: <Mail className="h-4 w-4" />, progress: contactedRate },
    { label: "Converted", value: formatMetricNumber(health.converted), hint: `${conversionRate}% conversion`, tone: "amber", icon: <Target className="h-4 w-4" />, progress: conversionRate },
    { label: "Callbacks", value: formatMetricNumber(health.callback), hint: `${callbackRate}% need attention`, tone: "rose", icon: <PhoneCall className="h-4 w-4" />, progress: callbackRate },
  ];
  const reportRows = [
    { label: "Pending", value: health.pending, progress: pendingRate, tone: "blue" },
    { label: "Working", value: health.inProgress, progress: inProgressRate, tone: "violet" },
    { label: "Reached", value: health.contactedProgress, progress: contactedRate, tone: "emerald" },
  ];
  const healthSignals = [
    { label: "Assignment", value: `${assignedRate}%`, hint: `${formatMetricNumber(health.unassignedMembers)} open` },
    { label: "Queue", value: `${queueRate}%`, hint: `${formatMetricNumber(health.activeQueueWork)} callable` },
    { label: "Unassigned", value: `${unassignedRate}%`, hint: "needs owner" },
  ];

  return (
    <div className="campaign-detail-rail" aria-label="Campaign operations">
      <section className="campaign-detail-side-analytics campaign-detail-rail-card">
        <div className="campaign-detail-side-analytics-head">
          <div>
            <p>Campaign Analytics</p>
            <h2>{campaign.name}</h2>
          </div>
          <span>{campaign.status}</span>
        </div>
        <div className="campaign-detail-side-analytics-grid">
          {metricCards.map((card) => (
            <article key={card.label} className={`campaign-detail-side-metric campaign-detail-side-metric-${card.tone}`}>
              <div className="campaign-detail-side-metric-top">
                <span>{card.icon}</span>
                <small>{card.label}</small>
              </div>
              <strong>{card.value}</strong>
              <p>{card.hint}</p>
              <div className="campaign-detail-side-metric-track" aria-hidden>
                <span style={{ width: `${Math.min(100, Math.max(0, card.progress))}%` }} />
              </div>
            </article>
          ))}
        </div>
        <div className="campaign-detail-side-report">
          <div className="campaign-detail-side-report-head">
            <p>2026 Campaign Report</p>
            <span>Live</span>
          </div>
          <div className="campaign-detail-side-report-bars">
            {reportRows.map((row) => (
              <div key={row.label} className={`campaign-detail-side-report-row campaign-detail-side-metric-${row.tone}`}>
                <div>
                  <span>{row.label}</span>
                  <strong>{formatMetricNumber(row.value)}</strong>
                </div>
                <div className="campaign-detail-side-metric-track" aria-hidden>
                  <span style={{ width: `${Math.min(100, Math.max(0, row.progress))}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="campaign-detail-side-signal-grid">
          {healthSignals.map((signal) => (
            <div key={signal.label}>
              <span>{signal.label}</span>
              <strong>{signal.value}</strong>
              <p>{signal.hint}</p>
            </div>
          ))}
        </div>
        {canQueue && health.activeQueueWork > 0 ? (
          <Link className="campaign-detail-side-queue-link" href={`/crm/queue?campaignId=${encodeURIComponent(campaign.id)}`}>
            Open queue ({formatMetricNumber(health.activeQueueWork)})
          </Link>
        ) : null}
      </section>
    </div>
  );
}

function AddContactsModal({ campaignId, onClose, onAdded }: {
  campaignId: string; onClose: () => void; onAdded: () => void;
}) {
  const [contacts, setContacts] = useState<AvailableContact[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const token = typeof window !== "undefined" ? localStorage.getItem("token") ?? undefined : undefined;

  const fetchContacts = useCallback(async (q: string, pg: number) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(ADD_CONTACTS_PAGE_SIZE), page: String(pg) });
      if (q) params.set("q", q);
      const res = await apiGet<{ contacts: AvailableContact[]; total: number }>(
        `/crm/campaigns/${campaignId}/contacts/available?${params}`,
        token
      );
      setContacts(res.contacts);
      setTotal(res.total);
    } catch {
      setContacts([]);
      setTotal(0);
    }
    setLoading(false);
  }, [campaignId, token]);

  useEffect(() => { fetchContacts("", 1); }, [fetchContacts]);

  function handleSearchChange(v: string) {
    setSearch(v);
    setPage(1);
    setSelected(new Set());
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => fetchContacts(v, 1), 300);
  }

  function handlePageChange(pg: number) {
    setPage(pg);
    setSelected(new Set());
    fetchContacts(search, pg);
  }

  async function handleAdd() {
    if (selected.size === 0) return;
    setSaving(true);
    setError("");
    try {
      await apiPost(`/crm/campaigns/${campaignId}/members/add`, { contactIds: Array.from(selected) }, token);
      onAdded();
      onClose();
    } catch (err: unknown) {
      setError((err as Error)?.message ?? "Failed to add contacts");
      setSaving(false);
    }
  }

  const totalPages = Math.ceil(total / ADD_CONTACTS_PAGE_SIZE);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-crm-surface rounded-crm shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col">
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="font-semibold text-crm-text">Add Contacts to Campaign</h2>
          <button onClick={onClose} className="p-1 hover:bg-crm-surface-2 rounded"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-3 border-b">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-crm-muted/80" />
            <input
              autoFocus
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="w-full pl-9 pr-3 py-2 border border-crm-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-crm-accent/30"
              placeholder="Search by name, phone, or email…"
            />
          </div>
          {total > 0 && (
            <p className="text-xs text-crm-muted/80 mt-1.5 px-1">{total} contact{total !== 1 ? "s" : ""} available</p>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-8 text-center text-crm-muted/80 text-sm">Searching…</div>
          ) : contacts.length === 0 ? (
            <div className="p-8 text-center text-crm-muted/80 text-sm">
              {search ? "No contacts match your search." : "All CRM contacts are already in this campaign."}
            </div>
          ) : (
            <>
              {contacts.map((c) => (
                <label key={c.id} className="flex items-center gap-3 px-4 py-3 hover:bg-crm-surface-2 cursor-pointer border-b last:border-b-0">
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={(e) => {
                      const s = new Set(selected);
                      if (e.target.checked) s.add(c.id);
                      else s.delete(c.id);
                      setSelected(s);
                    }}
                    className="rounded"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-crm-text truncate">{c.displayName}</p>
                    <p className="text-xs text-crm-muted truncate">
                      {[c.primaryPhone, c.primaryEmail, c.company].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  {c.crmStage && (
                    <span className="text-xs text-crm-accent bg-crm-accent/12 border border-crm-accent/25 px-1.5 py-0.5 rounded-crm shrink-0">{c.crmStage}</span>
                  )}
                </label>
              ))}
            </>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-4 py-2 border-t flex items-center justify-between text-xs text-crm-muted">
            <button disabled={page === 1} onClick={() => handlePageChange(page - 1)} className="px-2 py-1 border rounded disabled:opacity-40 hover:bg-crm-surface-2">Previous</button>
            <span>Page {page} of {totalPages}</span>
            <button disabled={page === totalPages} onClick={() => handlePageChange(page + 1)} className="px-2 py-1 border rounded disabled:opacity-40 hover:bg-crm-surface-2">Next</button>
          </div>
        )}

        <div className="p-4 border-t flex items-center justify-between gap-2">
          <span className="text-sm text-crm-muted">{selected.size} selected</span>
          {error && <span className="text-xs text-crm-danger">{error}</span>}
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-2 text-sm border border-crm-border rounded-lg text-crm-text hover:bg-crm-surface-2">Cancel</button>
            <button onClick={handleAdd} disabled={saving || selected.size === 0} className="px-4 py-2 text-sm bg-crm-accent text-white rounded-lg hover:brightness-110 disabled:opacity-50">
              {saving ? "Adding…" : `Add ${selected.size > 0 ? selected.size : ""} Contacts`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function CampaignDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const campaignId = params.id;
  const { backendJwtRole, can, user: appUser } = useAppContext();
  const canQueue = can("can_view_crm_queue");

  const isAdmin =
    backendJwtRole === "ADMIN" ||
    backendJwtRole === "TENANT_ADMIN" ||
    backendJwtRole === "SUPER_ADMIN" ||
    can("can_manage_crm");

  const canManageCampaigns = can("can_view_crm_campaigns");

  // Lead import is allowed for every CRM-enabled user (backend: requireCrmManager → requireCrmAccess).
  // Gate the button on the dedicated import permission so custom (non-admin) roles see it.
  const canImport = isAdmin || can("can_view_crm_import");

  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [members, setMembers] = useState<CampaignMember[]>([]);
  const [membersTotal, setMembersTotal] = useState(0);
  const [crmUsers, setCrmUsers] = useState<CrmUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [membersLoading, setMembersLoading] = useState(false);
  const [showAddContacts, setShowAddContacts] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [membersPage, setMembersPage] = useState(1);
  // "" = all agents, "UNASSIGNED" = null, else userId
  const [assigneeFilter, setAssigneeFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [showEditCampaign, setShowEditCampaign] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteWorking, setDeleteWorking] = useState(false);

  // Workload summary (admin — loaded automatically for health + workload strip)
  const [workload, setWorkload] = useState<WorkloadRow[]>([]);
  const [, setWorkloadLoading] = useState(false);

  // Distribute modal
  const [distributeOpen, setDistributeOpen] = useState(false);
  const [distributeUserIds, setDistributeUserIds] = useState<Set<string>>(new Set());
  const [distributing, setDistributing] = useState(false);
  const [distributeMsg, setDistributeMsg] = useState("");

  // CSV import into campaign (admin — matches API requireCrmAdmin)
  const [importOpen, setImportOpen] = useState(false);
  /** Set to true when the page is entered via ?openImport=1; opened once the campaign loads. */
  const [pendingOpenImport, setPendingOpenImport] = useState(() =>
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("openImport") === "1"
      : false,
  );
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importDisplayFileName, setImportDisplayFileName] = useState("");
  const [importHeaders, setImportHeaders] = useState<string[]>([]);
  const [importSampleRow, setImportSampleRow] = useState<string[]>([]);
  const [importColumnMapping, setImportColumnMapping] = useState<Record<string, string>>({});
  const [importAssigneeId, setImportAssigneeId] = useState("");
  const [importing, setImporting] = useState(false);
  const [importErr, setImportErr] = useState("");
  const [importSummary, setImportSummary] = useState<CampaignImportSummary | null>(null);
  const [importPreview, setImportPreview] = useState<CampaignImportPreview | null>(null);
  const [importPreviewing, setImportPreviewing] = useState(false);
  /** File + assignee fingerprint when preview last succeeded — Import only when it matches. */
  const [importPreviewContextKeyState, setImportPreviewContextKeyState] = useState<string | null>(null);
  /** Counts from the preview that completed immediately before a successful import (compare to actual). */
  const [importCompareBaseline, setImportCompareBaseline] = useState<ImportPreviewExpectation | null>(null);

  // Bulk select
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAssignUserId, setBulkAssignUserId] = useState<string>(""); // "" = clear
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const [bulkMsg, setBulkMsg] = useState("");

  // Bulk email
  const [showBulkEmail, setShowBulkEmail] = useState(false);
  const [bulkEmailToast, setBulkEmailToast] = useState<string | null>(null);

  const [importHistory, setImportHistory] = useState<CampaignImportHistoryRow[]>([]);
  const [, setImportHistoryLoading] = useState(false);

  const token = typeof window !== "undefined" ? localStorage.getItem("token") ?? undefined : undefined;

  const loadCampaignImports = useCallback(async () => {
    setImportHistoryLoading(true);
    try {
      const res = await apiGet<{ imports: CampaignImportHistoryRow[] }>(
        `/crm/campaigns/${campaignId}/imports?limit=20`,
        token
      );
      setImportHistory(res.imports ?? []);
    } catch {
      setImportHistory([]);
    }
    setImportHistoryLoading(false);
  }, [campaignId, token]);

  useEffect(() => {
    void loadCampaignImports();
  }, [loadCampaignImports]);

  useEffect(() => {
    setImportPreview(null);
    setImportPreviewContextKeyState(null);
  }, [importFile, importAssigneeId]);

  useEffect(() => {
    setImportPreview(null);
    setImportPreviewContextKeyState(null);
  }, [importColumnMapping]);

  // Auto-open the import modal when the page is entered via ?openImport=1 (campaign-native import flow).
  useEffect(() => {
    if (pendingOpenImport && campaign && isAdmin) {
      setPendingOpenImport(false);
      // Clean the URL param so refreshing doesn't reopen the modal.
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.delete("openImport");
        window.history.replaceState({}, "", url.toString());
      }
      setImportOpen(true);
      setImportErr("");
      setImportSummary(null);
      setImportFile(null);
      setImportDisplayFileName("");
      setImportHeaders([]);
      setImportSampleRow([]);
      setImportColumnMapping({});
      setImportAssigneeId("");
      setImportPreview(null);
      setImportPreviewContextKeyState(null);
      setImportCompareBaseline(null);
    }
  }, [pendingOpenImport, campaign, isAdmin]);

  const resetImportFileState = useCallback(() => {
    setImportFile(null);
    setImportDisplayFileName("");
    setImportHeaders([]);
    setImportSampleRow([]);
    setImportColumnMapping({});
    setImportPreview(null);
    setImportPreviewContextKeyState(null);
  }, []);

  const loadCampaign = useCallback(async () => {
    try {
      const res = await apiGet<{ campaign: Campaign }>(`/crm/campaigns/${campaignId}`, token);
      setCampaign(res.campaign);
      setNameInput(res.campaign.name);
    } catch (err: unknown) {
      setError((err as Error)?.message ?? "Not found");
    }
  }, [campaignId, token]);

  const loadMembers = useCallback(async (overrideAssignee?: string, requestedPage?: number) => {
    setMembersLoading(true);
    try {
      const af = overrideAssignee !== undefined ? overrideAssignee : assigneeFilter;
      const activePage = requestedPage ?? membersPage;
      const queryParams = new URLSearchParams({
        limit: String(CAMPAIGN_MEMBER_PAGE_SIZE),
        page: String(activePage),
      });
      if (statusFilter) queryParams.set("status", statusFilter);
      if (af === "UNASSIGNED") queryParams.set("unassigned", "true");
      else if (af) queryParams.set("assignedToUserId", af);
      const res = await apiGet<{ members: Member[]; total: number }>(
        `/crm/campaigns/${campaignId}/members?${queryParams}`,
        token
      );
      setMembers(res.members);
      setMembersTotal(res.total);
    } catch {}
    setMembersLoading(false);
  }, [campaignId, statusFilter, assigneeFilter, membersPage, token]);

  const loadWorkload = useCallback(async () => {
    if (!isAdmin) return;
    setWorkloadLoading(true);
    try {
      const res = await apiGet<{ workload: WorkloadRow[] }>(
        `/crm/campaigns/${campaignId}/workload`,
        token
      );
      setWorkload(res.workload ?? []);
    } catch {}
    setWorkloadLoading(false);
  }, [campaignId, isAdmin, token]);

  useEffect(() => {
    async function init() {
      setLoading(true);
      await Promise.all([
        loadCampaign(),
        apiGet<{ users: CrmUser[] }>("/crm/users", token).then((r) => setCrmUsers(r.users ?? [])).catch(() => {}),
      ]);
      setLoading(false);
    }
    init();
  }, [loadCampaign, token]);

  // Load workload once campaign is loaded (admin only)
  useEffect(() => {
    if (!loading) loadWorkload();
  }, [loading, loadWorkload]);

  useEffect(() => { loadMembers(); }, [loadMembers]);

  // Clear selection when members reload
  useEffect(() => { setSelected(new Set()); }, [members]);

  async function updateCampaign(data: Record<string, unknown>) {
    try {
      const res = await apiPatch<{ campaign: Campaign }>(`/crm/campaigns/${campaignId}`, data, token);
      setCampaign(res.campaign);
      setToast({ kind: "ok", text: "Campaign updated" });
    } catch (err: unknown) {
      setToast({ kind: "err", text: (err as Error)?.message ?? "Update failed" });
      throw err;
    }
  }

  async function handleDeleteCampaign() {
    setDeleteWorking(true);
    try {
      await apiDelete(`/crm/campaigns/${campaignId}`, token);
      setCampaign((prev) => (prev ? { ...prev, status: "ARCHIVED" } : prev));
      setToast({ kind: "ok", text: "Campaign deleted" });
      setDeleteConfirmOpen(false);
    } catch (err: unknown) {
      setToast({ kind: "err", text: (err as Error)?.message ?? "Delete failed" });
    } finally {
      setDeleteWorking(false);
    }
  }

  async function saveName() {
    if (!nameInput.trim() || nameInput === campaign?.name) { setEditingName(false); return; }
    await updateCampaign({ name: nameInput.trim() });
    setEditingName(false);
  }

  async function updateMemberStatus(memberId: string, status: MemberStatus) {
    try {
      await apiPatch(`/crm/campaigns/${campaignId}/members/${memberId}`, { status }, token);
      setMembers((prev) => prev.map((m) => (m.id === memberId ? { ...m, status } : m)));
      // Refresh campaign counts after status change (auto-complete may have triggered)
      loadCampaign();
    } catch {}
  }

  async function handleDistribute() {
    if (distributeUserIds.size === 0) { setDistributeMsg("Select at least one agent."); return; }
    setDistributing(true);
    setDistributeMsg("");
    try {
      const res = await apiPost<{ distributed: number; assignments: { userId: string; count: number }[] }>(
        `/crm/campaigns/${campaignId}/members/distribute`,
        { userIds: Array.from(distributeUserIds) },
        token
      );
      if (res.distributed === 0) {
        setDistributeMsg("No unassigned leads to distribute.");
      } else {
        setDistributeMsg(`Distributed ${res.distributed} leads across ${res.assignments.filter((a) => a.count > 0).length} agents.`);
        await loadMembers();
        await loadWorkload();
        setDistributeOpen(false);
      }
    } catch (err: unknown) {
      setDistributeMsg((err as Error)?.message ?? "Failed to distribute leads.");
    }
    setDistributing(false);
  }

  async function handleImportFileChange(file: File | null) {
    setImportErr("");
    setImportSummary(null);
    setImportCompareBaseline(null);
    if (!file) {
      resetImportFileState();
      return;
    }

    try {
      const { uploadFile, csvText } = await readCampaignImportFile(file);
      const rows = parseCsvLocally(csvText);
      if (rows.length < 2) {
        throw new Error("File must have a header row and at least one data row.");
      }

      const headers = rows[0] ?? [];
      setImportFile(uploadFile);
      setImportDisplayFileName(file.name);
      setImportHeaders(headers);
      setImportSampleRow(rows[1] ?? []);
      setImportColumnMapping(inferImportMapping(headers));
      setImportPreview(null);
      setImportPreviewContextKeyState(null);
    } catch (err: unknown) {
      resetImportFileState();
      setImportErr((err as Error)?.message ?? "Could not read file. Please choose a CSV or Excel (.xlsx) file.");
    }
  }

  async function handleCampaignImport() {
    if (!importFile) {
      setImportErr("Choose a CSV or Excel file.");
      return;
    }
    if (!importMappingHasContactColumn) {
      setImportErr("Map at least one column to Phone number or Email.");
      return;
    }
    const ctx = importPreviewContextKey(importFile, importAssigneeId, importMappingFingerprint);
    if (!importPreview || !ctx || importPreviewContextKeyState !== ctx) {
      setImportErr("Run “Preview import” first. If you changed the file or assignee, preview again.");
      return;
    }
    const baseline = previewExpectationFromResponse(importPreview);
    setImporting(true);
    setImportErr("");
    setImportSummary(null);
    try {
      const fd = new FormData();
      fd.append("file", importFile);
      fd.append("mapping", JSON.stringify(importMappingPayload));
      if (importDisplayFileName) fd.append("sourceFileName", importDisplayFileName);
      if (importAssigneeId) fd.append("assignedToUserId", importAssigneeId);
      const t = typeof window !== "undefined" ? localStorage.getItem("token") : null;
      const base = typeof window !== "undefined" ? window.location.origin : "";
      const tenantCtx = browserTenantContext();
      const res = await fetch(`${base}/api/crm/campaigns/${campaignId}/import`, {
        method: "POST",
        headers: {
          ...(t ? { Authorization: `Bearer ${t}` } : {}),
          ...(tenantCtx ? { "x-tenant-context": tenantCtx } : {}),
        },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data.detail === "string" ? data.detail : data.error || `Import failed (${res.status})`,
        );
      }
      setImportSummary(data as CampaignImportSummary);
      setImportCompareBaseline(baseline);
      await Promise.all([loadCampaign(), loadMembers(), loadWorkload(), loadCampaignImports()]);
      resetImportFileState();
    } catch (e: unknown) {
      setImportErr((e as Error)?.message ?? "Import failed");
    }
    setImporting(false);
  }

  async function handleCampaignImportPreview() {
    if (!importFile) {
      setImportErr("Choose a CSV or Excel file.");
      return;
    }
    if (!importMappingHasContactColumn) {
      setImportErr("Map at least one column to Phone number or Email.");
      return;
    }
    setImportPreviewing(true);
    setImportErr("");
    setImportPreview(null);
    setImportPreviewContextKeyState(null);
    try {
      const fd = new FormData();
      fd.append("file", importFile);
      fd.append("mapping", JSON.stringify(importMappingPayload));
      if (importDisplayFileName) fd.append("sourceFileName", importDisplayFileName);
      if (importAssigneeId) fd.append("assignedToUserId", importAssigneeId);
      const t = typeof window !== "undefined" ? localStorage.getItem("token") : null;
      const base = typeof window !== "undefined" ? window.location.origin : "";
      const tenantCtx = browserTenantContext();
      const res = await fetch(`${base}/api/crm/campaigns/${campaignId}/import/preview`, {
        method: "POST",
        headers: {
          ...(t ? { Authorization: `Bearer ${t}` } : {}),
          ...(tenantCtx ? { "x-tenant-context": tenantCtx } : {}),
        },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data.detail === "string" ? data.detail : data.error || `Preview failed (${res.status})`,
        );
      }
      setImportPreview(data as CampaignImportPreview);
      setImportPreviewContextKeyState(importPreviewContextKey(importFile, importAssigneeId, importMappingFingerprint));
    } catch (e: unknown) {
      setImportErr((e as Error)?.message ?? "Preview failed");
      setImportPreview(null);
      setImportPreviewContextKeyState(null);
    }
    setImportPreviewing(false);
  }

  async function handleBulkAssign(targetUserId: string | null, targetLabel?: string) {
    if (selected.size === 0) return;
    setBulkAssigning(true);
    setBulkMsg("");
    const selectedIds = Array.from(selected);
    try {
      const res = await apiPost<{ updated: number }>(
        `/crm/campaigns/${campaignId}/members/bulk-assign`,
        { memberIds: selectedIds, assignedToUserId: targetUserId },
        token
      );
      const assignee = targetUserId
        ? crmUsers.find((u) => u.userId === targetUserId) ?? (
            targetUserId === appUser.id
              ? { userId: appUser.id, displayName: appUser.name, email: appUser.email, crmRole: null, crmEnabled: true }
              : null
          )
        : null;
      setMembers((prev) => prev.map((member) => (
        selectedIds.includes(member.id)
          ? {
              ...member,
              assignedToUserId: targetUserId,
              assignedTo: assignee
                ? { id: assignee.userId, displayName: assignee.displayName || assignee.email, email: assignee.email }
                : null,
            }
          : member
      )));
      const successText = targetUserId === appUser.id
        ? `Assigned ${res.updated} lead${res.updated === 1 ? "" : "s"} to you and added ${res.updated === 1 ? "it" : "them"} to your queue.`
        : targetUserId
          ? `Assigned ${res.updated} lead${res.updated === 1 ? "" : "s"} to ${targetLabel ?? assignee?.displayName ?? "agent"}.`
          : `${res.updated} lead${res.updated === 1 ? "" : "s"} unassigned.`;
      setBulkMsg(successText);
      setToast({ kind: "ok", text: successText });
      setSelected(new Set());
      await Promise.all([loadMembers(), loadCampaign(), loadWorkload()]);
      setTimeout(() => setBulkMsg(""), 3000);
    } catch {
      setBulkMsg("Failed to update assignment");
      setToast({ kind: "err", text: "Failed to update assignment" });
    }
    setBulkAssigning(false);
  }

  async function exportCsv() {
    const t = typeof window !== "undefined" ? localStorage.getItem("token") : null;
    const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
    const url = `${baseUrl}/api/crm/campaigns/${campaignId}/export.csv`;
    const tenantCtx = browserTenantContext();
    try {
      const resp = await fetch(url, {
        headers: {
          ...(t ? { Authorization: `Bearer ${t}` } : {}),
          ...(tenantCtx ? { "x-tenant-context": tenantCtx } : {}),
        },
      });
      if (!resp.ok) throw new Error("Export failed");
      const blob = await resp.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `campaign-${campaignId}-members.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {}
  }

  function toggleSelectAll() {
    const bulkPool = filteredMembers.filter((m) => isAdmin || m.queueWorkEligible !== false);
    if (selected.size > 0 && bulkPool.length > 0 && bulkPool.every((m) => selected.has(m.id))) {
      setSelected(new Set());
    } else {
      setSelected(new Set(bulkPool.map((m) => m.id)));
    }
  }

  const filteredMembers = members.filter((m) => {
    if (!search) return true;
    return (m.contact?.displayName ?? "").toLowerCase().includes(search.toLowerCase());
  });

  const bulkSelectableMembers = filteredMembers.filter((m) => isAdmin || m.queueWorkEligible !== false);
  const membersTotalPages = Math.max(1, Math.ceil(membersTotal / CAMPAIGN_MEMBER_PAGE_SIZE));
  const membersPageStart = membersTotal > 0 ? (membersPage - 1) * CAMPAIGN_MEMBER_PAGE_SIZE + 1 : 0;
  const membersPageEnd = Math.min(membersPage * CAMPAIGN_MEMBER_PAGE_SIZE, membersTotal);

  const queueFilteredHref = `/crm/queue?campaignId=${encodeURIComponent(campaignId)}`;

  const health = useMemo(() => {
    if (!campaign) return null;
    return deriveCampaignHealth(campaign, workload);
  }, [campaign, workload]);

  const importMappingPayload = useMemo(() => {
    const entries = Object.entries(importColumnMapping)
      .filter(([, field]) => field)
      .sort(([a], [b]) => Number(a) - Number(b));
    return Object.fromEntries(entries);
  }, [importColumnMapping]);
  const importMappingFingerprint = useMemo(() => JSON.stringify(importMappingPayload), [importMappingPayload]);
  const importMappingHasContactColumn = useMemo(
    () => Object.values(importMappingPayload).some((field) => field === "phone" || field === "email"),
    [importMappingPayload],
  );
  const importCtxKey = importFile ? importPreviewContextKey(importFile, importAssigneeId, importMappingFingerprint) : null;
  const importReady =
    !!importFile && !!importPreview && !!importCtxKey && importPreviewContextKeyState === importCtxKey;

  const importSampleGroups = useMemo(() => {
    const rows = importPreview?.sampleRows;
    if (!rows?.length) return [] as { bucket: PreviewSampleBucket; rows: CampaignImportPreview["sampleRows"] }[];
    const m = new Map<PreviewSampleBucket, CampaignImportPreview["sampleRows"]>();
    for (const row of rows) {
      const b = bucketPreviewSampleRow(row);
      const list = m.get(b) ?? [];
      list.push(row);
      m.set(b, list);
    }
    return PREVIEW_SAMPLE_BUCKET_ORDER.filter((b) => (m.get(b)?.length ?? 0) > 0).map((b) => ({
      bucket: b,
      rows: m.get(b)!,
    }));
  }, [importPreview]);

  const importCoreMismatch =
    !!(importSummary && importCompareBaseline && importCoreCountsDiffer(importCompareBaseline, importSummary));
  const importSkippedMismatch =
    !!(importSummary && importCompareBaseline && importCompareBaseline.invalidRows !== importSummary.skippedRows);

  if (loading) {
    return (
      <CRMPageShell innerClassName="flex min-h-[40vh] items-center justify-center">
        <p className="text-crm-muted">Loading…</p>
      </CRMPageShell>
    );
  }
  if (!campaign) {
    return (
      <CRMPageShell innerClassName="flex min-h-[40vh] items-center justify-center">
        <p className="text-crm-danger">{error || "Campaign not found"}</p>
      </CRMPageShell>
    );
  }

  const hd = health!;
  const openImportModal = () => {
    setImportOpen(true);
    setImportErr("");
    setImportSummary(null);
    resetImportFileState();
    setImportAssigneeId("");
    setImportCompareBaseline(null);
  };
  const openDistributeModal = () => {
    setDistributeOpen(true);
    setDistributeMsg("");
    setDistributeUserIds(new Set());
  };
  const openBulkEmailAll = () => {
    setSelected(new Set());
    setShowBulkEmail(true);
  };

  return (
    <CRMPageShell
      className="campaign-detail-shell"
      innerClassName={cn(mk.pageInner, mk.workspace, "campaign-detail-page")}
    >
      {showAddContacts && (
        <AddContactsModal
          campaignId={campaignId}
          onClose={() => setShowAddContacts(false)}
          onAdded={() => { loadCampaign(); loadMembers(); }}
        />
      )}

      {showBulkEmail && campaign && (
        <BulkEmailModal
          audience={{
            sourceType: "CAMPAIGN",
            campaignId,
            campaignName: campaign.name,
            contactIds: selected.size > 0
              ? members.filter((m) => selected.has(m.id) && m.contactId).map((m) => m.contactId!)
              : [],
          }}
          onClose={() => setShowBulkEmail(false)}
          onQueued={(res) => {
            setShowBulkEmail(false);
            setSelected(new Set());
            setBulkEmailToast(
              `Bulk email queued: ${res.queuedCount} recipients${res.skippedCount > 0 ? `, ${res.skippedCount} skipped` : ""}`,
            );
            setTimeout(() => setBulkEmailToast(null), 6000);
          }}
        />
      )}

          {/* Distribute modal */}
          {isAdmin && distributeOpen && (
            <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
              <div className="bg-crm-surface rounded-crm-lg shadow-2xl w-full max-w-md p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-bold text-crm-text">Distribute Unassigned Leads</h3>
                  <button onClick={() => setDistributeOpen(false)} className="p-1 text-crm-muted/80 hover:text-crm-muted"><X className="h-5 w-5" /></button>
                </div>
                <p className="text-sm text-crm-muted mb-4">
                  Unassigned pending leads will be distributed evenly (round-robin) across the agents you select below.
                  This action only affects unassigned leads — already-assigned leads are untouched.
                </p>
                <div className="mb-4 max-h-48 overflow-y-auto border border-crm-border rounded-lg divide-y divide-crm-border/60">
                  {crmUsers.filter((u) => u.crmEnabled).length === 0 ? (
                    <p className="p-3 text-sm text-crm-muted/80">No CRM-enabled agents found.</p>
                  ) : (
                    crmUsers.filter((u) => u.crmEnabled).map((u) => (
                      <label key={u.userId} className="flex items-center gap-3 px-3 py-2.5 hover:bg-crm-surface-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={distributeUserIds.has(u.userId)}
                          onChange={(e) => {
                            const s = new Set(distributeUserIds);
                            if (e.target.checked) s.add(u.userId);
                            else s.delete(u.userId);
                            setDistributeUserIds(s);
                          }}
                          className="rounded"
                        />
                        <span className="text-sm text-crm-text">{u.displayName || u.email}</span>
                        <span className="text-xs text-crm-muted/80 ml-auto">{u.crmRole ?? "AGENT"}</span>
                      </label>
                    ))
                  )}
                </div>
                {distributeMsg && (
                  <p className={`text-sm mb-3 ${distributeMsg.startsWith("Distributed") ? "text-crm-success" : "text-crm-warning"}`}>{distributeMsg}</p>
                )}
                <div className="flex gap-2 justify-end">
                  <button onClick={() => setDistributeOpen(false)} className="px-4 py-2 text-sm border border-crm-border rounded-lg text-crm-text hover:bg-crm-surface-2">
                    Cancel
                  </button>
                  <button
                    onClick={handleDistribute}
                    disabled={distributing || distributeUserIds.size === 0}
                    className="px-4 py-2 text-sm bg-crm-accent text-white rounded-lg hover:brightness-110 disabled:opacity-50 flex items-center gap-1.5"
                  >
                    <Shuffle className="h-3.5 w-3.5" />
                    {distributing ? "Distributing…" : `Distribute across ${distributeUserIds.size} agent${distributeUserIds.size !== 1 ? "s" : ""}`}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Import CSV modal */}
          {isAdmin && importOpen && (
            <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
              <div className="bg-crm-surface rounded-crm-lg shadow-2xl w-full max-w-4xl p-6 max-h-[90vh] overflow-y-auto">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-bold text-crm-text">Import leads to campaign</h3>
                  <button
                    type="button"
                    onClick={() => {
                      setImportOpen(false);
                      setImportErr("");
                      setImportSummary(null);
                      resetImportFileState();
                      setImportAssigneeId("");
                      setImportCompareBaseline(null);
                    }}
                    className="p-1 text-crm-muted/80 hover:text-crm-muted"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <p className="text-sm text-crm-muted mb-3">
                  Upload a CSV or Excel file (max 5 MB, up to 5,000 rows). Map each spreadsheet column to the lead field it belongs to.
                  Phone and email can be selected on as many columns as the sheet contains.
                  Existing contacts are matched by phone/email and updated (blank fields only); they are not duplicated.
                  Contacts already in this campaign are skipped for enrollment.
                </p>
                <div className="mb-4">
                  <label className="block text-xs font-medium text-crm-muted mb-1">Lead file</label>
                  <input
                    type="file"
                    accept=".csv,text/csv,.xlsx,.xls,.ods,.numbers,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                    onChange={(e) => void handleImportFileChange(e.currentTarget.files?.[0] ?? null)}
                    className="block w-full text-sm text-crm-muted file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-crm-accent/15 file:text-crm-accent"
                  />
                  <p className="text-xs text-crm-muted/80 mt-1">
                    Supported: CSV, XLSX, XLS, ODS. Excel files are converted locally before upload.
                  </p>
                </div>
                {importHeaders.length > 0 && (
                  <div className="mb-4 rounded-lg border border-crm-border bg-crm-surface-2/50 p-3">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between mb-3">
                      <div>
                        <p className="text-sm font-semibold text-crm-text">Map columns to lead fields</p>
                        <p className="text-xs text-crm-muted">
                          {importDisplayFileName || "Selected file"} · {importHeaders.length} column{importHeaders.length === 1 ? "" : "s"} detected
                        </p>
                      </div>
                      <span className={cn(
                        "text-xs rounded-full border px-2 py-1",
                        importMappingHasContactColumn
                          ? "border-crm-success/30 bg-crm-success/10 text-crm-success"
                          : "border-crm-warning/35 bg-crm-warning/10 text-crm-warning",
                      )}>
                        {importMappingHasContactColumn ? "Phone/email mapped" : "Map phone or email"}
                      </span>
                    </div>
                    <div className="max-h-72 overflow-y-auto rounded-lg border border-crm-border bg-crm-surface">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-left text-crm-muted border-b border-crm-border bg-crm-surface-2/70">
                            <th className="p-2 font-medium">Column</th>
                            <th className="p-2 font-medium">Header</th>
                            <th className="p-2 font-medium">Sample</th>
                            <th className="p-2 font-medium min-w-[210px]">Lead field</th>
                          </tr>
                        </thead>
                        <tbody>
                          {importHeaders.map((header, idx) => (
                            <tr key={`${idx}-${header}`} className="border-b border-crm-border/50">
                              <td className="p-2 text-crm-muted whitespace-nowrap">Column {idx + 1}</td>
                              <td className="p-2 text-crm-text max-w-[160px] truncate" title={header || `Column ${idx + 1}`}>
                                {header || `Column ${idx + 1}`}
                              </td>
                              <td className="p-2 text-crm-muted max-w-[180px] truncate" title={importSampleRow[idx] ?? ""}>
                                {importSampleRow[idx] || "—"}
                              </td>
                              <td className="p-2">
                                <ConnectSelect
                                  value={importColumnMapping[String(idx)] ?? ""}
                                  onChange={(value) => {
                                    setImportColumnMapping((prev) => ({ ...prev, [String(idx)]: value }));
                                  }}
                                  className="w-full"
                                  options={IMPORT_FIELD_OPTIONS}
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-xs text-crm-muted/80 mt-2">
                      Use Phone number or Email on every matching column. Company name is still written to the import audit rows used by Drive document matching.
                    </p>
                  </div>
                )}
                <div className="mb-4">
                  <label className="block text-xs font-medium text-crm-muted mb-1">Assign new members to (optional)</label>
                  <ConnectSelect
                    value={importAssigneeId}
                    onChange={(value) => setImportAssigneeId(value)}
                    className="w-full"
                    options={[
                      { value: "", label: "— Unassigned —" },
                      ...crmUsers.filter((u) => u.crmEnabled).map((u) => ({ value: u.userId, label: u.displayName || u.email })),
                    ]}
                  />
                  <p className="text-xs text-crm-muted/80 mt-1">Changing the assignee clears the preview — run Preview import again.</p>
                </div>
                <div className="mb-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCampaignImportPreview()}
                    disabled={importPreviewing || !importFile || !importMappingHasContactColumn}
                    className="px-4 py-2 text-sm border border-crm-border rounded-lg text-crm-text hover:bg-crm-surface-2 disabled:opacity-50"
                  >
                    {importPreviewing ? "Previewing…" : "Preview import"}
                  </button>
                </div>
                {importFile && !importPreview && !importPreviewing && (
                  <p className="text-sm text-crm-muted mb-3">
                    Review the column mapping, then run Preview import to see exactly what will happen.
                  </p>
                )}
                {importPreview && importFile && importCtxKey === importPreviewContextKeyState && (
                  <div className="mb-4 p-3 bg-crm-accent/15 border border-crm-accent/25 rounded-lg text-sm space-y-3">
                    <div>
                      <p className="font-semibold text-crm-text">Preview (dry-run — nothing saved yet)</p>
                      <p className="text-crm-muted text-xs mt-0.5">
                        Total rows: {importPreview.totalRows} · Valid rows: {importPreview.validRows} · Data rows counted as invalid in preview:{" "}
                        {importPreview.invalidRows}
                      </p>
                    </div>
                    {importPreview.invalidRows > 0 && (
                      <p className="text-crm-warning text-sm bg-crm-warning/10 border border-crm-warning/35 rounded-md px-2 py-1.5">
                        {importPreview.invalidRows} row{importPreview.invalidRows !== 1 ? "s" : ""} will be skipped (no usable phone/email or could not be processed in preview). They are still listed in samples or errors where applicable.
                      </p>
                    )}
                    {importPreview.wouldSkipExistingMembers > 0 && (
                      <p className="text-crm-warning text-sm bg-crm-warning/10 border border-crm-warning/35 rounded-md px-2 py-1.5">
                        {importPreview.wouldSkipExistingMembers} row{importPreview.wouldSkipExistingMembers !== 1 ? "s" : ""} match contacts already in this campaign — they will not be added again as members.
                      </p>
                    )}
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      <div className="rounded-lg border border-crm-accent/25 bg-crm-surface p-2 shadow-crm">
                        <p className="text-[11px] text-crm-muted uppercase tracking-wide">New contacts</p>
                        <p className="text-lg font-semibold text-crm-text">{importPreview.wouldCreateContacts}</p>
                      </div>
                      <div className="rounded-lg border border-crm-accent/25 bg-crm-surface p-2 shadow-crm">
                        <p className="text-[11px] text-crm-muted uppercase tracking-wide">Contacts updated</p>
                        <p className="text-lg font-semibold text-crm-text">{importPreview.wouldUpdateContacts}</p>
                      </div>
                      <div className="rounded-lg border border-crm-accent/25 bg-crm-surface p-2 shadow-crm">
                        <p className="text-[11px] text-crm-muted uppercase tracking-wide">New campaign members</p>
                        <p className="text-lg font-semibold text-crm-success">{importPreview.wouldAddMembers}</p>
                      </div>
                      <div className="rounded-lg border border-crm-accent/25 bg-crm-surface p-2 shadow-crm">
                        <p className="text-[11px] text-crm-muted uppercase tracking-wide">Already in campaign</p>
                        <p className="text-lg font-semibold text-crm-text">{importPreview.wouldSkipExistingMembers}</p>
                      </div>
                      <div className="rounded-lg border border-crm-accent/25 bg-crm-surface p-2 shadow-crm">
                        <p className="text-[11px] text-crm-muted uppercase tracking-wide">Invalid / skipped rows</p>
                        <p className="text-lg font-semibold text-crm-warning">{importPreview.invalidRows}</p>
                      </div>
                    </div>
                    <p className="text-sm font-medium text-crm-success bg-crm-success/10 border border-crm-success/30 rounded-md px-2 py-1.5">
                      Ready to import this file — preview matches the selected file, mapping, and assignee.
                    </p>
                    {importSampleGroups.length > 0 ? (
                      <div className="space-y-3">
                        {importSampleGroups.map(({ bucket, rows }) => (
                          <div key={bucket}>
                            <p className="text-xs font-semibold text-crm-text mb-1">{PREVIEW_SAMPLE_BUCKET_LABEL[bucket]} (sample)</p>
                            <div className="max-h-36 overflow-y-auto border border-crm-accent/25 rounded bg-crm-surface">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-left text-crm-muted border-b bg-crm-surface-2/60">
                                    <th className="p-1.5">Row</th>
                                    <th className="p-1.5">Phone</th>
                                    <th className="p-1.5">Email</th>
                                    <th className="p-1.5">Contact</th>
                                    <th className="p-1.5">Member</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {rows.map((s) => (
                                    <tr key={s.row} className="border-b border-crm-border/50">
                                      <td className="p-1.5">{s.row}</td>
                                      <td className="p-1.5">{s.phone ?? "—"}</td>
                                      <td className="p-1.5 truncate max-w-[100px]" title={s.email}>{s.email ?? "—"}</td>
                                      <td className="p-1.5">
                                        {labelContactOutcome(s.outcome)}
                                        {s.reason ? ` (${s.reason})` : ""}
                                      </td>
                                      <td className="p-1.5">{labelMemberOutcome(s.member)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : importPreview.sampleRows && importPreview.sampleRows.length > 0 ? (
                      <div>
                        <p className="text-xs font-medium text-crm-muted mb-1">
                          Sample rows — shown in one list (could not group by outcome from this response).
                        </p>
                        <div className="max-h-36 overflow-y-auto border border-crm-accent/25 rounded bg-crm-surface">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-left text-crm-muted border-b bg-crm-surface-2/60">
                                <th className="p-1.5">Row</th>
                                <th className="p-1.5">Phone</th>
                                <th className="p-1.5">Email</th>
                                <th className="p-1.5">Raw contact</th>
                                <th className="p-1.5">Raw member</th>
                              </tr>
                            </thead>
                            <tbody>
                              {importPreview.sampleRows.map((s) => (
                                <tr key={s.row} className="border-b border-crm-border/50">
                                  <td className="p-1.5">{s.row}</td>
                                  <td className="p-1.5">{s.phone ?? "—"}</td>
                                  <td className="p-1.5 truncate max-w-[100px]" title={s.email}>{s.email ?? "—"}</td>
                                  <td className="p-1.5">{s.outcome ?? "—"}{s.reason ? ` (${s.reason})` : ""}</td>
                                  <td className="p-1.5">{s.member ?? "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ) : null}
                    {importPreview.errors?.length > 0 && (
                      <ul className="text-xs text-crm-warning list-disc pl-4 max-h-24 overflow-y-auto">
                        {importPreview.errors.map((er) => (
                          <li key={`${er.row}-${er.reason}`}>Row {er.row}: {er.reason}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {importErr && <p className="text-sm text-crm-danger mb-3">{importErr}</p>}
                {importSummary && (
                  <div className="mb-4 p-3 bg-crm-surface-2/60 border border-crm-border rounded-lg text-sm space-y-3">
                    <p className="font-semibold text-crm-text">Import complete — {importSummary.status}</p>
                    {importCompareBaseline ? (
                      <>
                        {importCoreMismatch && (
                          <p className="text-crm-warning text-sm font-medium border border-crm-warning/35 bg-crm-warning/10 rounded-md px-2 py-1.5">
                            Data may have changed since preview — core totals differ from the dry-run.
                          </p>
                        )}
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs border-collapse min-w-[420px]">
                            <thead>
                              <tr className="text-left text-crm-muted border-b border-crm-border">
                                <th className="py-2 pr-2 font-medium">Metric</th>
                                <th className="py-2 pr-2 font-medium">Preview (expected)</th>
                                <th className="py-2 pr-2 font-medium">Import (actual)</th>
                                <th className="py-2 font-medium">Match</th>
                              </tr>
                            </thead>
                            <tbody className="text-crm-text">
                              {(
                                [
                                  ["Contacts created", importCompareBaseline.wouldCreateContacts, importSummary.createdContacts],
                                  ["Contacts updated", importCompareBaseline.wouldUpdateContacts, importSummary.updatedContacts],
                                  ["Members added", importCompareBaseline.wouldAddMembers, importSummary.addedMembers],
                                  ["Skipped (already in campaign)", importCompareBaseline.wouldSkipExistingMembers, importSummary.skippedExistingMembers],
                                ] as const
                              ).map(([label, exp, act]) => {
                                const ok = exp === act;
                                return (
                                  <tr key={label} className="border-b border-crm-border/60">
                                    <td className="py-1.5 pr-2">{label}</td>
                                    <td className="py-1.5 pr-2 tabular-nums">{exp}</td>
                                    <td className="py-1.5 pr-2 tabular-nums">{act}</td>
                                    <td className="py-1.5">{ok ? <span className="text-crm-success">Yes</span> : <span className="text-crm-warning font-medium">No</span>}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        {importSkippedMismatch && (
                          <p className="text-xs text-crm-muted">
                            Preview counted {importCompareBaseline.invalidRows} invalid row{importCompareBaseline.invalidRows !== 1 ? "s" : ""}; import skipped{" "}
                            {importSummary.skippedRows} row{importSummary.skippedRows !== 1 ? "s" : ""} (e.g. no phone/email). Small differences can be normal if rows overlap categories.
                          </p>
                        )}
                      </>
                    ) : null}
                    <p className="text-crm-text">Rows processed: {importSummary.totalRows}</p>
                    <p>Contacts created: {importSummary.createdContacts}</p>
                    <p>Contacts updated: {importSummary.updatedContacts}</p>
                    <p>Rows skipped (no phone/email): {importSummary.skippedRows}</p>
                    <p className="text-crm-success font-medium">Members added to campaign: {importSummary.addedMembers}</p>
                    <p>Already in campaign (skipped): {importSummary.skippedExistingMembers}</p>
                    {importSummary.errorCount > 0 && (
                      <p className="text-crm-warning">Row errors: {importSummary.errorCount}</p>
                    )}
                    {importSummary.errors?.length > 0 && (
                      <ul className="text-xs text-crm-muted max-h-24 overflow-y-auto list-disc pl-4 mt-1">
                        {importSummary.errors.slice(0, 10).map((er) => (
                          <li key={`${er.row}-${er.reason}`}>Row {er.row}: {er.reason}</li>
                        ))}
                      </ul>
                    )}
                    {(importSummary.status === "DONE" || importSummary.status === "PARTIAL") && (
                      <a
                        href={`/crm/drive/match/${encodeURIComponent(importSummary.batchId)}`}
                        style={{ fontSize: "0.8125rem", color: "var(--accent)", fontWeight: 600, textDecoration: "none" }}
                      >
                        Match Drive documents →
                      </a>
                    )}
                  </div>
                )}
                <div className="flex gap-2 justify-end flex-wrap">
                  {importSummary && (
                    <button
                      type="button"
                      onClick={() => {
                        setImportSummary(null);
                        setImportFile(null);
                        setImportErr("");
                        setImportPreview(null);
                        setImportPreviewContextKeyState(null);
                        setImportCompareBaseline(null);
                      }}
                      className="px-4 py-2 text-sm border border-crm-border rounded-lg text-crm-text hover:bg-crm-surface-2 mr-auto"
                    >
                      Import another
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setImportOpen(false);
                      setImportErr("");
                      setImportSummary(null);
                      resetImportFileState();
                      setImportAssigneeId("");
                      setImportCompareBaseline(null);
                    }}
                    className="px-4 py-2 text-sm border border-crm-border rounded-lg text-crm-text hover:bg-crm-surface-2"
                  >
                    {importSummary ? "Close" : "Cancel"}
                  </button>
                  {!importSummary && (
                    <button
                      type="button"
                      onClick={() => void handleCampaignImport()}
                      disabled={importing || importPreviewing || !importReady}
                      className="px-4 py-2 text-sm bg-crm-accent text-white rounded-lg hover:brightness-110 disabled:opacity-50 flex items-center gap-1.5"
                      title={!importReady ? "Preview import first for this file, mapping, and assignee" : undefined}
                    >
                      <Upload className="h-3.5 w-3.5" />
                      {importing ? "Importing…" : "Run import"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}


        {toast ? (
          <div
            className={cn(
              "mb-3 rounded-crm border px-4 py-2 text-sm font-medium",
              toast.kind === "ok"
                ? "border-crm-success/30 bg-crm-success/10 text-crm-success"
                : "border-crm-danger/30 bg-crm-danger/10 text-crm-danger",
            )}
          >
            {toast.text}
          </div>
        ) : null}

        {showEditCampaign && campaign ? (
          <EditCampaignModal
            campaign={campaign}
            onClose={() => setShowEditCampaign(false)}
            onSave={async (data) => {
              await updateCampaign(data);
            }}
          />
        ) : null}

        <CrmConfirmModal
          open={deleteConfirmOpen}
          title="Delete campaign?"
          description={
            campaign.status === "ACTIVE"
              ? "This campaign is active. Deleting removes it from default lists and queue work. All members and history are preserved."
              : "Deleted campaigns are hidden from default lists. Members and history are preserved."
          }
          confirmLabel="Delete"
          destructive
          loading={deleteWorking}
          onConfirm={() => void handleDeleteCampaign()}
          onCancel={() => setDeleteConfirmOpen(false)}
        />

        <CRMWorkspaceShell className="campaign-detail-workspace-shell">
          <CRMWorkspaceChrome className="campaign-detail-workspace-chrome">
            <CRMWorkspaceHeader>
              <CampaignCommandHeader
                campaign={campaign}
                health={hd}
                importHistory={importHistory}
                isAdmin={isAdmin}
                canImport={canImport}
                editingName={editingName}
                nameInput={nameInput}
                onNameInput={setNameInput}
                onStartEditName={() => setEditingName(true)}
                onSaveName={saveName}
                onCancelEditName={() => setEditingName(false)}
                onUpdateStatus={(status: CampaignStatus) => updateCampaign({ status })}
                onRequestDelete={() => setDeleteConfirmOpen(true)}
                onEditCampaign={canManageCampaigns ? () => setShowEditCampaign(true) : undefined}
                canEditCampaign={canManageCampaigns}
                onExport={exportCsv}
                onImport={openImportModal}
                onAddContacts={() => setShowAddContacts(true)}
                onDistribute={openDistributeModal}
                onBulkEmail={canManageCampaigns ? openBulkEmailAll : undefined}
              />
            </CRMWorkspaceHeader>

            <CRMWorkspaceToolbar className="campaign-detail-toolbar">
              <div className="funders-filter-card crm-queue-filter-bar">
                <div className="funders-filter-grid campaign-detail-funders-filter-grid">
                  <div className="funders-search-field relative min-w-0">
                    <Search size={16} className="funders-search-icon pointer-events-none absolute text-slate-400" />
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="funders-control funders-control-search"
                      placeholder="Name, phone, email, company…"
                    />
                  </div>
                  <ConnectSelect
                    value={statusFilter}
                    onChange={(value) => {
                      setMembersPage(1);
                      setStatusFilter(value);
                    }}
                    size="sm"
                    className="funders-control"
                    options={[
                      { value: "", label: "All statuses" },
                      ...(Object.keys(MEMBER_STATUS_LABELS) as MemberStatus[]).map((s) => ({ value: s, label: MEMBER_STATUS_LABELS[s] })),
                    ]}
                  />
                  <ConnectSelect
                    value={assigneeFilter}
                    onChange={(value) => {
                      setMembersPage(1);
                      setAssigneeFilter(value);
                    }}
                    size="sm"
                    className="funders-control"
                    options={[
                      { value: "", label: "All agents" },
                      { value: "UNASSIGNED", label: "Unassigned" },
                      ...crmUsers.filter((u) => u.crmEnabled).map((u) => ({ value: u.userId, label: u.displayName || u.email })),
                    ]}
                  />
                </div>
              </div>

              {bulkEmailToast ? (
                <div className="campaign-detail-inline-toast">
                  {bulkEmailToast}
                </div>
              ) : null}

              {selected.size > 0 ? (
                <div className="campaign-detail-bulk-bar">
                  <span className="text-sm font-medium text-crm-text">{selected.size} selected</span>
                  <button
                    type="button"
                    onClick={() => void handleBulkAssign(appUser.id, appUser.name || appUser.email)}
                    disabled={bulkAssigning}
                    className={cn(crm.btnPrimary, "h-8 px-3 py-1 text-xs gap-1.5 shrink-0")}
                  >
                    <UserPlus className="h-3.5 w-3.5" />
                    Assign Me
                  </button>
                  <div className="campaign-detail-bulk-assignee flex items-center gap-2">
                    <UserPlus className="h-4 w-4 shrink-0 text-crm-accent" />
                    <ConnectSelect
                      value={bulkAssignUserId}
                      onChange={(value) => setBulkAssignUserId(value)}
                      size="sm"
                      placeholder="Select agent…"
                      className={cn("min-w-0 flex-1")}
                      options={crmUsers.filter((u) => u.crmEnabled).map((u) => ({ value: u.userId, label: u.displayName || u.email }))}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const agent = crmUsers.find((u) => u.userId === bulkAssignUserId);
                      void handleBulkAssign(bulkAssignUserId || null, agent?.displayName || agent?.email);
                    }}
                    disabled={bulkAssigning || !bulkAssignUserId}
                    className={cn(crm.btnSecondary, "h-8 px-3 py-1 text-xs shrink-0 disabled:opacity-50")}
                  >
                    {bulkAssigning ? "Assigning…" : "Assign Agent"}
                  </button>
                  {isAdmin ? (
                    <button
                      type="button"
                      onClick={() => setShowBulkEmail(true)}
                      className={cn(crm.btnSecondary, "h-8 px-3 py-1 text-xs gap-1.5 shrink-0")}
                    >
                      <Mail className="h-3.5 w-3.5" />
                      Bulk Email
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={exportCsv}
                    className={cn(crm.btnSecondary, "h-8 px-3 py-1 text-xs gap-1.5 shrink-0")}
                  >
                    <Download className="h-3.5 w-3.5" />
                    Export
                  </button>
                  <button type="button" onClick={() => setSelected(new Set())} className="p-1 text-crm-muted hover:text-crm-accent shrink-0" aria-label="Clear selection">
                    <X className="h-4 w-4" />
                  </button>
                  {bulkMsg ? <span className="text-xs font-medium text-crm-accent">{bulkMsg}</span> : null}
                </div>
              ) : null}
            </CRMWorkspaceToolbar>

          </CRMWorkspaceChrome>

          <CRMWorkspaceBody split className="campaign-detail-workbench">
            <CRMWorkspaceMain className="campaign-detail-contact-workspace">
              <CRMWorkspaceScrollRegion className="campaign-detail-main-scroll">
                <section id="campaign-roster" className={cn(mk.rosterShell, "campaign-detail-roster-shell funders-table-shell")} aria-label={`Members (${membersTotal})`}>
              <div className="campaign-detail-roster-scroll funders-table-scroll">
                {membersLoading ? (
                  <div className="py-12 text-center text-sm text-crm-muted/80">Loading members…</div>
                ) : filteredMembers.length === 0 ? (
                  <CampaignGuidedEmpty
                    icon={<Users className="h-5 w-5" />}
                    title={hd.total === 0 ? "No members yet" : "No members match filters"}
                    steps={
                      hd.total === 0
                        ? [
                            { label: "Import leads", hint: "CSV/XLSX with mapping preview" },
                            { label: "Add existing contacts", hint: "from CRM roster" },
                            { label: "Distribute work", hint: "assign agents" },
                          ]
                        : [{ label: "Clear filters", hint: "search, status, or agent" }]
                    }
                    action={
                      <>
                        {canImport && hd.total === 0 ? (
                          <button type="button" onClick={openImportModal} className={crm.btnPrimary}>
                            Import leads
                          </button>
                        ) : null}
                        <button type="button" onClick={() => setShowAddContacts(true)} className={crm.btnSecondary}>
                          Add contacts
                        </button>
                        {isAdmin && hd.total === 0 ? (
                          <button type="button" onClick={openDistributeModal} className={crm.campaignDetailBtnSecondary}>
                            Distribute
                          </button>
                        ) : null}
                        {canQueue && hd.activeQueueWork > 0 ? (
                          <Link href={`/crm/queue?campaignId=${encodeURIComponent(campaignId)}`} className={crm.campaignDetailBtnSecondary}>
                            Open queue
                          </Link>
                        ) : null}
                      </>
                    }
                  />
                ) : (
                  <>
                    <div className="crm-funder-list-controls-card">
                      <div className="crm-queue-list-head">
                        <label className="flex cursor-pointer items-center gap-2 text-xs text-crm-muted">
                          <input
                            type="checkbox"
                            className={crm.checkbox}
                            checked={bulkSelectableMembers.length > 0 && bulkSelectableMembers.every((m) => selected.has(m.id))}
                            onChange={toggleSelectAll}
                            title="Select all visible members"
                          />
                          <span>Select active on this page (up to {CAMPAIGN_MEMBER_PAGE_SIZE})</span>
                        </label>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-semibold text-crm-muted tabular-nums">
                            Showing {membersPageStart}-{membersPageEnd} of {membersTotal}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="crm-queue-list-panel crm-funder-list-rows-card">
                      <div className="crm-queue-row-list funders-table-body">
                        {filteredMembers.map((m, index) => {
                          const archivedLead = m.queueWorkEligible === false;
                          const agentCannotAct = !isAdmin && archivedLead;
                          return (
                            <CampaignMemberCard
                              key={m.id}
                              member={m}
                              campaignId={campaignId}
                              rowMode
                              rowNumber={(membersPage - 1) * CAMPAIGN_MEMBER_PAGE_SIZE + index + 1}
                              selected={selected.has(m.id)}
                              readOnly={agentCannotAct}
                              onSelect={(checked) => {
                                const s = new Set(selected);
                                if (checked) s.add(m.id);
                                else s.delete(m.id);
                                setSelected(s);
                              }}
                              onUpdated={loadMembers}
                              onStatusChange={updateMemberStatus}
                              token={token}
                            />
                          );
                        })}
                      </div>
                      {membersTotalPages > 1 ? (
                        <div className="flex items-center justify-between gap-3 border-t border-crm-border/60 px-4 py-2.5 text-xs text-crm-muted/80">
                          <span>
                            Page {membersPage} of {membersTotalPages}
                          </span>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              className="campaigns-btn-secondary px-3 py-1.5 text-xs"
                              disabled={membersLoading || membersPage <= 1}
                              onClick={() => setMembersPage((p) => Math.max(1, p - 1))}
                            >
                              Previous
                            </button>
                            <button
                              type="button"
                              className="campaigns-btn-primary px-3 py-1.5 text-xs"
                              disabled={membersLoading || membersPage >= membersTotalPages}
                              onClick={() => setMembersPage((p) => Math.min(membersTotalPages, p + 1))}
                            >
                              Next
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
                </section>
              </CRMWorkspaceScrollRegion>
            </CRMWorkspaceMain>
            <CRMWorkspaceRightRail
              className="campaign-detail-right-rail crm-queue-detail-rail flex flex-col min-h-0"
              scrollClassName="campaign-detail-right-rail-scroll"
            >
              <CampaignDetailRightRail
                campaign={campaign}
                health={hd}
                canQueue={canQueue}
              />
            </CRMWorkspaceRightRail>
          </CRMWorkspaceBody>
        </CRMWorkspaceShell>
    </CRMPageShell>
  );
}
