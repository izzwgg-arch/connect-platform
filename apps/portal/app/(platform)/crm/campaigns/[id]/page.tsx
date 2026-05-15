"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, Play, Pause, Archive, Users, Plus, Search,
  PhoneCall, X, Edit2, Save, Download, UserPlus, CheckSquare2, Square, CalendarClock,
  Shuffle, BarChart2, Upload, History, ListOrdered, ChevronDown,
} from "lucide-react";
import { apiGet, apiPost, apiPatch } from "../../../../../services/apiClient";
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
  PENDING: "bg-gray-100 text-gray-700 border-gray-200",
  PROCESSING: "bg-blue-50 text-blue-800 border-blue-200",
  DONE: "bg-green-50 text-green-800 border-green-200",
  PARTIAL: "bg-amber-50 text-amber-900 border-amber-200",
  FAILED: "bg-red-50 text-red-800 border-red-200",
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

function formatImportTimestamp(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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

function importPreviewContextKey(file: File | null, assigneeId: string): string | null {
  if (!file) return null;
  return `${file.name}:${file.size}:${file.lastModified}|assignee:${assigneeId || ""}`;
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

type Script = { id: string; name: string };
type Checklist = { id: string; name: string };

// ── Constants ──────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<CampaignStatus, string> = {
  DRAFT: "Draft", ACTIVE: "Active", PAUSED: "Paused", COMPLETED: "Completed", ARCHIVED: "Archived",
};

const STATUS_COLORS: Record<CampaignStatus, string> = {
  DRAFT: "bg-gray-100 text-gray-600",
  ACTIVE: "bg-green-100 text-green-700",
  PAUSED: "bg-yellow-100 text-yellow-700",
  COMPLETED: "bg-blue-100 text-blue-700",
  ARCHIVED: "bg-gray-100 text-gray-400",
};

const PRIORITY_LABELS: Record<CampaignPriority, string> = {
  LOW: "Low", NORMAL: "Normal", HIGH: "High", URGENT: "Urgent",
};

const PRIORITY_COLORS: Record<CampaignPriority, string> = {
  LOW: "bg-gray-100 text-gray-500",
  NORMAL: "bg-gray-100 text-gray-600",
  HIGH: "bg-orange-100 text-orange-700",
  URGENT: "bg-red-100 text-red-700",
};

const MEMBER_STATUS_LABELS: Record<MemberStatus, string> = {
  PENDING: "Pending", IN_PROGRESS: "In Progress", CONTACTED: "Contacted",
  CALLBACK: "Callback", CONVERTED: "Converted", SKIPPED: "Skipped", DO_NOT_CALL: "DNC",
};

const MEMBER_STATUS_COLORS: Record<MemberStatus, string> = {
  PENDING: "bg-gray-100 text-gray-600",
  IN_PROGRESS: "bg-blue-100 text-blue-700",
  CONTACTED: "bg-purple-100 text-purple-700",
  CALLBACK: "bg-yellow-100 text-yellow-700",
  CONVERTED: "bg-green-100 text-green-700",
  SKIPPED: "bg-gray-100 text-gray-500",
  DO_NOT_CALL: "bg-red-100 text-red-700",
};

function HealthTile({
  label,
  value,
  hint,
  urgent,
}: {
  label: string;
  value: string | number;
  hint?: string;
  urgent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border px-3 py-2.5 ${
        urgent ? "border-amber-200 bg-amber-50/60" : "border-gray-200 bg-gray-50/80"
      }`}
    >
      <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${urgent ? "text-amber-900" : "text-gray-900"}`}>{value}</p>
      {hint ? <p className="text-[11px] text-gray-500 mt-0.5 leading-snug">{hint}</p> : null}
    </div>
  );
}

// ── Callback Cell ─────────────────────────────────────────────────────────────

function CallbackCell({ member, campaignId, onUpdated, token, readOnly }: {
  member: Member; campaignId: string; onUpdated: () => void; token: string | undefined;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(() => {
    if (!member.callbackAt) return "";
    const d = new Date(member.callbackAt);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await apiPatch(
        `/crm/campaigns/${campaignId}/members/${member.id}`,
        {
          callbackAt: value ? new Date(value).toISOString() : null,
          ...(value && member.status !== "CALLBACK" ? { status: "CALLBACK" } : {}),
        },
        token
      );
      setEditing(false);
      onUpdated();
    } catch {}
    setSaving(false);
  }

  async function clear() {
    setSaving(true);
    try {
      await apiPatch(`/crm/campaigns/${campaignId}/members/${member.id}`, { callbackAt: null, callbackNote: null }, token);
      setValue("");
      setEditing(false);
      onUpdated();
    } catch {}
    setSaving(false);
  }

  if (readOnly) {
    if (member.callbackAt) {
      const d = new Date(member.callbackAt);
      return (
        <span className="text-xs text-gray-500">
          {d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}{" "}
          {d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
        </span>
      );
    }
    return <span className="text-xs text-gray-400">—</span>;
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <input
          type="datetime-local"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="border border-gray-300 rounded px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 w-36"
        />
        <button onClick={save} disabled={saving} className="text-xs px-1.5 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">✓</button>
        <button onClick={() => setEditing(false)} className="text-xs px-1.5 py-1 border border-gray-300 rounded hover:bg-gray-50">✕</button>
      </div>
    );
  }

  if (member.callbackAt) {
    const d = new Date(member.callbackAt);
    const isPast = d < new Date();
    return (
      <div className="flex items-center gap-1">
        <span className={`text-xs ${isPast ? "text-red-600 font-medium" : "text-yellow-700"}`}>
          {d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} {d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
        </span>
        <button onClick={() => setEditing(true)} className="text-gray-400 hover:text-gray-600 p-0.5"><Edit2 className="h-3 w-3" /></button>
        <button onClick={clear} disabled={saving} className="text-gray-400 hover:text-red-500 p-0.5"><X className="h-3 w-3" /></button>
      </div>
    );
  }

  return (
    <button onClick={() => setEditing(true)} className="text-xs text-gray-400 hover:text-blue-600 flex items-center gap-1">
      <CalendarClock className="h-3.5 w-3.5" />Set
    </button>
  );
}

// ── Add Contacts Modal (server-side search) ───────────────────────────────────

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
  const LIMIT = 20;

  const token = typeof window !== "undefined" ? localStorage.getItem("token") ?? undefined : undefined;

  const fetchContacts = useCallback(async (q: string, pg: number) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(LIMIT), page: String(pg) });
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

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col">
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">Add Contacts to Campaign</h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-3 border-b">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              autoFocus
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Search by name, phone, or email…"
            />
          </div>
          {total > 0 && (
            <p className="text-xs text-gray-400 mt-1.5 px-1">{total} contact{total !== 1 ? "s" : ""} available</p>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-8 text-center text-gray-400 text-sm">Searching…</div>
          ) : contacts.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">
              {search ? "No contacts match your search." : "All CRM contacts are already in this campaign."}
            </div>
          ) : (
            <>
              {contacts.map((c) => (
                <label key={c.id} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 cursor-pointer border-b last:border-b-0">
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
                    <p className="text-sm font-medium text-gray-900 truncate">{c.displayName}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {[c.primaryPhone, c.primaryEmail, c.company].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  {c.crmStage && (
                    <span className="text-xs text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded shrink-0">{c.crmStage}</span>
                  )}
                </label>
              ))}
            </>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-4 py-2 border-t flex items-center justify-between text-xs text-gray-500">
            <button disabled={page === 1} onClick={() => handlePageChange(page - 1)} className="px-2 py-1 border rounded disabled:opacity-40 hover:bg-gray-50">Previous</button>
            <span>Page {page} of {totalPages}</span>
            <button disabled={page === totalPages} onClick={() => handlePageChange(page + 1)} className="px-2 py-1 border rounded disabled:opacity-40 hover:bg-gray-50">Next</button>
          </div>
        )}

        <div className="p-4 border-t flex items-center justify-between gap-2">
          <span className="text-sm text-gray-500">{selected.size} selected</span>
          {error && <span className="text-xs text-red-600">{error}</span>}
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-2 text-sm border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50">Cancel</button>
            <button onClick={handleAdd} disabled={saving || selected.size === 0} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
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
  const { backendJwtRole } = useAppContext();

  const isAdmin =
    backendJwtRole === "ADMIN" ||
    backendJwtRole === "TENANT_ADMIN" ||
    backendJwtRole === "SUPER_ADMIN";

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [membersTotal, setMembersTotal] = useState(0);
  const [crmUsers, setCrmUsers] = useState<CrmUser[]>([]);
  const [scripts, setScripts] = useState<Script[]>([]);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [loading, setLoading] = useState(true);
  const [membersLoading, setMembersLoading] = useState(false);
  const [showAddContacts, setShowAddContacts] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("");
  // "" = all agents, "UNASSIGNED" = null, else userId
  const [assigneeFilter, setAssigneeFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [error, setError] = useState("");

  // Workload summary (admin — loaded automatically for health + workload strip)
  const [workload, setWorkload] = useState<WorkloadRow[]>([]);
  const [workloadLoading, setWorkloadLoading] = useState(false);

  // Distribute modal
  const [distributeOpen, setDistributeOpen] = useState(false);
  const [distributeUserIds, setDistributeUserIds] = useState<Set<string>>(new Set());
  const [distributing, setDistributing] = useState(false);
  const [distributeMsg, setDistributeMsg] = useState("");

  // CSV import into campaign (admin — matches API requireCrmAdmin)
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
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

  const [importHistory, setImportHistory] = useState<CampaignImportHistoryRow[]>([]);
  const [importHistoryLoading, setImportHistoryLoading] = useState(false);

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

  const loadCampaign = useCallback(async () => {
    try {
      const res = await apiGet<{ campaign: Campaign }>(`/crm/campaigns/${campaignId}`, token);
      setCampaign(res.campaign);
      setNameInput(res.campaign.name);
    } catch (err: unknown) {
      setError((err as Error)?.message ?? "Not found");
    }
  }, [campaignId, token]);

  const loadMembers = useCallback(async (overrideAssignee?: string) => {
    setMembersLoading(true);
    try {
      const af = overrideAssignee !== undefined ? overrideAssignee : assigneeFilter;
      const queryParams = new URLSearchParams({ limit: "100" });
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
  }, [campaignId, statusFilter, assigneeFilter, token]);

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
        apiGet<{ scripts: Script[] }>("/crm/scripts", token).then((res) => setScripts(res.scripts)).catch(() => {}),
        apiGet<{ checklists: Checklist[] }>("/crm/checklists", token).then((res) => setChecklists(res.checklists)).catch(() => {}),
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
    } catch {}
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

  async function handleCampaignImport() {
    if (!importFile) {
      setImportErr("Choose a CSV file.");
      return;
    }
    const ctx = importPreviewContextKey(importFile, importAssigneeId);
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
      if (importAssigneeId) fd.append("assignedToUserId", importAssigneeId);
      const t = typeof window !== "undefined" ? localStorage.getItem("token") : null;
      const base = typeof window !== "undefined" ? window.location.origin : "";
      const res = await fetch(`${base}/api/crm/campaigns/${campaignId}/import`, {
        method: "POST",
        headers: t ? { Authorization: `Bearer ${t}` } : {},
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
      setImportFile(null);
      setImportPreview(null);
      setImportPreviewContextKeyState(null);
    } catch (e: unknown) {
      setImportErr((e as Error)?.message ?? "Import failed");
    }
    setImporting(false);
  }

  async function handleCampaignImportPreview() {
    if (!importFile) {
      setImportErr("Choose a CSV file.");
      return;
    }
    setImportPreviewing(true);
    setImportErr("");
    setImportPreview(null);
    setImportPreviewContextKeyState(null);
    try {
      const fd = new FormData();
      fd.append("file", importFile);
      if (importAssigneeId) fd.append("assignedToUserId", importAssigneeId);
      const t = typeof window !== "undefined" ? localStorage.getItem("token") : null;
      const base = typeof window !== "undefined" ? window.location.origin : "";
      const res = await fetch(`${base}/api/crm/campaigns/${campaignId}/import/preview`, {
        method: "POST",
        headers: t ? { Authorization: `Bearer ${t}` } : {},
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data.detail === "string" ? data.detail : data.error || `Preview failed (${res.status})`,
        );
      }
      setImportPreview(data as CampaignImportPreview);
      setImportPreviewContextKeyState(importPreviewContextKey(importFile, importAssigneeId));
    } catch (e: unknown) {
      setImportErr((e as Error)?.message ?? "Preview failed");
      setImportPreview(null);
      setImportPreviewContextKeyState(null);
    }
    setImportPreviewing(false);
  }

  async function handleBulkAssign() {
    if (selected.size === 0) return;
    setBulkAssigning(true);
    setBulkMsg("");
    try {
      const res = await apiPost<{ updated: number }>(
        `/crm/campaigns/${campaignId}/members/bulk-assign`,
        { memberIds: Array.from(selected), assignedToUserId: bulkAssignUserId || null },
        token
      );
      setBulkMsg(`${res.updated} member${res.updated !== 1 ? "s" : ""} updated`);
      setSelected(new Set());
      await loadMembers();
      setTimeout(() => setBulkMsg(""), 3000);
    } catch {
      setBulkMsg("Failed to update assignment");
    }
    setBulkAssigning(false);
  }

  async function exportCsv() {
    const t = typeof window !== "undefined" ? localStorage.getItem("token") : null;
    const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
    const url = `${baseUrl}/api/crm/campaigns/${campaignId}/export.csv`;
    try {
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
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

  const queueFilteredHref = `/crm/queue?campaignId=${encodeURIComponent(campaignId)}`;

  const healthDerived = useMemo(() => {
    if (!campaign) return null;
    const sc = campaign.statusCounts;
    const pending = sc["PENDING"] ?? 0;
    const inProgress = sc["IN_PROGRESS"] ?? 0;
    const callback = sc["CALLBACK"] ?? 0;
    const contactedOnly = sc["CONTACTED"] ?? 0;
    const converted = sc["CONVERTED"] ?? 0;
    const skipped = sc["SKIPPED"] ?? 0;
    const dnc = sc["DO_NOT_CALL"] ?? 0;
    const total = campaign.memberCount;
    const activeQueueWork = pending + inProgress;
    const unassignedRow = workload.find((w) => w.userId === null);
    const unassignedMembers = unassignedRow?.total ?? 0;
    const contactedProgress = contactedOnly + callback + converted;
    const terminal = converted + skipped + dnc;
    const archivedInLoaded = members.filter((m) => m.queueWorkEligible === false).length;
    return {
      pending,
      inProgress,
      callback,
      contactedOnly,
      converted,
      skipped,
      dnc,
      total,
      activeQueueWork,
      unassignedMembers,
      contactedProgress,
      terminal,
      archivedInLoaded,
    };
  }, [campaign, workload, members]);

  const importCtxKey = importFile ? importPreviewContextKey(importFile, importAssigneeId) : null;
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

  if (loading) return <div className="min-h-screen bg-gray-50 flex items-center justify-center"><p className="text-gray-400">Loading…</p></div>;
  if (!campaign) return <div className="min-h-screen bg-gray-50 flex items-center justify-center"><p className="text-red-500">{error || "Campaign not found"}</p></div>;

  const hd = healthDerived!;

  return (
    <div className="min-h-screen bg-gray-50">
      {showAddContacts && (
        <AddContactsModal
          campaignId={campaignId}
          onClose={() => setShowAddContacts(false)}
          onAdded={() => { loadCampaign(); loadMembers(); }}
        />
      )}

      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Back */}
        <button onClick={() => router.push("/crm/campaigns")} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-5">
          <ArrowLeft className="h-4 w-4" />
          Campaigns
        </button>

        {/* Campaign hero + primary actions */}
        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm p-4 sm:p-6 mb-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 flex-1">
              {editingName ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    autoFocus
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") saveName(); if (e.key === "Escape") setEditingName(false); }}
                    className="text-xl font-bold border border-gray-300 rounded-lg px-3 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500 w-full max-w-md"
                  />
                  <button type="button" onClick={saveName} className="p-1.5 bg-blue-600 text-white rounded hover:bg-blue-700"><Save className="h-4 w-4" /></button>
                  <button type="button" onClick={() => setEditingName(false)} className="p-1.5 border border-gray-300 rounded hover:bg-gray-50"><X className="h-4 w-4" /></button>
                </div>
              ) : (
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-2xl font-bold text-gray-900 tracking-tight">{campaign.name}</h1>
                  <button type="button" onClick={() => setEditingName(true)} className="p-1 text-gray-400 hover:text-gray-600 rounded" aria-label="Edit campaign name"><Edit2 className="h-4 w-4" /></button>
                </div>
              )}
              <p className="text-sm text-gray-600 mt-1.5">
                {campaign.description?.trim()
                  ? campaign.description
                  : `${STATUS_LABELS[campaign.status]} · ${PRIORITY_LABELS[campaign.priority ?? "NORMAL"]} priority · ${hd.total} member${hd.total !== 1 ? "s" : ""}`}
              </p>
              <div className="flex flex-wrap items-center gap-2 mt-2.5">
                <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold ${STATUS_COLORS[campaign.status]}`}>
                  {STATUS_LABELS[campaign.status]}
                </span>
                <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold ${PRIORITY_COLORS[campaign.priority ?? "NORMAL"]}`}>
                  {PRIORITY_LABELS[campaign.priority ?? "NORMAL"]}
                </span>
                {campaign.script && (
                  <span className="text-xs text-gray-500">Script: <span className="font-medium text-gray-700">{campaign.script.name}</span></span>
                )}
                {campaign.checklist && (
                  <span className="text-xs text-gray-500">Checklist: <span className="font-medium text-gray-700">{campaign.checklist.name}</span></span>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 mt-5 pt-4 border-t border-gray-100">
            {isAdmin && (
              <button
                type="button"
                onClick={() => {
                  setImportOpen(true);
                  setImportErr("");
                  setImportSummary(null);
                  setImportFile(null);
                  setImportAssigneeId("");
                  setImportPreview(null);
                  setImportPreviewContextKeyState(null);
                  setImportCompareBaseline(null);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold bg-blue-600 text-white hover:bg-blue-700 shadow-sm"
              >
                <Upload className="h-4 w-4 shrink-0" />
                Import leads
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowAddContacts(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold border border-gray-300 text-gray-800 bg-white hover:bg-gray-50"
            >
              <Plus className="h-4 w-4 shrink-0" />
              Add existing contacts
            </button>
            {isAdmin && (
              <button
                type="button"
                onClick={() => { setDistributeOpen(true); setDistributeMsg(""); setDistributeUserIds(new Set()); }}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold border border-gray-300 text-gray-800 bg-white hover:bg-gray-50"
              >
                <Shuffle className="h-4 w-4 shrink-0" />
                Distribute leads
              </button>
            )}
            <Link
              href={queueFilteredHref}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold border border-blue-200 text-blue-800 bg-blue-50/80 hover:bg-blue-100"
            >
              <ListOrdered className="h-4 w-4 shrink-0" />
              View My Queue
            </Link>
          </div>

          <div className="flex flex-wrap gap-2 mt-3">
            {campaign.status === "DRAFT" && (
              <button type="button" onClick={() => updateCampaign({ status: "ACTIVE" })} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-green-200 text-green-800 bg-green-50 hover:bg-green-100">
                <Play className="h-3.5 w-3.5" />Start campaign
              </button>
            )}
            {campaign.status === "ACTIVE" && (
              <button type="button" onClick={() => updateCampaign({ status: "PAUSED" })} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-amber-200 text-amber-900 bg-amber-50 hover:bg-amber-100">
                <Pause className="h-3.5 w-3.5" />Pause
              </button>
            )}
            {campaign.status === "PAUSED" && (
              <button type="button" onClick={() => updateCampaign({ status: "ACTIVE" })} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-green-200 text-green-800 bg-green-50 hover:bg-green-100">
                <Play className="h-3.5 w-3.5" />Resume
              </button>
            )}
            {(campaign.status === "ACTIVE" || campaign.status === "PAUSED") && (
              <button type="button" onClick={() => { if (confirm("Archive this campaign?")) updateCampaign({ status: "ARCHIVED" }); }} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50">
                <Archive className="h-3.5 w-3.5" />Archive
              </button>
            )}
            <button type="button" onClick={exportCsv} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50" title="Export member CSV">
              <Download className="h-3.5 w-3.5" />Export CSV
            </button>
          </div>
        </div>

        {/* Health snapshot — real aggregates only */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
          <HealthTile label="Total members" value={hd.total} />
          <HealthTile label="Active queue work" value={hd.activeQueueWork} hint="Pending + in progress" />
          <HealthTile label="Callbacks scheduled" value={hd.callback} hint="Members in CALLBACK status" urgent={hd.callback > 0} />
          {isAdmin ? (
            <HealthTile label="Unassigned" value={hd.unassignedMembers} hint="No owner on member rows" urgent={hd.unassignedMembers > 0} />
          ) : (
            <HealthTile label="Terminal outcomes" value={hd.terminal} hint="Converted, skipped, DNC" />
          )}
        </div>
        <div className="rounded-xl border border-gray-100 bg-white px-3 py-2.5 mb-5 text-sm text-gray-700 flex flex-wrap gap-x-6 gap-y-1 items-center">
          <span>
            <span className="text-gray-500">Converted</span>{" "}
            <strong className="text-gray-900 tabular-nums">{hd.converted}</strong>
            <span className="text-gray-400"> / {hd.total}</span>
          </span>
          <span className="text-gray-300 hidden sm:inline">|</span>
          <span>
            <span className="text-gray-500">Contacted + engaged</span>{" "}
            <strong className="text-gray-900 tabular-nums">{hd.contactedProgress}</strong>
            <span className="text-gray-400"> with outcomes or callbacks</span>
          </span>
          {importHistory[0] ? (
            <>
              <span className="text-gray-300 hidden sm:inline">|</span>
              <span className="text-gray-500">
                Last import: <span className="text-gray-800 font-medium">{formatImportTimestamp(importHistory[0].createdAt)}</span>
                {importHistory[0].fileName ? ` · ${importHistory[0].fileName}` : ""}
              </span>
            </>
          ) : !importHistoryLoading ? (
            <>
              <span className="text-gray-300 hidden sm:inline">|</span>
              <span className="text-gray-500">No campaign CSV imports recorded yet.</span>
            </>
          ) : null}
          {hd.archivedInLoaded > 0 ? (
            <>
              <span className="text-gray-300 hidden sm:inline">|</span>
              <span className="text-amber-800 text-xs">
                Read-only / archived in this list: {hd.archivedInLoaded}
                {membersTotal > members.length ? " (visible page)" : ""}
              </span>
            </>
          ) : null}
        </div>

        {/* Manager next steps — links and modals only; no invented metrics */}
        <div className="rounded-xl border border-gray-200 bg-white p-4 sm:p-5 mb-5 shadow-sm">
          <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">Next operational actions</h2>
          <ul className="space-y-2.5">
            {isAdmin && hd.unassignedMembers > 0 ? (
              <li className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-lg border border-amber-100 bg-amber-50/50 px-3 py-2.5">
                <div>
                  <p className="text-sm font-semibold text-gray-900">Unassigned members</p>
                  <p className="text-xs text-gray-600 mt-0.5">{hd.unassignedMembers} lead{hd.unassignedMembers !== 1 ? "s" : ""} still need an owner — distribute across agents.</p>
                </div>
                <div className="flex flex-wrap gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => { setDistributeOpen(true); setDistributeMsg(""); setDistributeUserIds(new Set()); }}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700"
                  >
                    Distribute…
                  </button>
                  <button
                    type="button"
                    onClick={() => { setAssigneeFilter("UNASSIGNED"); loadMembers("UNASSIGNED"); }}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 text-gray-800 hover:bg-white"
                  >
                    Filter members
                  </button>
                </div>
              </li>
            ) : null}
            {hd.callback > 0 ? (
              <li className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-lg border border-gray-100 bg-gray-50/80 px-3 py-2.5">
                <div>
                  <p className="text-sm font-semibold text-gray-900">Scheduled callbacks</p>
                  <p className="text-xs text-gray-600 mt-0.5">{hd.callback} member{hd.callback !== 1 ? "s" : ""} in CALLBACK status — work them from the queue.</p>
                </div>
                <div className="flex flex-wrap gap-2 shrink-0">
                  <Link href={`${queueFilteredHref}&filter=overdue`} className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-300 text-gray-800 hover:bg-white">
                    Overdue queue
                  </Link>
                  <Link href={`${queueFilteredHref}&filter=due`} className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 text-gray-800 hover:bg-white">
                    Due today
                  </Link>
                </div>
              </li>
            ) : null}
            {hd.total === 0 ? (
              <li className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-lg border border-blue-100 bg-blue-50/40 px-3 py-2.5">
                <div>
                  <p className="text-sm font-semibold text-gray-900">No members yet</p>
                  <p className="text-xs text-gray-600 mt-0.5">Import a CSV or add existing contacts to populate this campaign.</p>
                </div>
                <div className="flex flex-wrap gap-2 shrink-0">
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => {
                        setImportOpen(true);
                        setImportErr("");
                        setImportSummary(null);
                        setImportFile(null);
                        setImportAssigneeId("");
                        setImportPreview(null);
                        setImportPreviewContextKeyState(null);
                        setImportCompareBaseline(null);
                      }}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700"
                    >
                      Import leads
                    </button>
                  )}
                  <button type="button" onClick={() => setShowAddContacts(true)} className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 text-gray-800 hover:bg-white">
                    Add contacts
                  </button>
                </div>
              </li>
            ) : null}
            {isAdmin && hd.total > 0 && importHistory.length === 0 && !importHistoryLoading ? (
              <li className="rounded-lg border border-gray-100 bg-gray-50/60 px-3 py-2.5 text-sm text-gray-700">
                <span className="font-semibold text-gray-900">Import history is empty.</span>{" "}
                <span className="text-xs text-gray-600">When you run a campaign CSV import, batches will appear in Recent imports below.</span>
              </li>
            ) : null}
            {hd.pending > 50 && hd.unassignedMembers === 0 && isAdmin ? (
              <li className="rounded-lg border border-gray-100 px-3 py-2.5 text-xs text-gray-600">
                High pending volume ({hd.pending}) — review workload below and balance assignments if needed.
              </li>
            ) : null}
            {!((isAdmin && hd.unassignedMembers > 0) || hd.callback > 0 || hd.total === 0 || (isAdmin && hd.total > 0 && importHistory.length === 0 && !importHistoryLoading) || (hd.pending > 50 && hd.unassignedMembers === 0 && isAdmin)) ? (
              <li className="text-xs text-gray-500 px-1 py-1">
                No extra alerts for this snapshot — use members, queue, or imports above as needed.
              </li>
            ) : null}
          </ul>
        </div>

        {/* Script / Checklist / Priority — collapsed by default to reduce clutter */}
        <details className="group rounded-xl border border-gray-200 bg-white mb-5 shadow-sm open:ring-1 open:ring-gray-100">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-semibold text-gray-900 hover:bg-gray-50/80 rounded-xl [&::-webkit-details-marker]:hidden">
            <span>Campaign settings</span>
            <ChevronDown className="h-4 w-4 text-gray-400 transition-transform group-open:rotate-180" />
          </summary>
          <div className="px-4 pb-4 pt-0 border-t border-gray-100">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4 pt-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Call Script</label>
              <select
                value={campaign.scriptId ?? ""}
                onChange={(e) => updateCampaign({ scriptId: e.target.value || null })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">None</option>
                {scripts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Checklist</label>
              <select
                value={campaign.checklistId ?? ""}
                onChange={(e) => updateCampaign({ checklistId: e.target.value || null })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">None</option>
                {checklists.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-2">Smart Queue Priority</label>
            <div className="flex gap-2 flex-wrap">
              {(["LOW", "NORMAL", "HIGH", "URGENT"] as CampaignPriority[]).map((p) => (
                <button
                  key={p}
                  onClick={() => updateCampaign({ priority: p })}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                    (campaign.priority ?? "NORMAL") === p
                      ? p === "URGENT"
                        ? "bg-red-600 text-white border-red-600"
                        : p === "HIGH"
                          ? "bg-orange-500 text-white border-orange-500"
                          : p === "LOW"
                            ? "bg-gray-400 text-white border-gray-400"
                            : "bg-blue-600 text-white border-blue-600"
                      : "border-gray-300 text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {PRIORITY_LABELS[p]}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-1.5">
              {(campaign.priority ?? "NORMAL") === "URGENT"
                ? "Leads in this campaign surface above all others in Smart Queue (after callbacks)."
                : (campaign.priority ?? "NORMAL") === "HIGH"
                  ? "Leads rank above Normal campaigns in Smart Queue."
                  : (campaign.priority ?? "NORMAL") === "LOW"
                    ? "Leads rank below Normal campaigns in Smart Queue."
                    : "Default ranking — same as other Normal campaigns."}
            </p>
          </div>
          </div>
        </details>

        {/* Campaign CSV import history (real CrmImportBatch rows only) */}
        <div className="rounded-2xl border border-gray-200 bg-white p-4 sm:p-5 mb-5 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <History className="h-4 w-4 text-gray-500" />
            <h2 className="text-sm font-bold text-gray-900 tracking-tight">Recent imports</h2>
          </div>
          {importHistoryLoading ? (
            <p className="text-sm text-gray-400">Loading import history…</p>
          ) : importHistory.length === 0 ? (
            <div className="text-sm text-gray-600 space-y-1">
              <p>No campaign-linked import batches yet.</p>
              <p className="text-gray-500 text-xs">
                CSV runs started with <strong>Import CSV</strong> on this page appear here. Standalone imports from Import Leads stay on that page only. Older data may be missing if it predates this linkage.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {importHistory.map((row) => {
                const st = CAMPAIGN_IMPORT_STATUS_STYLE[row.status] ?? "bg-gray-50 text-gray-800 border-gray-200";
                const hasIssues = row.errorCount > 0 || row.status === "PARTIAL" || row.status === "FAILED";
                return (
                  <li key={row.id} className="rounded-xl border border-gray-100 bg-white px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 hover:border-gray-200 shadow-sm">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-gray-900 truncate" title={row.fileName}>
                          {row.fileName}
                        </span>
                        <span
                          className={`text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded border ${st}`}
                        >
                          {campaignImportStatusLabel(row.status)}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {formatImportTimestamp(row.createdAt)}
                        {row.createdBy ? ` · ${row.createdBy.displayName}` : ""}
                        {row.totalRows > 0
                          ? ` · ${row.totalRows} row${row.totalRows !== 1 ? "s" : ""}`
                          : ""}
                      </p>
                      <p className="text-xs text-gray-600 mt-1">
                        <span className="text-green-700 font-medium">{row.createdCount}</span> created
                        <span className="text-gray-400 mx-1">·</span>
                        <span className="text-blue-700 font-medium">{row.updatedCount}</span> updated
                        <span className="text-gray-400 mx-1">·</span>
                        <span className="text-gray-600 font-medium">{row.skippedCount}</span> skipped
                        {row.errorCount > 0 && (
                          <>
                            <span className="text-gray-400 mx-1">·</span>
                            <span className="text-red-700 font-medium">{row.errorCount}</span> errors
                          </>
                        )}
                      </p>
                      {hasIssues && row.errorCount === 0 && (
                        <p className="text-[11px] text-amber-800 mt-1">Review import details for skipped rows or enrollment notes.</p>
                      )}
                    </div>
                    <Link
                      href={`/crm/import?batch=${encodeURIComponent(row.id)}`}
                      className="text-sm font-medium text-blue-600 hover:text-blue-800 shrink-0"
                    >
                      Batch details →
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Members */}
        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm p-4 sm:p-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-gray-900 tracking-tight">
                Members <span className="text-gray-400 font-semibold text-sm">({membersTotal})</span>
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Filters apply server-side (100 per load). Import, distribute, and queue shortcuts live in the header above.
              </p>
            </div>
          </div>

          {/* Workload — admin only; always visible when data exists */}
          {isAdmin && (
            <div className="mb-5 rounded-xl border border-gray-100 bg-gray-50/80 p-3 sm:p-4">
              <div className="flex items-center justify-between gap-2 mb-3">
                <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide flex items-center gap-1.5">
                  <BarChart2 className="h-3.5 w-3.5" />
                  Team workload
                </h3>
                {workloadLoading ? <span className="text-xs text-gray-400">Loading…</span> : null}
              </div>
              {workload.length === 0 && !workloadLoading ? (
                <p className="text-xs text-gray-500">No assignment rows yet — add or import members first.</p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {workload.map((row) => {
                    const active = row.pending + row.inProgress;
                    const terminal = row.converted + row.skipped + row.dnc;
                    return (
                      <div
                        key={row.userId ?? "__unassigned__"}
                        className={`rounded-xl border bg-white px-3 py-2.5 ${row.userId === null ? "border-amber-200 bg-amber-50/40" : "border-gray-200"}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className={`text-sm font-semibold truncate ${row.userId === null ? "text-amber-900 italic" : "text-gray-900"}`}>
                            {row.displayName}
                          </p>
                          <span className="text-xs font-bold text-gray-700 tabular-nums shrink-0">{row.total}</span>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-600">
                          <span><span className="text-gray-400">Active</span> {active}</span>
                          <span><span className="text-gray-400">CB</span> {row.callbacks}</span>
                          <span><span className="text-gray-400">Contacted</span> {row.contacted}</span>
                          <span><span className="text-gray-400">Terminal</span> {terminal}</span>
                        </div>
                        {row.userId === null && row.total > 0 ? (
                          <button
                            type="button"
                            onClick={() => { setDistributeOpen(true); setDistributeMsg(""); setDistributeUserIds(new Set()); }}
                            className="mt-2 w-full sm:w-auto text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
                          >
                            Redistribute unassigned…
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Distribute modal */}
          {isAdmin && distributeOpen && (
            <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
              <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-bold text-gray-900">Distribute Unassigned Leads</h3>
                  <button onClick={() => setDistributeOpen(false)} className="p-1 text-gray-400 hover:text-gray-600"><X className="h-5 w-5" /></button>
                </div>
                <p className="text-sm text-gray-500 mb-4">
                  Unassigned pending leads will be distributed evenly (round-robin) across the agents you select below.
                  This action only affects unassigned leads — already-assigned leads are untouched.
                </p>
                <div className="mb-4 max-h-48 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                  {crmUsers.filter((u) => u.crmEnabled).length === 0 ? (
                    <p className="p-3 text-sm text-gray-400">No CRM-enabled agents found.</p>
                  ) : (
                    crmUsers.filter((u) => u.crmEnabled).map((u) => (
                      <label key={u.userId} className="flex items-center gap-3 px-3 py-2.5 hover:bg-gray-50 cursor-pointer">
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
                        <span className="text-sm text-gray-800">{u.displayName || u.email}</span>
                        <span className="text-xs text-gray-400 ml-auto">{u.crmRole ?? "AGENT"}</span>
                      </label>
                    ))
                  )}
                </div>
                {distributeMsg && (
                  <p className={`text-sm mb-3 ${distributeMsg.startsWith("Distributed") ? "text-green-600" : "text-amber-600"}`}>{distributeMsg}</p>
                )}
                <div className="flex gap-2 justify-end">
                  <button onClick={() => setDistributeOpen(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50">
                    Cancel
                  </button>
                  <button
                    onClick={handleDistribute}
                    disabled={distributing || distributeUserIds.size === 0}
                    className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5"
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
              <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-bold text-gray-900">Import leads to campaign</h3>
                  <button
                    type="button"
                    onClick={() => {
                      setImportOpen(false);
                      setImportErr("");
                      setImportSummary(null);
                      setImportFile(null);
                      setImportAssigneeId("");
                      setImportPreview(null);
                      setImportPreviewContextKeyState(null);
                      setImportCompareBaseline(null);
                    }}
                    className="p-1 text-gray-400 hover:text-gray-600"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <p className="text-sm text-gray-600 mb-3">
                  Upload a CSV (max 5 MB, up to 5,000 rows). Headers are auto-detected — include at least a{" "}
                  <strong>phone</strong> or <strong>email</strong> column (e.g. &quot;Phone&quot;, &quot;Mobile&quot;, &quot;Email&quot;).
                  Existing contacts are matched by phone/email and updated (blank fields only); they are not duplicated.
                  Contacts already in this campaign are skipped for enrollment.
                </p>
                <div className="mb-4">
                  <label className="block text-xs font-medium text-gray-500 mb-1">CSV file</label>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
                    className="block w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700"
                  />
                </div>
                <div className="mb-4">
                  <label className="block text-xs font-medium text-gray-500 mb-1">Assign new members to (optional)</label>
                  <select
                    value={importAssigneeId}
                    onChange={(e) => setImportAssigneeId(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">— Unassigned —</option>
                    {crmUsers.filter((u) => u.crmEnabled).map((u) => (
                      <option key={u.userId} value={u.userId}>{u.displayName || u.email}</option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-400 mt-1">Changing the assignee clears the preview — run Preview import again.</p>
                </div>
                <div className="mb-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCampaignImportPreview()}
                    disabled={importPreviewing || !importFile}
                    className="px-4 py-2 text-sm border border-gray-300 rounded-lg text-gray-800 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {importPreviewing ? "Previewing…" : "Preview import"}
                  </button>
                </div>
                {importFile && !importPreview && !importPreviewing && (
                  <p className="text-sm text-gray-600 mb-3">Select a CSV and run Preview import to see exactly what will happen.</p>
                )}
                {importPreview && importFile && importCtxKey === importPreviewContextKeyState && (
                  <div className="mb-4 p-3 bg-blue-50 border border-blue-100 rounded-lg text-sm space-y-3">
                    <div>
                      <p className="font-semibold text-gray-800">Preview (dry-run — nothing saved yet)</p>
                      <p className="text-gray-600 text-xs mt-0.5">
                        Total rows: {importPreview.totalRows} · Valid rows: {importPreview.validRows} · Data rows counted as invalid in preview:{" "}
                        {importPreview.invalidRows}
                      </p>
                    </div>
                    {importPreview.invalidRows > 0 && (
                      <p className="text-amber-900 text-sm bg-amber-50 border border-amber-100 rounded-md px-2 py-1.5">
                        {importPreview.invalidRows} row{importPreview.invalidRows !== 1 ? "s" : ""} will be skipped (no usable phone/email or could not be processed in preview). They are still listed in samples or errors where applicable.
                      </p>
                    )}
                    {importPreview.wouldSkipExistingMembers > 0 && (
                      <p className="text-amber-900 text-sm bg-amber-50 border border-amber-100 rounded-md px-2 py-1.5">
                        {importPreview.wouldSkipExistingMembers} row{importPreview.wouldSkipExistingMembers !== 1 ? "s" : ""} match contacts already in this campaign — they will not be added again as members.
                      </p>
                    )}
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      <div className="rounded-lg border border-blue-100 bg-white p-2 shadow-sm">
                        <p className="text-[11px] text-gray-500 uppercase tracking-wide">New contacts</p>
                        <p className="text-lg font-semibold text-gray-900">{importPreview.wouldCreateContacts}</p>
                      </div>
                      <div className="rounded-lg border border-blue-100 bg-white p-2 shadow-sm">
                        <p className="text-[11px] text-gray-500 uppercase tracking-wide">Contacts updated</p>
                        <p className="text-lg font-semibold text-gray-900">{importPreview.wouldUpdateContacts}</p>
                      </div>
                      <div className="rounded-lg border border-blue-100 bg-white p-2 shadow-sm">
                        <p className="text-[11px] text-gray-500 uppercase tracking-wide">New campaign members</p>
                        <p className="text-lg font-semibold text-green-800">{importPreview.wouldAddMembers}</p>
                      </div>
                      <div className="rounded-lg border border-blue-100 bg-white p-2 shadow-sm">
                        <p className="text-[11px] text-gray-500 uppercase tracking-wide">Already in campaign</p>
                        <p className="text-lg font-semibold text-gray-800">{importPreview.wouldSkipExistingMembers}</p>
                      </div>
                      <div className="rounded-lg border border-blue-100 bg-white p-2 shadow-sm">
                        <p className="text-[11px] text-gray-500 uppercase tracking-wide">Invalid / skipped rows</p>
                        <p className="text-lg font-semibold text-amber-900">{importPreview.invalidRows}</p>
                      </div>
                    </div>
                    <p className="text-sm font-medium text-green-800 bg-green-50 border border-green-100 rounded-md px-2 py-1.5">
                      Ready to import this file — preview matches the selected CSV and assignee.
                    </p>
                    {importSampleGroups.length > 0 ? (
                      <div className="space-y-3">
                        {importSampleGroups.map(({ bucket, rows }) => (
                          <div key={bucket}>
                            <p className="text-xs font-semibold text-gray-700 mb-1">{PREVIEW_SAMPLE_BUCKET_LABEL[bucket]} (sample)</p>
                            <div className="max-h-36 overflow-y-auto border border-blue-100 rounded bg-white">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-left text-gray-500 border-b bg-gray-50">
                                    <th className="p-1.5">Row</th>
                                    <th className="p-1.5">Phone</th>
                                    <th className="p-1.5">Email</th>
                                    <th className="p-1.5">Contact</th>
                                    <th className="p-1.5">Member</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {rows.map((s) => (
                                    <tr key={s.row} className="border-b border-gray-50">
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
                        <p className="text-xs font-medium text-gray-600 mb-1">
                          Sample rows — shown in one list (could not group by outcome from this response).
                        </p>
                        <div className="max-h-36 overflow-y-auto border border-blue-100 rounded bg-white">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-left text-gray-500 border-b bg-gray-50">
                                <th className="p-1.5">Row</th>
                                <th className="p-1.5">Phone</th>
                                <th className="p-1.5">Email</th>
                                <th className="p-1.5">Raw contact</th>
                                <th className="p-1.5">Raw member</th>
                              </tr>
                            </thead>
                            <tbody>
                              {importPreview.sampleRows.map((s) => (
                                <tr key={s.row} className="border-b border-gray-50">
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
                      <ul className="text-xs text-amber-900 list-disc pl-4 max-h-24 overflow-y-auto">
                        {importPreview.errors.map((er) => (
                          <li key={`${er.row}-${er.reason}`}>Row {er.row}: {er.reason}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {importErr && <p className="text-sm text-red-600 mb-3">{importErr}</p>}
                {importSummary && (
                  <div className="mb-4 p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm space-y-3">
                    <p className="font-semibold text-gray-800">Import complete — {importSummary.status}</p>
                    {importCompareBaseline ? (
                      <>
                        {importCoreMismatch && (
                          <p className="text-amber-900 text-sm font-medium border border-amber-200 bg-amber-50 rounded-md px-2 py-1.5">
                            Data may have changed since preview — core totals differ from the dry-run.
                          </p>
                        )}
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs border-collapse min-w-[420px]">
                            <thead>
                              <tr className="text-left text-gray-500 border-b border-gray-200">
                                <th className="py-2 pr-2 font-medium">Metric</th>
                                <th className="py-2 pr-2 font-medium">Preview (expected)</th>
                                <th className="py-2 pr-2 font-medium">Import (actual)</th>
                                <th className="py-2 font-medium">Match</th>
                              </tr>
                            </thead>
                            <tbody className="text-gray-800">
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
                                  <tr key={label} className="border-b border-gray-100">
                                    <td className="py-1.5 pr-2">{label}</td>
                                    <td className="py-1.5 pr-2 tabular-nums">{exp}</td>
                                    <td className="py-1.5 pr-2 tabular-nums">{act}</td>
                                    <td className="py-1.5">{ok ? <span className="text-green-700">Yes</span> : <span className="text-amber-800 font-medium">No</span>}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        {importSkippedMismatch && (
                          <p className="text-xs text-gray-600">
                            Preview counted {importCompareBaseline.invalidRows} invalid row{importCompareBaseline.invalidRows !== 1 ? "s" : ""}; import skipped{" "}
                            {importSummary.skippedRows} row{importSummary.skippedRows !== 1 ? "s" : ""} (e.g. no phone/email). Small differences can be normal if rows overlap categories.
                          </p>
                        )}
                      </>
                    ) : null}
                    <p className="text-gray-700">Rows processed: {importSummary.totalRows}</p>
                    <p>Contacts created: {importSummary.createdContacts}</p>
                    <p>Contacts updated: {importSummary.updatedContacts}</p>
                    <p>Rows skipped (no phone/email): {importSummary.skippedRows}</p>
                    <p className="text-green-700 font-medium">Members added to campaign: {importSummary.addedMembers}</p>
                    <p>Already in campaign (skipped): {importSummary.skippedExistingMembers}</p>
                    {importSummary.errorCount > 0 && (
                      <p className="text-amber-700">Row errors: {importSummary.errorCount}</p>
                    )}
                    {importSummary.errors?.length > 0 && (
                      <ul className="text-xs text-gray-600 max-h-24 overflow-y-auto list-disc pl-4 mt-1">
                        {importSummary.errors.slice(0, 10).map((er) => (
                          <li key={`${er.row}-${er.reason}`}>Row {er.row}: {er.reason}</li>
                        ))}
                      </ul>
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
                      className="px-4 py-2 text-sm border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 mr-auto"
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
                      setImportFile(null);
                      setImportAssigneeId("");
                      setImportPreview(null);
                      setImportPreviewContextKeyState(null);
                      setImportCompareBaseline(null);
                    }}
                    className="px-4 py-2 text-sm border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                  >
                    {importSummary ? "Close" : "Cancel"}
                  </button>
                  {!importSummary && (
                    <button
                      type="button"
                      onClick={() => void handleCampaignImport()}
                      disabled={importing || importPreviewing || !importReady}
                      className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5"
                      title={!importReady ? "Preview import first for this file and assignee" : undefined}
                    >
                      <Upload className="h-3.5 w-3.5" />
                      {importing ? "Importing…" : "Run import"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Filters */}
          <div className="flex gap-2 mb-4 flex-wrap">
            <div className="relative flex-1 min-w-[160px] max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Search members…"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">All statuses</option>
              {(Object.keys(MEMBER_STATUS_LABELS) as MemberStatus[]).map((s) => (
                <option key={s} value={s}>{MEMBER_STATUS_LABELS[s]}</option>
              ))}
            </select>
            {/* Assignee filter — quick-scope to one agent or unassigned */}
            <select
              value={assigneeFilter}
              onChange={(e) => {
                const v = e.target.value;
                setAssigneeFilter(v);
                loadMembers(v);
              }}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">All agents</option>
              <option value="UNASSIGNED">Unassigned</option>
              {crmUsers.filter((u) => u.crmEnabled).map((u) => (
                <option key={u.userId} value={u.userId}>{u.displayName || u.email}</option>
              ))}
            </select>
          </div>

          {/* Bulk action bar */}
          {selected.size > 0 && (
            <div className="mb-4 flex items-center gap-3 p-3 bg-blue-50 border border-blue-200 rounded-lg flex-wrap">
              <span className="text-sm font-medium text-blue-800">{selected.size} selected</span>
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <UserPlus className="h-4 w-4 text-blue-600 shrink-0" />
                <select
                  value={bulkAssignUserId}
                  onChange={(e) => setBulkAssignUserId(e.target.value)}
                  className="flex-1 border border-blue-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white min-w-0"
                >
                  <option value="">— Clear assignment —</option>
                  {crmUsers.filter((u) => u.crmEnabled).map((u) => (
                    <option key={u.userId} value={u.userId}>{u.displayName || u.email}</option>
                  ))}
                </select>
              </div>
              <button
                onClick={handleBulkAssign}
                disabled={bulkAssigning}
                className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 shrink-0"
              >
                {bulkAssigning ? "Assigning…" : "Apply"}
              </button>
              <button onClick={() => setSelected(new Set())} className="p-1 text-blue-500 hover:text-blue-700 shrink-0">
                <X className="h-4 w-4" />
              </button>
              {bulkMsg && <span className="text-xs text-blue-700 font-medium">{bulkMsg}</span>}
            </div>
          )}

          {membersLoading ? (
            <div className="py-12 text-center text-gray-400 text-sm">Loading members…</div>
          ) : filteredMembers.length === 0 ? (
            <div className="py-12 text-center">
              <Users className="h-8 w-8 text-gray-300 mx-auto mb-2" />
              <p className="text-gray-500 text-sm">No members yet.</p>
              <button onClick={() => setShowAddContacts(true)} className="mt-3 text-sm text-blue-600 hover:underline">Add contacts to get started</button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 px-1 pb-1">
                <button type="button" onClick={toggleSelectAll} className="p-1 rounded border border-transparent hover:border-gray-200 hover:bg-gray-50" aria-label="Select all visible members">
                  {selected.size > 0 && bulkSelectableMembers.length > 0 && bulkSelectableMembers.every((m) => selected.has(m.id))
                    ? <CheckSquare2 className="h-4 w-4 text-blue-600" />
                    : <Square className="h-4 w-4 text-gray-400" />}
                </button>
                <span className="text-xs text-gray-500">Select all eligible in this list</span>
              </div>
              {filteredMembers.map((m) => {
                const archivedLead = m.queueWorkEligible === false;
                const agentCannotAct = !isAdmin && archivedLead;
                return (
                  <div
                    key={m.id}
                    className={`rounded-xl border px-3 py-3 transition-colors ${
                      selected.has(m.id) ? "border-blue-300 bg-blue-50/40" : "border-gray-200 bg-white hover:border-gray-300"
                    } ${archivedLead ? "opacity-85 bg-gray-50/90" : ""}`}
                  >
                    <div className="flex flex-col lg:flex-row lg:items-start gap-3">
                      <div className="flex items-start gap-2 shrink-0">
                        <input
                          type="checkbox"
                          checked={selected.has(m.id)}
                          disabled={agentCannotAct}
                          onChange={(e) => {
                            const s = new Set(selected);
                            if (e.target.checked) s.add(m.id);
                            else s.delete(m.id);
                            setSelected(s);
                          }}
                          className="rounded mt-1 disabled:opacity-40"
                          aria-label={`Select ${m.contact?.displayName ?? "member"}`}
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => router.push(`/crm/contacts/${m.contactId}`)}
                            className="font-semibold text-blue-700 hover:underline text-left"
                          >
                            {m.contact?.displayName ?? "Unknown"}
                          </button>
                          {archivedLead && (
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-900 bg-amber-100 px-1.5 py-0.5 rounded">
                              Archived
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-600 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                          <span>{m.contact?.primaryPhone ?? "—"}</span>
                          <span className="text-gray-400">Stage: {m.contact?.crmStage ?? "—"}</span>
                          <span className="text-gray-400">{m.attemptCount} attempt{m.attemptCount !== 1 ? "s" : ""}</span>
                          <span className="text-gray-400">{m.assignedTo?.displayName ?? "Unassigned"}</span>
                        </p>
                      </div>
                      <div className="flex flex-col sm:flex-row flex-wrap gap-2 lg:justify-end lg:items-center shrink-0">
                        {agentCannotAct ? (
                          <span className={`text-xs px-2 py-1.5 rounded-lg ${MEMBER_STATUS_COLORS[m.status]}`}>
                            {MEMBER_STATUS_LABELS[m.status]}
                          </span>
                        ) : (
                          <select
                            value={m.status}
                            onChange={(e) => updateMemberStatus(m.id, e.target.value as MemberStatus)}
                            className={`text-xs px-2 py-1.5 rounded-lg border border-gray-200 cursor-pointer ${MEMBER_STATUS_COLORS[m.status]} focus:outline-none focus:ring-2 focus:ring-blue-400`}
                          >
                            {(Object.keys(MEMBER_STATUS_LABELS) as MemberStatus[]).map((s) => (
                              <option key={s} value={s}>{MEMBER_STATUS_LABELS[s]}</option>
                            ))}
                          </select>
                        )}
                        <div className="min-w-[8rem]">
                          <CallbackCell
                            member={m}
                            campaignId={campaignId}
                            onUpdated={loadMembers}
                            token={token}
                            readOnly={agentCannotAct}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => router.push(`/crm/live-call?contactId=${m.contactId}&campaignId=${campaignId}&memberId=${m.id}`)}
                          disabled={agentCannotAct}
                          className="inline-flex items-center justify-center gap-1 px-3 py-1.5 text-xs font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                          title={agentCannotAct ? "Lead is archived — not live queue work" : "Open Live Workspace"}
                        >
                          <PhoneCall className="h-3.5 w-3.5 shrink-0" />
                          Workspace
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
