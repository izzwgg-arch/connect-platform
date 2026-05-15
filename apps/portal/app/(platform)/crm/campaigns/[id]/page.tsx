"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, Play, Pause, Archive, Users, Plus, Search,
  PhoneCall, X, Edit2, Save, Download, UserPlus, CheckSquare2, Square, CalendarClock,
  Shuffle, BarChart2, Upload, History,
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

  // Workload summary
  const [workload, setWorkload] = useState<WorkloadRow[]>([]);
  const [workloadLoading, setWorkloadLoading] = useState(false);
  const [showWorkload, setShowWorkload] = useState(false);

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

  const pending = campaign.statusCounts["PENDING"] ?? 0;
  const contacted = (campaign.statusCounts["CONTACTED"] ?? 0) + (campaign.statusCounts["CALLBACK"] ?? 0);
  const converted = campaign.statusCounts["CONVERTED"] ?? 0;
  const total = campaign.memberCount;

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

        {/* Campaign header card */}
        <div className="bg-white border border-gray-200 rounded-xl p-6 mb-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              {editingName ? (
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") saveName(); if (e.key === "Escape") setEditingName(false); }}
                    className="text-xl font-bold border border-gray-300 rounded-lg px-3 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500 w-full max-w-sm"
                  />
                  <button onClick={saveName} className="p-1.5 bg-blue-600 text-white rounded hover:bg-blue-700"><Save className="h-4 w-4" /></button>
                  <button onClick={() => setEditingName(false)} className="p-1.5 border border-gray-300 rounded hover:bg-gray-50"><X className="h-4 w-4" /></button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <h1 className="text-xl font-bold text-gray-900">{campaign.name}</h1>
                  <button onClick={() => setEditingName(true)} className="p-1 text-gray-400 hover:text-gray-600 rounded"><Edit2 className="h-4 w-4" /></button>
                </div>
              )}
              {campaign.description && <p className="text-sm text-gray-500 mt-1">{campaign.description}</p>}

              <div className="flex flex-wrap items-center gap-3 mt-3">
                <span className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[campaign.status]}`}>
                  {STATUS_LABELS[campaign.status]}
                </span>
                {(campaign.priority ?? "NORMAL") !== "NORMAL" && (
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs font-medium ${PRIORITY_COLORS[campaign.priority ?? "NORMAL"]}`}>
                    {PRIORITY_LABELS[campaign.priority ?? "NORMAL"]} priority
                  </span>
                )}
                {campaign.script && (
                  <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">Script: {campaign.script.name}</span>
                )}
                {campaign.checklist && (
                  <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">Checklist: {campaign.checklist.name}</span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
              {campaign.status === "DRAFT" && (
                <button onClick={() => updateCampaign({ status: "ACTIVE" })} className="flex items-center gap-1.5 px-3 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">
                  <Play className="h-4 w-4" />Start
                </button>
              )}
              {campaign.status === "ACTIVE" && (
                <button onClick={() => updateCampaign({ status: "PAUSED" })} className="flex items-center gap-1.5 px-3 py-2 bg-yellow-500 text-white rounded-lg text-sm font-medium hover:bg-yellow-600">
                  <Pause className="h-4 w-4" />Pause
                </button>
              )}
              {campaign.status === "PAUSED" && (
                <button onClick={() => updateCampaign({ status: "ACTIVE" })} className="flex items-center gap-1.5 px-3 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">
                  <Play className="h-4 w-4" />Resume
                </button>
              )}
              {(campaign.status === "ACTIVE" || campaign.status === "PAUSED") && (
                <button onClick={() => { if (confirm("Archive this campaign?")) updateCampaign({ status: "ARCHIVED" }); }} className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50">
                  <Archive className="h-4 w-4" />Archive
                </button>
              )}
              <button onClick={exportCsv} className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50" title="Export CSV">
                <Download className="h-4 w-4" />Export
              </button>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5 pt-5 border-t border-gray-100">
            <div className="text-center"><p className="text-2xl font-bold text-gray-900">{total}</p><p className="text-xs text-gray-500 mt-0.5">Total</p></div>
            <div className="text-center"><p className="text-2xl font-bold text-gray-600">{pending}</p><p className="text-xs text-gray-500 mt-0.5">Pending</p></div>
            <div className="text-center"><p className="text-2xl font-bold text-blue-600">{contacted}</p><p className="text-xs text-gray-500 mt-0.5">Contacted</p></div>
            <div className="text-center"><p className="text-2xl font-bold text-green-600">{converted}</p><p className="text-xs text-gray-500 mt-0.5">Converted</p></div>
          </div>
        </div>

        {/* Script / Checklist / Priority */}
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
          <h2 className="font-semibold text-gray-900 mb-4">Settings</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
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

        {/* Campaign CSV import history (real CrmImportBatch rows only) */}
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
          <div className="flex items-center gap-2 mb-3">
            <History className="h-4 w-4 text-gray-500" />
            <h2 className="font-semibold text-gray-900">Recent imports</h2>
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
            <ul className="divide-y divide-gray-100 border border-gray-100 rounded-lg overflow-hidden">
              {importHistory.map((row) => {
                const st = CAMPAIGN_IMPORT_STATUS_STYLE[row.status] ?? "bg-gray-50 text-gray-800 border-gray-200";
                const hasIssues = row.errorCount > 0 || row.status === "PARTIAL" || row.status === "FAILED";
                return (
                  <li key={row.id} className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 bg-white hover:bg-gray-50/80">
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
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <h2 className="font-semibold text-gray-900">
              Members <span className="text-gray-400 font-normal text-sm">({membersTotal})</span>
            </h2>
            <div className="flex items-center gap-2">
              {isAdmin && (
                <>
                  <button
                    onClick={() => { setShowWorkload((v) => !v); if (!showWorkload) loadWorkload(); }}
                    className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50"
                    title="Workload summary"
                  >
                    <BarChart2 className="h-4 w-4" />Workload
                  </button>
                  <button
                    onClick={() => { setDistributeOpen(true); setDistributeMsg(""); setDistributeUserIds(new Set()); }}
                    className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50"
                    title="Distribute unassigned leads"
                  >
                    <Shuffle className="h-4 w-4" />Distribute
                  </button>
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
                    className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50"
                    title="Import leads from CSV"
                  >
                    <Upload className="h-4 w-4" />Import CSV
                  </button>
                </>
              )}
              <button onClick={() => setShowAddContacts(true)} className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
                <Plus className="h-4 w-4" />Add Contacts
              </button>
            </div>
          </div>

          {/* Workload summary */}
          {isAdmin && showWorkload && (
            <div className="mb-5 p-4 bg-gray-50 border border-gray-200 rounded-xl overflow-x-auto">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-700">Agent Workload</h3>
                {workloadLoading && <span className="text-xs text-gray-400">Loading…</span>}
              </div>
              {workload.length === 0 && !workloadLoading ? (
                <p className="text-xs text-gray-400">No members assigned yet.</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-gray-200">
                      <th className="pb-1.5 font-medium pr-4">Agent</th>
                      <th className="pb-1.5 font-medium text-right pr-3">Pending</th>
                      <th className="pb-1.5 font-medium text-right pr-3">Callback</th>
                      <th className="pb-1.5 font-medium text-right pr-3">Contacted</th>
                      <th className="pb-1.5 font-medium text-right pr-3">Converted</th>
                      <th className="pb-1.5 font-medium text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {workload.map((row) => (
                      <tr key={row.userId ?? "__unassigned__"} className={row.userId === null ? "text-gray-400 italic" : ""}>
                        <td className="py-1.5 pr-4 font-medium">{row.displayName}</td>
                        <td className="py-1.5 text-right pr-3">{row.pending + row.inProgress || "—"}</td>
                        <td className="py-1.5 text-right pr-3">{row.callbacks || "—"}</td>
                        <td className="py-1.5 text-right pr-3">{row.contacted || "—"}</td>
                        <td className="py-1.5 text-right pr-3 text-green-600 font-medium">{row.converted || "—"}</td>
                        <td className="py-1.5 text-right font-semibold">{row.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                    <th className="pb-2 pr-3 w-8">
                      <button type="button" onClick={toggleSelectAll} className="p-0.5 hover:text-blue-600">
                        {selected.size > 0 && bulkSelectableMembers.length > 0 && bulkSelectableMembers.every((m) => selected.has(m.id))
                          ? <CheckSquare2 className="h-4 w-4 text-blue-600" />
                          : <Square className="h-4 w-4" />}
                      </button>
                    </th>
                    <th className="pb-2 font-medium">Contact</th>
                    <th className="pb-2 font-medium">Phone</th>
                    <th className="pb-2 font-medium">Stage</th>
                    <th className="pb-2 font-medium">Status</th>
                    <th className="pb-2 font-medium">Attempts</th>
                    <th className="pb-2 font-medium">Callback</th>
                    <th className="pb-2 font-medium">Assigned</th>
                    <th className="pb-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {filteredMembers.map((m) => {
                    const archivedLead = m.queueWorkEligible === false;
                    const agentCannotAct = !isAdmin && archivedLead;
                    return (
                      <tr
                        key={m.id}
                        className={`hover:bg-gray-50 ${selected.has(m.id) ? "bg-blue-50/50" : ""} ${archivedLead ? "opacity-80 bg-gray-50/80" : ""}`}
                      >
                        <td className="py-3 pr-3">
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
                            className="rounded disabled:opacity-40"
                          />
                        </td>
                        <td className="py-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            <button
                              type="button"
                              onClick={() => router.push(`/crm/contacts/${m.contactId}`)}
                              className="font-medium text-blue-600 hover:underline text-left"
                            >
                              {m.contact?.displayName ?? "Unknown"}
                            </button>
                            {archivedLead && (
                              <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-600 bg-gray-200 px-1.5 py-0.5 rounded">
                                Archived
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-3 text-gray-600">{m.contact?.primaryPhone ?? "—"}</td>
                        <td className="py-3 text-gray-500 text-xs">{m.contact?.crmStage ?? "—"}</td>
                        <td className="py-3">
                          {agentCannotAct ? (
                            <span className={`text-xs px-2 py-1 rounded ${MEMBER_STATUS_COLORS[m.status]}`}>
                              {MEMBER_STATUS_LABELS[m.status]}
                            </span>
                          ) : (
                            <select
                              value={m.status}
                              onChange={(e) => updateMemberStatus(m.id, e.target.value as MemberStatus)}
                              className={`text-xs px-2 py-1 rounded border-0 cursor-pointer ${MEMBER_STATUS_COLORS[m.status]} focus:outline-none`}
                            >
                              {(Object.keys(MEMBER_STATUS_LABELS) as MemberStatus[]).map((s) => (
                                <option key={s} value={s}>{MEMBER_STATUS_LABELS[s]}</option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td className="py-3 text-center text-gray-600">{m.attemptCount}</td>
                        <td className="py-3">
                          <CallbackCell
                            member={m}
                            campaignId={campaignId}
                            onUpdated={loadMembers}
                            token={token}
                            readOnly={agentCannotAct}
                          />
                        </td>
                        <td className="py-3 text-gray-500 text-xs">{m.assignedTo?.displayName ?? "Unassigned"}</td>
                        <td className="py-3">
                          <button
                            type="button"
                            onClick={() => router.push(`/crm/live-call?contactId=${m.contactId}&campaignId=${campaignId}&memberId=${m.id}`)}
                            disabled={agentCannotAct}
                            className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-50 text-blue-700 rounded hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed"
                            title={agentCannotAct ? "Lead is archived — not live queue work" : "Open Live Workspace"}
                          >
                            <PhoneCall className="h-3 w-3" />
                            Call
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
