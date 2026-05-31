"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  Archive,
  ArrowUpRight,
  AtSign,
  BarChart3,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  ExternalLink,
  FileUp,
  Filter,
  Mail,
  Megaphone,
  MoreHorizontal,
  Phone,
  PhoneOff,
  PieChart,
  Plus,
  Search,
  Send,
  Sparkles,
  Tag,
  UserCheck,
  UserPlus,
  UserRound,
  Users,
  X,
} from "lucide-react";
import {
  CRMPageShell,
  CRMPageHeader,
  CRMCard,
  crm,
  cn,
} from "../../../../components/crm";
import {
  leadTimezoneBadgeShort,
  leadTimezoneBadgeTitle,
} from "../../../../components/crm/contact/leadTimezoneDisplay";
import { BulkEmailModal } from "../../../../components/crm/email/BulkEmailModal";
import { apiGet, apiPost } from "../../../../services/apiClient";
import { useAppContext } from "../../../../hooks/useAppContext";

// ── Types ─────────────────────────────────────────────────────────────────────

type CrmStage = "LEAD" | "CONTACTED" | "QUALIFIED" | "CUSTOMER" | "CLOSED_LOST";

type AssignedUser = {
  id?: string;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  email: string;
};

type ContactTag = {
  id: string;
  name: string;
  color?: string | null;
};

type CrmContact = {
  id: string;
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  title?: string | null;
  tags?: ContactTag[];
  primaryPhone?: { numberRaw: string } | null;
  primaryEmail?: { email: string } | null;
  crmStage?: CrmStage | null;
  assignedTo?: AssignedUser | null;
  doNotCall: boolean;
  createdAt: string;
  updatedAt?: string;
  lastActivityAt?: string | null;
  lastDisposition?: string | null;
  lastDispositionAt?: string | null;
  timezoneIana?: string | null;
  timezoneLabel?: string | null;
  timezoneOffsetMinutes?: number | null;
  timezoneResolvedAt?: string | null;
  timezoneResolutionStatus?: "RESOLVED" | "NEEDS_REVIEW" | "MISSING_LOCATION" | null;
  active?: boolean;
  archivedAt?: string | null;
};

type ContactsResponse = {
  rows: CrmContact[];
  total: number;
  page: number;
  limit: number;
};

type CrmUser = {
  userId: string;
  displayName: string;
  email: string;
  crmEnabled: boolean;
};

// ── Stage config ──────────────────────────────────────────────────────────────

const STAGE_LABELS: Record<CrmStage | "all", string> = {
  all: "All stages",
  LEAD: "Lead",
  CONTACTED: "Contacted",
  QUALIFIED: "Qualified",
  CUSTOMER: "Customer",
  CLOSED_LOST: "Closed Lost",
};

type TimezoneZoneFilter = "all" | "eastern" | "central" | "mountain" | "pacific" | "alaska" | "hawaii" | "other";

const TIMEZONE_ZONE_OPTIONS: Array<{ value: TimezoneZoneFilter; label: string }> = [
  { value: "all", label: "All timezones" },
  { value: "eastern", label: "Eastern" },
  { value: "central", label: "Central" },
  { value: "mountain", label: "Mountain" },
  { value: "pacific", label: "Pacific" },
  { value: "alaska", label: "Alaska" },
  { value: "hawaii", label: "Hawaii" },
  { value: "other", label: "Other / Needs Review" },
];

function timezoneBadgeClass(contact: CrmContact): string {
  if (contact.timezoneResolutionStatus === "RESOLVED" && (contact.timezoneLabel || contact.timezoneIana)) {
    return "contacts-stage-qualified";
  }
  return "contacts-stage-muted";
}

const FILTER_TABS = ["all", "LEAD", "CONTACTED", "QUALIFIED", "CUSTOMER", "CLOSED_LOST"] as const;

type QuickFilter = "all" | "new" | "contacted" | "engaged" | "follow-up" | "unreachable" | "customer" | "lead";

const QUICK_FILTERS: Array<{ key: QuickFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "engaged", label: "Engaged" },
  { key: "follow-up", label: "Follow Up" },
  { key: "unreachable", label: "Unreachable" },
  { key: "customer", label: "Customer" },
  { key: "lead", label: "Lead" },
];

/** Phase 16B — admin-only CRM list scope (server-backed; agents always behave as active). */
type ArchiveListScope = "active" | "archived" | "all";

const CONTACTS_PAGE_LIMIT = 50;

const ARCHIVE_SCOPE_LABELS: Record<ArchiveListScope, string> = {
  active: "Active",
  archived: "Archived",
  all: "All",
};

function isContactArchived(c: CrmContact): boolean {
  if (c.archivedAt != null) return true;
  if (c.active === false) return true;
  return false;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function initials(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function assignedLabel(u: AssignedUser | null | undefined): string {
  if (!u) return "—";
  return u.displayName || `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.email;
}

function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

function relativeDate(iso: string | null | undefined): string {
  if (!iso) return "No activity";
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "No activity";
  const diff = Math.max(0, Date.now() - ts);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return minutes <= 1 ? "just now" : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return formatShortDate(iso);
}

function isNewThisMonth(c: CrmContact): boolean {
  return Date.now() - new Date(c.createdAt).getTime() <= 30 * 24 * 60 * 60 * 1000;
}

function matchesQuickFilter(c: CrmContact, quickFilter: QuickFilter): boolean {
  switch (quickFilter) {
    case "all":
      return true;
    case "new":
      return isNewThisMonth(c);
    case "contacted":
      return c.crmStage === "CONTACTED";
    case "engaged":
      return c.crmStage === "QUALIFIED" || c.crmStage === "CUSTOMER";
    case "follow-up":
      return !!c.lastActivityAt && c.crmStage !== "CUSTOMER" && c.crmStage !== "CLOSED_LOST";
    case "unreachable":
      return c.doNotCall || !c.primaryPhone;
    case "customer":
      return c.crmStage === "CUSTOMER";
    case "lead":
      return c.crmStage === "LEAD";
  }
}

function stageTone(stage: CrmStage | null | undefined): string {
  switch (stage) {
    case "LEAD":
      return "contacts-stage-lead";
    case "CONTACTED":
      return "contacts-stage-contacted";
    case "QUALIFIED":
      return "contacts-stage-qualified";
    case "CUSTOMER":
      return "contacts-stage-customer";
    case "CLOSED_LOST":
      return "contacts-stage-lost";
    default:
      return "contacts-stage-muted";
  }
}

function ContactKpiTile({
  label,
  value,
  icon,
  micro,
  accent,
}: {
  label: string;
  value: string | number;
  icon: JSX.Element;
  micro: string;
  accent: "blue" | "violet" | "green" | "amber" | "rose" | "cyan";
}) {
  return (
    <div className={cn(crm.contactsKpiTile, `contacts-kpi-${accent}`)}>
      <div className="flex items-start justify-between gap-3">
        <span className="contacts-kpi-label">{label}</span>
        <span className={crm.contactsKpiIcon}>{icon}</span>
      </div>
      <p className="contacts-kpi-value">{value}</p>
      <p className="contacts-kpi-micro">{micro}</p>
    </div>
  );
}

function RailCard({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle: string;
  icon: JSX.Element;
  children: JSX.Element | JSX.Element[];
}) {
  return (
    <CRMCard padding="md" className="contacts-rail-card">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-base font-bold tracking-tight text-crm-text">{title}</p>
          <p className="mt-1 text-xs leading-relaxed text-crm-muted">{subtitle}</p>
        </div>
        <span className="contacts-rail-icon">{icon}</span>
      </div>
      {children}
    </CRMCard>
  );
}

function progressPercent(value: number, totalValue: number): number {
  if (totalValue <= 0) return 0;
  return Math.max(4, Math.round((value / totalValue) * 100));
}


// ── Add Contact Modal ─────────────────────────────────────────────────────────

type AddContactForm = {
  displayName: string;
  company: string;
  phone: string;
  email: string;
  stage: CrmStage;
};

const EMPTY_FORM: AddContactForm = {
  displayName: "",
  company: "",
  phone: "",
  email: "",
  stage: "LEAD",
};

function AddContactModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (c: CrmContact) => void;
}) {
  const [form, setForm] = useState<AddContactForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.displayName.trim()) {
      setError("Name is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        displayName: form.displayName.trim(),
        stage: form.stage,
      };
      if (form.company.trim()) body.company = form.company.trim();
      if (form.phone.trim()) body.phones = [{ type: "MOBILE", numberRaw: form.phone.trim(), isPrimary: true }];
      if (form.email.trim()) body.emails = [{ type: "WORK", email: form.email.trim(), isPrimary: true }];

      const created = await apiPost<CrmContact>("/crm/contacts", body);
      onCreated(created);
      onClose();
    } catch (err: unknown) {
      setError((err as Error)?.message || "Failed to create contact");
      setSaving(false);
    }
  };

  return (
    <div
      className={crm.contactsModalBackdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={cn(crm.contactsModalPanel, "border-crm-border bg-crm-surface shadow-xl")}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-crm-text">New contact</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-crm-muted hover:bg-crm-surface-2"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-crm-text">Name *</label>
            <input
              ref={firstRef}
              value={form.displayName}
              onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
              placeholder="Full name"
              className={crm.input}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-crm-text">Company</label>
              <input
                value={form.company}
                onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
                placeholder="Optional"
                className={crm.input}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-crm-text">Stage</label>
              <select
                value={form.stage}
                onChange={(e) => setForm((f) => ({ ...f, stage: e.target.value as CrmStage }))}
                className={crm.select}
              >
                {(Object.keys(STAGE_LABELS) as Array<CrmStage | "all">)
                  .filter((k) => k !== "all")
                  .map((k) => (
                    <option key={k} value={k}>
                      {STAGE_LABELS[k]}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-crm-text">Phone</label>
            <input
              type="tel"
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              placeholder="+1 …"
              className={crm.input}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-crm-text">Email</label>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="name@company.com"
              className={crm.input}
            />
          </div>

          {error && <p className="text-sm text-crm-danger">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className={crm.btnSecondary}>
              Cancel
            </button>
            <button type="submit" disabled={saving} className={crm.btnPrimary}>
              {saving ? "Creating…" : "Create contact"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CrmContactsPage() {
  const { backendJwtRole, can } = useAppContext();
  const isAdmin =
    backendJwtRole === "ADMIN" ||
    backendJwtRole === "TENANT_ADMIN" ||
    backendJwtRole === "SUPER_ADMIN";

  const canImport = can("can_view_crm_import");
  const canLiveWorkspace = can("can_view_crm_live_call");

  const [rows, setRows] = useState<CrmContact[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [stage, setStage] = useState<CrmStage | "all">("all");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [timezoneZone, setTimezoneZone] = useState<TimezoneZoneFilter>("all");
  const [archiveScope, setArchiveScope] = useState<ArchiveListScope>("active");
  const [page, setPage] = useState(0);
  const [showAdd, setShowAdd] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [crmUsers, setCrmUsers] = useState<CrmUser[]>([]);
  const [bulkAssignUserId, setBulkAssignUserId] = useState<string>("");
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkSkipped, setBulkSkipped] = useState<number>(0);

  // Smart assign (quantity-based, unassigned-only)
  const [showSmartAssign, setShowSmartAssign] = useState(false);
  const [smartAssignCount, setSmartAssignCount] = useState<string>("25");
  const [smartAssignUserId, setSmartAssignUserId] = useState<string>("");
  const [smartAssigning, setSmartAssigning] = useState(false);
  const [smartAssignResult, setSmartAssignResult] = useState<{ assigned: number; remaining: number } | null>(null);
  const [smartAssignError, setSmartAssignError] = useState<string | null>(null);

  const [showBulkEmail, setShowBulkEmail] = useState(false);
  const [bulkEmailToast, setBulkEmailToast] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (
      q: string,
      s: CrmStage | "all",
      mine: boolean,
      scope: ArchiveListScope,
      pageIdx: number,
      tz: TimezoneZoneFilter,
    ) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (q) params.set("q", q);
        if (s !== "all") params.set("stage", s);
        if (mine) params.set("assignedToMe", "true");
        if (tz !== "all") params.set("timezoneZone", tz);
        params.set("limit", String(CONTACTS_PAGE_LIMIT));
        params.set("page", String(pageIdx));
        if (isAdmin) {
          if (scope === "all") {
            params.set("includeArchived", "true");
          } else if (scope === "archived") {
            params.set("includeArchived", "true");
            params.set("archivedOnly", "true");
          }
        }
        const res = await apiGet<ContactsResponse>(`/crm/contacts?${params}`);
        setRows(res.rows);
        setTotal(res.total);
      } catch (err: unknown) {
        setError((err as Error)?.message || "Failed to load contacts");
      } finally {
        setLoading(false);
      }
    },
    [isAdmin],
  );

  useEffect(() => {
    if (!isAdmin && archiveScope !== "active") {
      setArchiveScope("active");
    }
  }, [isAdmin, archiveScope]);

  useEffect(() => {
    void load(search, stage, assignedToMe, isAdmin ? archiveScope : "active", page, timezoneZone);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- search is applied via debounced handler; this effect refetches when scope/stage/assignee/page change
  }, [stage, assignedToMe, archiveScope, page, timezoneZone, load, isAdmin]);

  useEffect(() => {
    setSelectedIds(new Set());
    setBulkAssignUserId("");
    setBulkError(null);
  }, [archiveScope]);

  const handleSearchChange = (val: string) => {
    setSearch(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPage(0);
      void load(val, stage, assignedToMe, isAdmin ? archiveScope : "active", 0, timezoneZone);
    }, 320);
  };

  const handleContactCreated = (c: CrmContact) => {
    setRows((prev) => [c, ...prev]);
    setTotal((t) => t + 1);
  };

  const handleExportCsv = () => {
    const headers = ["Name", "Company", "Phone", "Email", "Stage", "Assigned To", "Last Activity"];
    const csvRows = rows.map((c) =>
      [
        c.displayName,
        c.company ?? "",
        c.primaryPhone?.numberRaw ?? "",
        c.primaryEmail?.email ?? "",
        c.crmStage ? STAGE_LABELS[c.crmStage] : "",
        assignedLabel(c.assignedTo),
        c.lastActivityAt ? formatShortDate(c.lastActivityAt) : "",
      ]
        .map((v) => `"${String(v).replaceAll('"', '""')}"`)
        .join(","),
    );
    const blob = new Blob([[headers.join(","), ...csvRows].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `crm-contacts-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const loadCrmUsers = useCallback(async () => {
    if (crmUsers.length > 0) return;
    try {
      const data = await apiGet<{ users: CrmUser[] }>("/crm/users");
      setCrmUsers(data.users ?? []);
    } catch {
      // non-fatal
    }
  }, [crmUsers.length]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const selectable = rows.filter((r) => !isContactArchived(r));
    const selectableIds = new Set(selectable.map((r) => r.id));
    const allSelectableSelected =
      selectable.length > 0 && selectable.every((r) => selectedIds.has(r.id));

    if (allSelectableSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(selectableIds);
    }
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setBulkAssignUserId("");
    setBulkError(null);
    setBulkSkipped(0);
  };

  const handleBulkReassign = async (assignUserId: string | null) => {
    if (selectedIds.size === 0) return;
    setBulkAssigning(true);
    setBulkError(null);
    setBulkSkipped(0);
    try {
      // skipAssigned=true: when assigning (not clearing), only touch unassigned contacts
      // so contacts already belonging to an agent are never overwritten.
      const res = await apiPost<{ ok: boolean; updated: number; skipped: number }>(
        "/crm/contacts/bulk-reassign",
        {
          contactIds: Array.from(selectedIds),
          assignedToUserId: assignUserId,
          skipAssigned: assignUserId !== null,
        },
      );
      setBulkSkipped(res.skipped ?? 0);
      const assignee = assignUserId ? crmUsers.find((u) => u.userId === assignUserId) ?? null : null;
      setRows((prev) =>
        prev.map((r) => {
          if (!selectedIds.has(r.id)) return r;
          // Only update rows that were actually assigned (not skipped)
          if (assignUserId && r.assignedTo?.id && r.assignedTo.id !== assignUserId) return r;
          return {
            ...r,
            assignedTo: assignee
              ? { id: assignee.userId, displayName: assignee.displayName, email: assignee.email }
              : null,
          };
        }),
      );
      if ((res.skipped ?? 0) === 0) clearSelection();
    } catch (e: unknown) {
      setBulkError((e as Error)?.message || "Bulk reassign failed");
    } finally {
      setBulkAssigning(false);
    }
  };

  const handleSmartAssign = async () => {
    const count = parseInt(smartAssignCount, 10);
    if (!count || count < 1 || !smartAssignUserId) return;
    setSmartAssigning(true);
    setSmartAssignError(null);
    setSmartAssignResult(null);
    try {
      void loadCrmUsers();
      const res = await apiPost<{ ok: boolean; assigned: number; remaining: number }>(
        "/crm/contacts/smart-assign",
        { count, assignedToUserId: smartAssignUserId },
      );
      setSmartAssignResult({ assigned: res.assigned, remaining: res.remaining });
      // Refresh the contacts list to reflect new assignments
      void load(search, stage, assignedToMe, isAdmin ? archiveScope : "active", page, timezoneZone);
    } catch (e: unknown) {
      setSmartAssignError((e as Error)?.message || "Smart assign failed");
    } finally {
      setSmartAssigning(false);
    }
  };

  const pageTagOptions = useMemo(() => {
    const counts = new Map<string, { tag: ContactTag; count: number }>();
    for (const c of rows) {
      for (const tagItem of c.tags ?? []) {
        const existing = counts.get(tagItem.id);
        counts.set(tagItem.id, { tag: tagItem, count: (existing?.count ?? 0) + 1 });
      }
    }
    return Array.from(counts.values()).sort((a, b) => b.count - a.count || a.tag.name.localeCompare(b.tag.name));
  }, [rows]);

  const displayedRows = useMemo(() => {
    return rows.filter((c) => {
      const matchesTag = tagFilter === "all" || (c.tags ?? []).some((t) => t.id === tagFilter);
      return matchesTag && matchesQuickFilter(c, quickFilter);
    });
  }, [quickFilter, rows, tagFilter]);

  const selectableRows = useMemo(() => displayedRows.filter((r) => !isContactArchived(r)), [displayedRows]);
  const allSelectableSelected =
    selectableRows.length > 0 && selectableRows.every((r) => selectedIds.has(r.id));

  const hasListFilters =
    !!search ||
    stage !== "all" ||
    quickFilter !== "all" ||
    tagFilter !== "all" ||
    timezoneZone !== "all" ||
    assignedToMe ||
    (isAdmin && archiveScope !== "active");

  const summary = useMemo(() => {
    let missingPhone = 0;
    let missingEmail = 0;
    let archivedOnPage = 0;
    let activeOnPage = 0;
    let contacted = 0;
    let engaged = 0;
    let newThisMonth = 0;
    let needsFollowUp = 0;
    for (const r of rows) {
      if (!r.primaryPhone) missingPhone += 1;
      if (!r.primaryEmail) missingEmail += 1;
      if (isContactArchived(r)) archivedOnPage += 1;
      else activeOnPage += 1;
      if (r.crmStage === "CONTACTED") contacted += 1;
      if (r.crmStage === "QUALIFIED" || r.crmStage === "CUSTOMER") engaged += 1;
      if (isNewThisMonth(r)) newThisMonth += 1;
      if (!!r.lastActivityAt && r.crmStage !== "CUSTOMER" && r.crmStage !== "CLOSED_LOST") needsFollowUp += 1;
    }
    return { missingPhone, missingEmail, archivedOnPage, activeOnPage, contacted, engaged, newThisMonth, needsFollowUp };
  }, [rows]);

  const stageDistribution = useMemo(() => {
    const counts = new Map<CrmStage, number>();
    for (const row of rows) {
      if (row.crmStage) counts.set(row.crmStage, (counts.get(row.crmStage) ?? 0) + 1);
    }
    return (Object.keys(STAGE_LABELS) as Array<CrmStage | "all">)
      .filter((key): key is CrmStage => key !== "all")
      .map((key) => ({ key, label: STAGE_LABELS[key], count: counts.get(key) ?? 0 }))
      .filter((item) => item.count > 0);
  }, [rows]);

  const recentActivity = useMemo(() => {
    return [...rows]
      .filter((c) => c.lastActivityAt || c.lastDispositionAt || c.updatedAt)
      .sort((a, b) => new Date(b.lastActivityAt ?? b.lastDispositionAt ?? b.updatedAt ?? 0).getTime() - new Date(a.lastActivityAt ?? a.lastDispositionAt ?? a.updatedAt ?? 0).getTime())
      .slice(0, 4);
  }, [rows]);

  const sliceFrom = total === 0 ? 0 : page * CONTACTS_PAGE_LIMIT + 1;
  const sliceTo = Math.min((page + 1) * CONTACTS_PAGE_LIMIT, total);
  const canPrev = page > 0;
  const canNext = (page + 1) * CONTACTS_PAGE_LIMIT < total;

  const resetFilters = () => {
    setSearch("");
    setStage("all");
    setQuickFilter("all");
    setTagFilter("all");
    setAssignedToMe(false);
    if (isAdmin) setArchiveScope("active");
    setTimezoneZone("all");
    setPage(0);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    void load("", "all", false, "active", 0, "all");
  };

  const firstEmail = displayedRows.find((c) => c.primaryEmail)?.primaryEmail?.email;
  const engagementRate = rows.length > 0 ? Math.round((summary.engaged / rows.length) * 100) : 0;
  const reachableTotal = rows.filter((c) => c.primaryPhone && !c.doNotCall).length;

  return (
    <CRMPageShell className={crm.contactsWorkspace} innerClassName={crm.pageInnerContacts}>
      {showAdd && <AddContactModal onClose={() => setShowAdd(false)} onCreated={handleContactCreated} />}
      {showBulkEmail && (
        <BulkEmailModal
          audience={{
            sourceType: "CONTACTS",
            contactIds: Array.from(selectedIds),
            selectAll: false,
            tagId: tagFilter !== "all" ? tagFilter : undefined,
            stage: stage !== "all" ? stage : undefined,
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

      <CRMPageHeader
        className={crm.contactsHeaderPanel}
        icon={<Users className="h-6 w-6" aria-hidden />}
        title="Contacts"
        subtitle="A warmer relationship command center for search, segmentation, live workspace handoff, and clean follow-up operations."
        actions={
          <div className="contacts-hero-actions flex flex-wrap items-center gap-2">
            <button type="button" onClick={handleExportCsv} className={crm.btnSecondary} disabled={rows.length === 0}>
              <Download className="h-4 w-4" />
              Export
            </button>
            <button type="button" onClick={() => setShowAdd(true)} className={cn(crm.btnPrimary, "contacts-new-contact-cta")}>
              <Plus className="h-4 w-4" />
              New contact
            </button>
          </div>
        }
      />

      {!loading && !error && (rows.length > 0 || total > 0) && (
        <section className="contacts-kpi-strip grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <ContactKpiTile label="Total Contacts" value={total} micro={`${sliceFrom}-${sliceTo} showing`} icon={<Users className="h-4 w-4" />} accent="blue" />
          <ContactKpiTile label="New This 30 Days" value={summary.newThisMonth} micro="recently created" icon={<Sparkles className="h-4 w-4" />} accent="violet" />
          <ContactKpiTile label="Contacted" value={summary.contacted} micro="stage matched" icon={<Phone className="h-4 w-4" />} accent="cyan" />
          <ContactKpiTile label="Engaged" value={summary.engaged} micro={`${engagementRate}% of page`} icon={<CheckCircle2 className="h-4 w-4" />} accent="green" />
          <ContactKpiTile label="Unreachable" value={summary.missingPhone + rows.filter((r) => r.doNotCall).length} micro="no phone or DNC" icon={<PhoneOff className="h-4 w-4" />} accent="rose" />
          <ContactKpiTile label="Needs Follow Up" value={summary.needsFollowUp} micro="recent activity" icon={<CalendarClock className="h-4 w-4" />} accent="amber" />
        </section>
      )}

      <CRMCard className={cn(crm.contactsPanel, crm.contactsFilterBar, "p-4 sm:p-5")}>
        <div className="contacts-filter-grid">
          <div className="contacts-search-wrap">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-crm-muted/80" />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="Search name, phone, email, or company..."
              className="contacts-search-input"
              aria-label="Search contacts"
            />
            {search && (
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setPage(0);
                  if (debounceRef.current) clearTimeout(debounceRef.current);
                  void load("", stage, assignedToMe, isAdmin ? archiveScope : "active", 0, timezoneZone);
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-crm-muted/80 hover:bg-crm-surface-2"
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <select className="contacts-filter-select" aria-label="Campaign filter" disabled>
            <option>All campaigns</option>
          </select>
          <select
            className="contacts-filter-select"
            aria-label="Tag filter"
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
          >
            <option value="all">All tags</option>
            {pageTagOptions.map(({ tag: tagItem, count }) => (
              <option key={tagItem.id} value={tagItem.id}>{tagItem.name} ({count})</option>
            ))}
          </select>
          <select
            className="contacts-filter-select"
            aria-label="Timezone filter"
            value={timezoneZone}
            onChange={(e) => {
              setTimezoneZone(e.target.value as TimezoneZoneFilter);
              setPage(0);
            }}
          >
            {TIMEZONE_ZONE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <select
            className="contacts-filter-select"
            aria-label="Status filter"
            value={stage}
            onChange={(e) => {
              setPage(0);
              setStage(e.target.value as CrmStage | "all");
            }}
          >
            {FILTER_TABS.map((tab) => (
              <option key={tab} value={tab}>{STAGE_LABELS[tab]}</option>
            ))}
          </select>
          <button type="button" onClick={resetFilters} className="contacts-filter-button">
            <Filter className="h-4 w-4" />
            Filters
          </button>
        </div>

        <div className="mt-4 flex flex-col gap-3 border-t border-crm-border/60 pt-4">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Quick filters">
            {QUICK_FILTERS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setQuickFilter(item.key)}
                className={quickFilter === item.key ? crm.filterPillActive : crm.filterPill}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isAdmin && (
              <div className={crm.filterPillGroup} role="group" aria-label="List scope">
                <span className="pl-1 text-[10px] font-semibold uppercase tracking-wide text-crm-muted/80">List</span>
                {(["active", "archived", "all"] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setPage(0);
                      setArchiveScope(key);
                    }}
                    className={archiveScope === key ? crm.filterPillActive : crm.filterPill}
                  >
                    {ARCHIVE_SCOPE_LABELS[key]}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                setPage(0);
                setAssignedToMe((v) => !v);
              }}
              className={assignedToMe ? crm.filterPillActive : crm.filterPill}
            >
              Assigned to me
            </button>
          </div>
        </div>
      </CRMCard>

      {/* Smart Assign panel — admin only, quantity-based, unassigned leads only */}
      {isAdmin && (
        <div className={cn(crm.contactsBulkBar, "border-crm-border bg-crm-surface shadow-crm flex-wrap gap-y-2")}>
          <button
            type="button"
            onClick={() => {
              setShowSmartAssign((v) => !v);
              setSmartAssignResult(null);
              setSmartAssignError(null);
              void loadCrmUsers();
            }}
            className={cn(crm.btnSecondary, "px-3 py-1.5 text-sm gap-1.5")}
          >
            <UserPlus className="h-3.5 w-3.5" />
            Smart Assign
          </button>
          {showSmartAssign && (
            <>
              <input
                type="number"
                min={1}
                max={500}
                value={smartAssignCount}
                onChange={(e) => { setSmartAssignCount(e.target.value); setSmartAssignResult(null); }}
                className={cn(crm.selectCompact, "w-20 text-center")}
                aria-label="Number of leads to assign"
                placeholder="25"
              />
              <span className="text-sm text-crm-muted">unassigned leads to</span>
              <select
                value={smartAssignUserId}
                onChange={(e) => { setSmartAssignUserId(e.target.value); setSmartAssignResult(null); }}
                className={crm.selectCompact}
                aria-label="Assign to agent"
              >
                <option value="">Pick agent…</option>
                {crmUsers.map((u) => (
                  <option key={u.userId} value={u.userId}>{u.displayName}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleSmartAssign}
                disabled={smartAssigning || !smartAssignUserId || !smartAssignCount || parseInt(smartAssignCount, 10) < 1}
                className={cn(crm.btnSecondary, "px-3 py-1.5 text-sm disabled:opacity-50")}
              >
                <UserCheck className="h-3.5 w-3.5" />
                {smartAssigning ? "Assigning…" : "Assign"}
              </button>
              {smartAssignResult && (
                <span className={cn("text-xs font-medium", smartAssignResult.assigned === 0 ? "text-crm-muted" : "text-crm-success")}>
                  {smartAssignResult.assigned === 0
                    ? "No unassigned leads available"
                    : `✓ ${smartAssignResult.assigned} assigned · ${smartAssignResult.remaining} unassigned remain`}
                </span>
              )}
              {smartAssignError && <span className="text-xs text-crm-danger">{smartAssignError}</span>}
            </>
          )}
        </div>
      )}

      {bulkEmailToast && (
        <div className="rounded-crm border border-crm-success/40 bg-crm-success/10 px-4 py-2.5 text-sm font-medium text-crm-success">
          {bulkEmailToast}
        </div>
      )}

      {isAdmin && selectedIds.size > 0 && (
        <div className={cn(crm.contactsBulkBar, "border-crm-border bg-crm-surface shadow-crm")}>
            <span className="text-sm font-medium text-crm-text">{selectedIds.size} selected</span>
            <button
              type="button"
              onClick={() => setShowBulkEmail(true)}
              className={cn(crm.btnSecondary, "px-3 py-1.5 text-sm gap-1.5")}
            >
              <Mail className="h-3.5 w-3.5" />
              Send Email
            </button>
            <select
              value={bulkAssignUserId}
              onChange={(e) => {
                setBulkAssignUserId(e.target.value);
                void loadCrmUsers();
              }}
              className={crm.selectCompact}
            >
              <option value="">Assign to…</option>
              {crmUsers.map((u) => (
                <option key={u.userId} value={u.userId}>
                  {u.displayName}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => handleBulkReassign(bulkAssignUserId || null)}
              disabled={bulkAssigning || !bulkAssignUserId}
              className={cn(crm.btnSecondary, "px-3 py-1.5 text-sm disabled:opacity-50")}
            >
              <UserCheck className="h-3.5 w-3.5" />
              {bulkAssigning ? "Assigning…" : "Assign"}
            </button>
            <button
              type="button"
              onClick={() => handleBulkReassign(null)}
              disabled={bulkAssigning}
              className="text-sm font-medium text-crm-muted hover:text-crm-text disabled:opacity-50"
            >
              Clear assignment
            </button>
            {bulkSkipped > 0 && (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                {bulkSkipped} skipped (already assigned to another agent)
              </span>
            )}
            {bulkError && <span className="text-xs text-crm-danger">{bulkError}</span>}
            <button
              type="button"
              onClick={clearSelection}
              className="ml-auto text-sm text-crm-muted hover:text-crm-text"
            >
              Dismiss
            </button>
        </div>
      )}

      {loading && (
        <div className="space-y-3 py-6" aria-busy="true" aria-label="Loading contacts">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-crm-lg border border-crm-border bg-crm-surface-2/80" />
          ))}
        </div>
      )}

      {!loading && error && <div className="rounded-crm border border-crm-danger/35 bg-crm-danger/15 px-4 py-3 text-sm text-crm-danger">{error}</div>}

      {!loading && !error && (rows.length === 0 || displayedRows.length === 0) && (
        <div className={cn(crm.contactsEmpty, "border-crm-border bg-crm-surface")}>
          <UserRound className="mx-auto mb-3 h-10 w-10 text-crm-border" aria-hidden />
          <p className="text-lg font-semibold text-crm-text">
            {hasListFilters ? "No contacts match these filters" : "No contacts yet"}
          </p>
          <p className="mx-auto mt-2 max-w-md text-sm text-crm-muted">
            {hasListFilters
              ? "Adjust search, status, tag, assignment, or list scope to broaden this workspace."
              : "Add a person manually or import via a Campaign. Records stay in this tenant only."}
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {hasListFilters ? (
              <button type="button" onClick={resetFilters} className={crm.btnSecondary}>Reset filters</button>
            ) : (
              <button type="button" onClick={() => setShowAdd(true)} className={crm.btnPrimary}>
                <Plus className="h-4 w-4" />
                New contact
              </button>
            )}
            {canImport && (
              <Link href="/crm/campaigns" className={crm.btnSecondary}>
                <FileUp className="h-4 w-4" />
                Import via Campaign
              </Link>
            )}
          </div>
        </div>
      )}

      {!loading && !error && displayedRows.length > 0 && (
        <div className="contacts-main-grid grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(19rem,24rem)]">
          <div className="min-w-0">
            <CRMCard className={cn(crm.contactsPanel, crm.contactsListShell)}>
              <div className={cn(crm.contactsListSelectBar, "border-crm-border bg-crm-surface-2/40")}>
                {isAdmin ? (
                  <label className="flex cursor-pointer items-center gap-2.5 text-sm text-crm-muted">
                    <input
                      type="checkbox"
                      checked={allSelectableSelected}
                      onChange={toggleSelectAll}
                      disabled={selectableRows.length === 0}
                      className={crm.checkbox}
                    />
                    <span>Select active on this page</span>
                  </label>
                ) : (
                  <span className="text-sm font-semibold text-crm-text">Contact directory</span>
                )}
                <span className="ml-auto text-xs text-crm-muted">{displayedRows.length} shown · {total} total</span>
              </div>
              <ul className="contacts-row-list">
                {displayedRows.map((c) => {
                  const archived = isContactArchived(c);
                  return (
                    <li key={c.id} className={cn(crm.contactsListRow, "contacts-list-item", archived && "opacity-80")}>
                      <div className="contacts-row-grid">
                        {isAdmin && (
                          <div className="flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
                            {!archived ? (
                              <input
                                type="checkbox"
                                checked={selectedIds.has(c.id)}
                                onChange={() => {
                                  toggleSelect(c.id);
                                  void loadCrmUsers();
                                }}
                                className={crm.checkbox}
                                aria-label={`Select ${c.displayName}`}
                              />
                            ) : (
                              <Archive className="h-4 w-4 text-crm-muted" />
                            )}
                          </div>
                        )}
                        <div className="contacts-avatar">{initials(c.displayName)}</div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="truncate text-lg font-bold tracking-tight text-crm-text">{c.displayName}</h2>
                            {c.crmStage && <span className={cn("contacts-stage-pill", stageTone(c.crmStage))}>{STAGE_LABELS[c.crmStage]}</span>}
                            {(() => {
                              const badge = leadTimezoneBadgeShort(c);
                              if (badge) {
                                return (
                                  <span
                                    className={cn("contacts-stage-pill", timezoneBadgeClass(c))}
                                    title={leadTimezoneBadgeTitle(c)}
                                  >
                                    {badge}
                                  </span>
                                );
                              }
                              if (c.timezoneResolutionStatus === "NEEDS_REVIEW") {
                                return <span className={cn("contacts-stage-pill", "contacts-stage-muted")}>Review</span>;
                              }
                              if (c.timezoneResolutionStatus === "MISSING_LOCATION") {
                                return <span className={cn("contacts-stage-pill", "contacts-stage-muted")}>No tz</span>;
                              }
                              return null;
                            })()}
                            {c.doNotCall && <span className="contacts-danger-pill">DNC</span>}
                          </div>
                          <p className="mt-1 truncate text-sm font-medium text-crm-muted">
                            {c.title || c.company || assignedLabel(c.assignedTo)}
                          </p>
                        </div>
                        <div className="contacts-data-cell">
                          <Phone className="h-4 w-4" />
                          <span className="truncate">{c.primaryPhone?.numberRaw ?? "No phone"}</span>
                        </div>
                        <div className="contacts-data-cell">
                          <Mail className="h-4 w-4" />
                          <span className="truncate">{c.primaryEmail?.email ?? "No email"}</span>
                        </div>
                        <div className="contacts-data-cell">
                          <Clock className="h-4 w-4" />
                          <span>{relativeDate(c.lastActivityAt ?? c.lastDispositionAt ?? c.updatedAt)}</span>
                        </div>
                        <div className="flex items-center justify-end gap-2">
                          <Link href={`/crm/contacts/${c.id}`} className={cn(crm.btnPrimary, "contacts-open-button")}>
                            Open
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Link>
                          {canLiveWorkspace && !archived && (
                            <Link href={`/crm/live-call?contactId=${encodeURIComponent(c.id)}`} className="contacts-menu-button" aria-label={`Open ${c.displayName} live workspace`}>
                              <Activity className="h-4 w-4" />
                            </Link>
                          )}
                          <Link href={`/crm/contacts/${c.id}`} className="contacts-menu-button" aria-label={`More options for ${c.displayName}`}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Link>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </CRMCard>
          </div>

          <aside className="contacts-right-rail flex min-w-0 flex-col gap-3">
            <RailCard title="Contact Insights" subtitle="Current page relationship mix" icon={<PieChart className="h-4 w-4" />}>
              <div className="contacts-donut-wrap">
                <div className="contacts-donut" style={{ "--engaged": `${engagementRate}%` } as React.CSSProperties}>
                  <span>{engagementRate}%</span>
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  {stageDistribution.slice(0, 4).map((item) => (
                    <div key={item.key} className="contacts-legend-row">
                      <span className={cn("contacts-legend-dot", stageTone(item.key))} />
                      <span>{item.label}</span>
                      <strong>{item.count}</strong>
                    </div>
                  ))}
                </div>
              </div>
            </RailCard>

            <RailCard title="Top Contact Sources" subtitle="Live availability segments" icon={<BarChart3 className="h-4 w-4" />}>
              {[
                { label: "Reachable by phone", value: reachableTotal, icon: <Phone className="h-3.5 w-3.5" /> },
                { label: "Email ready", value: rows.length - summary.missingEmail, icon: <AtSign className="h-3.5 w-3.5" /> },
                { label: "Assigned records", value: rows.filter((c) => !!c.assignedTo).length, icon: <UserCheck className="h-3.5 w-3.5" /> },
              ].map((item) => (
                <div key={item.label} className="contacts-source-row">
                  <div className="flex items-center gap-2 text-sm font-semibold text-crm-text">
                    <span className="contacts-source-icon">{item.icon}</span>
                    {item.label}
                  </div>
                  <span className="text-xs font-bold tabular-nums text-crm-muted">{progressPercent(item.value, rows.length)}%</span>
                  <div className="contacts-progress-track">
                    <span style={{ width: `${progressPercent(item.value, rows.length)}%` }} />
                  </div>
                </div>
              ))}
            </RailCard>

            <RailCard title="Recent Activity" subtitle="Newest contact movement" icon={<Activity className="h-4 w-4" />}>
              <div className="space-y-2">
                {recentActivity.map((item) => (
                  <Link key={item.id} href={`/crm/contacts/${item.id}`} className="contacts-activity-row">
                    <span className="contacts-activity-icon"><ArrowUpRight className="h-3.5 w-3.5" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-crm-text">{item.displayName}</span>
                      <span className="block text-xs text-crm-muted">{relativeDate(item.lastActivityAt ?? item.lastDispositionAt ?? item.updatedAt)}</span>
                    </span>
                  </Link>
                ))}
              </div>
            </RailCard>
          </aside>
        </div>
      )}

      {!loading && !error && displayedRows.length > 0 && (
        <div className="contacts-bottom-grid grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,28rem)]">
          <CRMCard className={cn(crm.contactsPanel, "p-4 sm:p-5")}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-base font-bold text-crm-text">Quick Actions</p>
                <p className="mt-1 text-xs text-crm-muted">Operational shortcuts for the current contact set.</p>
              </div>
              <Sparkles className="h-5 w-5 text-crm-accent" />
            </div>
            <div className="contacts-quick-actions">
              <button type="button" onClick={() => setShowAdd(true)} className="contacts-quick-action contacts-quick-blue"><UserPlus className="h-4 w-4" />Add Contact</button>
              {canImport && <Link href="/crm/campaigns" className="contacts-quick-action contacts-quick-violet"><FileUp className="h-4 w-4" />Import via Campaign</Link>}
              <Link href="/crm/tasks" className="contacts-quick-action contacts-quick-green"><CalendarClock className="h-4 w-4" />Create Task</Link>
              <a href={firstEmail ? `mailto:${firstEmail}` : undefined} aria-disabled={!firstEmail} className={cn("contacts-quick-action contacts-quick-amber", !firstEmail && "pointer-events-none opacity-50")}><Send className="h-4 w-4" />Send Email</a>
              <Link href="/crm/campaigns" className="contacts-quick-action contacts-quick-rose"><Megaphone className="h-4 w-4" />Start Campaign</Link>
            </div>
          </CRMCard>

          <CRMCard className={cn(crm.contactsPanel, "p-4 sm:p-5")}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-base font-bold text-crm-text">Popular Tags</p>
                <p className="mt-1 text-xs text-crm-muted">Top tags found in this live result set.</p>
              </div>
              <Tag className="h-5 w-5 text-crm-accent" />
            </div>
            <div className="flex flex-wrap gap-2">
              {pageTagOptions.length > 0 ? pageTagOptions.slice(0, 10).map(({ tag: tagItem, count }) => (
                <button key={tagItem.id} type="button" onClick={() => setTagFilter(tagItem.id)} className={tagFilter === tagItem.id ? crm.filterPillActive : crm.filterPill}>
                  {tagItem.name}
                  <span className="ml-1 tabular-nums opacity-75">{count}</span>
                </button>
              )) : (
                <span className="rounded-full border border-crm-border bg-crm-surface-2 px-3 py-1.5 text-xs font-medium text-crm-muted">No tags on this page</span>
              )}
              <button type="button" disabled className={cn(crm.filterPill, "cursor-not-allowed opacity-60")}>Add tag</button>
            </div>
          </CRMCard>
        </div>
      )}

      {!loading && !error && total > 0 && (canPrev || canNext) && (
          <nav
            className={cn(crm.contactsPagination, "border-crm-border bg-crm-surface shadow-crm")}
            aria-label="Contacts pagination"
          >
            <p className="text-center text-sm text-crm-muted sm:text-left">
              Page{" "}
              <span className="font-medium tabular-nums text-crm-text">{page + 1}</span> of{" "}
              <span className="font-medium tabular-nums text-crm-text">
                {Math.max(1, Math.ceil(total / CONTACTS_PAGE_LIMIT))}
              </span>
            </p>
            <div className="flex justify-center gap-2 sm:justify-end">
              <button
                type="button"
                disabled={!canPrev}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className={cn(crm.btnSecondary, "disabled:cursor-not-allowed disabled:opacity-40")}
              >
                <ChevronLeft className="h-4 w-4" aria-hidden />
                Previous
              </button>
              <button
                type="button"
                disabled={!canNext}
                onClick={() => setPage((p) => p + 1)}
                className={cn(crm.btnSecondary, "disabled:cursor-not-allowed disabled:opacity-40")}
              >
                Next
                <ChevronRight className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </nav>
      )}
    </CRMPageShell>
  );
}
