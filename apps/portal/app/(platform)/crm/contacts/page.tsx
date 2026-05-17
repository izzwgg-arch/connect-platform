"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Phone,
  Mail,
  Plus,
  Search,
  X,
  UserRound,
  UserCheck,
  Users,
  FileUp,
  ExternalLink,
  Radio,
  ChevronLeft,
  ChevronRight,
  ListOrdered,
  Archive,
  PhoneOff,
  AtSign,
  Activity,
} from "lucide-react";
import {
  CRMPageShell,
  CRMPageHeader,
  CRMEmptyState,
  CRMCard,
  crm,
  cn,
} from "../../../../components/crm";
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

type CrmContact = {
  id: string;
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  primaryPhone?: { numberRaw: string } | null;
  primaryEmail?: { email: string } | null;
  crmStage?: CrmStage | null;
  assignedTo?: AssignedUser | null;
  doNotCall: boolean;
  createdAt: string;
  updatedAt?: string;
  lastActivityAt?: string | null;
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

const STAGE_BADGE_CLASS: Record<CrmStage, string> = {
  LEAD: "bg-crm-accent/12 text-crm-accent border-crm-accent/30",
  CONTACTED: "bg-crm-warning/15 text-crm-warning border-crm-warning/35",
  QUALIFIED: "bg-crm-success/15 text-crm-success border-crm-success/35",
  CUSTOMER: "bg-crm-accent/15 text-crm-accent border-crm-accent/40",
  CLOSED_LOST: "bg-crm-surface-2 text-crm-muted border-crm-border",
};

const FILTER_TABS = ["all", "LEAD", "CONTACTED", "QUALIFIED", "CUSTOMER", "CLOSED_LOST"] as const;

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

function SummaryStatTile({
  label,
  value,
  icon,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  icon: React.ReactNode;
  tone?: "default" | "warn" | "muted";
}) {
  const valueClass =
    tone === "warn"
      ? "text-xl font-semibold tabular-nums text-crm-warning"
      : tone === "muted"
        ? "text-xl font-semibold tabular-nums text-crm-muted"
        : "text-xl font-semibold tabular-nums text-crm-text";

  return (
    <div className={cn(crm.contactsKpiTile, "border-crm-border bg-crm-surface-2/60")}>
      <div className="flex items-center gap-2 text-crm-muted">
        <span className={cn(crm.contactsKpiIcon, "bg-crm-surface text-crm-accent")}>{icon}</span>
        <span className="text-[11px] font-semibold uppercase tracking-wide">{label}</span>
      </div>
      <p className={valueClass}>{value}</p>
    </div>
  );
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
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [archiveScope, setArchiveScope] = useState<ArchiveListScope>("active");
  const [page, setPage] = useState(0);
  const [showAdd, setShowAdd] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [crmUsers, setCrmUsers] = useState<CrmUser[]>([]);
  const [bulkAssignUserId, setBulkAssignUserId] = useState<string>("");
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (q: string, s: CrmStage | "all", mine: boolean, scope: ArchiveListScope, pageIdx: number) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (q) params.set("q", q);
        if (s !== "all") params.set("stage", s);
        if (mine) params.set("assignedToMe", "true");
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
    void load(search, stage, assignedToMe, isAdmin ? archiveScope : "active", page);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- search is applied via debounced handler; this effect refetches when scope/stage/assignee/page change
  }, [stage, assignedToMe, archiveScope, page, load, isAdmin]);

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
      void load(val, stage, assignedToMe, isAdmin ? archiveScope : "active", 0);
    }, 320);
  };

  const handleContactCreated = (c: CrmContact) => {
    setRows((prev) => [c, ...prev]);
    setTotal((t) => t + 1);
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
  };

  const handleBulkReassign = async (assignUserId: string | null) => {
    if (selectedIds.size === 0) return;
    setBulkAssigning(true);
    setBulkError(null);
    try {
      await apiPost("/crm/contacts/bulk-reassign", {
        contactIds: Array.from(selectedIds),
        assignedToUserId: assignUserId,
      });
      const assignee = assignUserId ? crmUsers.find((u) => u.userId === assignUserId) ?? null : null;
      setRows((prev) =>
        prev.map((r) =>
          selectedIds.has(r.id)
            ? {
                ...r,
                assignedTo: assignee
                  ? {
                      id: assignee.userId,
                      displayName: assignee.displayName,
                      email: assignee.email,
                    }
                  : null,
              }
            : r,
        ),
      );
      clearSelection();
    } catch (e: unknown) {
      setBulkError((e as Error)?.message || "Bulk reassign failed");
    } finally {
      setBulkAssigning(false);
    }
  };

  const selectableRows = useMemo(() => rows.filter((r) => !isContactArchived(r)), [rows]);
  const allSelectableSelected =
    selectableRows.length > 0 && selectableRows.every((r) => selectedIds.has(r.id));

  const hasListFilters =
    !!search || stage !== "all" || assignedToMe || (isAdmin && archiveScope !== "active");

  const summary = useMemo(() => {
    let missingPhone = 0;
    let missingEmail = 0;
    let archivedOnPage = 0;
    let activeOnPage = 0;
    for (const r of rows) {
      if (!r.primaryPhone) missingPhone += 1;
      if (!r.primaryEmail) missingEmail += 1;
      if (isContactArchived(r)) archivedOnPage += 1;
      else activeOnPage += 1;
    }
    return { missingPhone, missingEmail, archivedOnPage, activeOnPage };
  }, [rows]);

  const sliceFrom = total === 0 ? 0 : page * CONTACTS_PAGE_LIMIT + 1;
  const sliceTo = Math.min((page + 1) * CONTACTS_PAGE_LIMIT, total);
  const canPrev = page > 0;
  const canNext = (page + 1) * CONTACTS_PAGE_LIMIT < total;

  const resetFilters = () => {
    setSearch("");
    setStage("all");
    setAssignedToMe(false);
    if (isAdmin) setArchiveScope("active");
    setPage(0);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    void load("", "all", false, "active", 0);
  };

  return (
    <CRMPageShell innerClassName={cn(crm.pageInnerContacts, crm.contactsWorkspace)}>
      {showAdd && <AddContactModal onClose={() => setShowAdd(false)} onCreated={handleContactCreated} />}

      <CRMPageHeader
        className={crm.contactsHeaderPanel}
        icon={<Users className="h-5 w-5" aria-hidden />}
        title="Contacts"
        subtitle="Relationship command center — search, open records, work the live desk, and bulk-assign when you are admin."
        actions={
          <>
            <Link href="/crm/queue" className={crm.btnSecondary}>
              <ListOrdered className="h-4 w-4 text-crm-muted" />
              My queue
            </Link>
            {canImport && (
              <Link href="/crm/import" className={crm.btnSecondary}>
                <FileUp className="h-4 w-4 text-crm-muted" />
                Import
              </Link>
            )}
            <button type="button" onClick={() => setShowAdd(true)} className={crm.btnPrimary}>
              <Plus className="h-4 w-4" />
              New contact
            </button>
          </>
        }
      />

      {!loading && !error && (rows.length > 0 || total > 0) && (
        <CRMCard className={cn(crm.contactsPanel, "p-4 sm:p-5")}>
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className={crm.label}>Matching filters</p>
              <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-crm-text">{total}</p>
              <p className="mt-1 text-sm text-crm-muted">
                Showing{" "}
                <span className="font-medium tabular-nums text-crm-text">
                  {sliceFrom}–{sliceTo}
                </span>{" "}
                on this page
              </p>
            </div>
            <p className="max-w-md text-[11px] leading-relaxed text-crm-muted sm:text-right">
              Phone, email, and active/archived tiles count only this page — not tenant-wide analytics.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <SummaryStatTile label="Active" value={summary.activeOnPage} icon={<Users className="h-4 w-4" />} />
            {isAdmin && (
              <SummaryStatTile
                label="Archived"
                value={summary.archivedOnPage}
                icon={<Archive className="h-4 w-4" />}
                tone="muted"
              />
            )}
            <SummaryStatTile
              label="No phone"
              value={summary.missingPhone}
              icon={<PhoneOff className="h-4 w-4" />}
              tone="warn"
            />
            <SummaryStatTile
              label="No email"
              value={summary.missingEmail}
              icon={<AtSign className="h-4 w-4" />}
              tone="warn"
            />
            <SummaryStatTile
              label="Stage filter"
              value={stage === "all" ? "All" : STAGE_LABELS[stage]}
              icon={<Activity className="h-4 w-4" />}
            />
          </div>
        </CRMCard>
      )}

      <CRMCard className={cn(crm.contactsPanel, crm.contactsFilterBar, "p-4 sm:p-5")}>
          <p className={cn(crm.label, "mb-3")}>Find & filter</p>
          <div className="relative w-full">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-crm-muted/80" />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="Search by name, phone, email, or company…"
              className={cn(crm.input, crm.inputWithIcon, "py-3 text-[15px]")}
              aria-label="Search contacts"
            />
            {search && (
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setPage(0);
                  if (debounceRef.current) clearTimeout(debounceRef.current);
                  void load("", stage, assignedToMe, isAdmin ? archiveScope : "active", 0);
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-crm-muted/80 hover:bg-crm-surface-2"
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className="mt-4 flex flex-col gap-4 border-t border-crm-border/60 pt-4 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Stage filter">
              {FILTER_TABS.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => {
                    setPage(0);
                    setStage(tab);
                  }}
                  className={stage === tab ? crm.filterPillActive : crm.filterPill}
                >
                  {STAGE_LABELS[tab]}
                </button>
              ))}
            </div>

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
              className={cn(assignedToMe ? crm.filterPillActive : crm.filterPill, "lg:ml-auto")}
            >
              Assigned to me
            </button>
          </div>
      </CRMCard>

        {/* Bulk bar — compact, not full-width promo */}
        {isAdmin && selectedIds.size > 0 && (
          <div className={cn(crm.contactsBulkBar, "border-crm-border bg-crm-surface shadow-crm")}>
            <span className="text-sm font-medium text-crm-text">{selectedIds.size} selected</span>
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

        {/* List */}
        {loading && (
          <div className="space-y-3 py-6" aria-busy="true" aria-label="Loading contacts">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-28 animate-pulse rounded-crm-lg border border-crm-border bg-crm-surface-2/80"
              />
            ))}
          </div>
        )}

        {!loading && error && <div className="rounded-crm border border-crm-danger/35 bg-crm-danger/15 px-4 py-3 text-sm text-crm-danger">{error}</div>}

        {!loading && !error && rows.length === 0 && (
          <div className={cn(crm.contactsEmpty, "border-crm-border bg-crm-surface")}>
            <UserRound className="mx-auto mb-3 h-10 w-10 text-crm-border" aria-hidden />
            {hasListFilters ? (
              <>
                <p className="text-base font-medium text-crm-text">No contacts match these filters</p>
                <p className="mx-auto mt-2 max-w-md text-sm text-crm-muted">
                  Adjust search, stage, assignment, or list scope — or reset everything to see the default active
                  directory.
                </p>
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    onClick={resetFilters}
                    className={crm.btnSecondary}
                  >
                    Reset filters
                  </button>
                  {search && (
                    <button
                      type="button"
                      onClick={() => {
                        setSearch("");
                        setPage(0);
                        if (debounceRef.current) clearTimeout(debounceRef.current);
                        void load("", stage, assignedToMe, isAdmin ? archiveScope : "active", 0);
                      }}
                      className={crm.btnPrimary}
                    >
                      Clear search only
                    </button>
                  )}
                </div>
              </>
            ) : isAdmin && archiveScope === "archived" ? (
              <>
                <p className="text-base font-medium text-crm-text">No archived contacts</p>
                <p className="mx-auto mt-2 max-w-md text-sm text-crm-muted">
                  Archived contacts are hidden from the active list. When you archive from a contact record, it will
                  appear here for admins.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setArchiveScope("active");
                    setPage(0);
                  }}
                  className={cn(crm.btnSecondary, "mt-5")}
                >
                  View active contacts
                </button>
              </>
            ) : (
              <>
                <p className="text-base font-medium text-crm-text">No contacts yet</p>
                <p className="mx-auto mt-2 max-w-md text-sm text-crm-muted">
                  Add a person manually or bring in a file from Import Leads. Records stay in this tenant only.
                </p>
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowAdd(true)}
                    className={cn(crm.btnPrimary, "inline-flex items-center gap-2")}
                  >
                    <Plus className="h-4 w-4" />
                    New contact
                  </button>
                  {canImport && (
                    <Link
                      href="/crm/import"
                      className={cn(crm.btnSecondary, "inline-flex items-center gap-2")}
                    >
                      <FileUp className="h-4 w-4 text-crm-muted" />
                      Import leads
                    </Link>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {!loading && !error && rows.length > 0 && (
          <CRMCard className={cn(crm.contactsPanel, crm.contactsListShell)}>
            {isAdmin && (
              <div className={cn(crm.contactsListSelectBar, "border-crm-border bg-crm-surface-2/40")}>
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
                <span className="text-xs text-crm-muted">{rows.length} on this page</span>
              </div>
            )}
            <ul className="divide-y divide-crm-border/70">
            {rows.map((c) => {
              const archived = isContactArchived(c);
              const hasLastActivity = !!c.lastActivityAt;
              return (
                <li
                  key={c.id}
                  className={cn(
                    crm.contactsListRow,
                    archived ? "bg-crm-bg/40 opacity-85" : "hover:bg-crm-surface-2/35",
                  )}
                >
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-4">
                      {isAdmin && (
                        <div className="flex w-9 shrink-0 items-center justify-center sm:w-10" onClick={(e) => e.stopPropagation()}>
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
                            <span className="inline-block h-4 w-4" aria-hidden />
                          )}
                        </div>
                      )}
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 border-crm-accent/35 bg-gradient-to-br from-crm-accent to-crm-accent/70 text-sm font-bold text-white shadow-crm sm:h-12 sm:w-12">
                        {initials(c.displayName)}
                      </div>
                      <div className="min-w-0 flex-1 space-y-1 py-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="truncate text-lg font-semibold tracking-tight text-crm-text">{c.displayName}</h2>
                          {archived && (
                            <span className="rounded bg-crm-surface-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-crm-text">
                              Archived
                            </span>
                          )}
                          {c.doNotCall && (
                            <span className="rounded bg-crm-danger/15 px-2 py-0.5 text-[10px] font-semibold text-crm-danger">
                              DNC
                            </span>
                          )}
                          {c.crmStage && (
                            <span
                              className={cn(
                                "inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                                STAGE_BADGE_CLASS[c.crmStage],
                              )}
                            >
                              {STAGE_LABELS[c.crmStage]}
                            </span>
                          )}
                        </div>
                        {c.company && <p className="text-sm font-medium text-crm-muted">{c.company}</p>}
                        <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
                          {c.primaryPhone ? (
                            <span className="inline-flex items-center gap-1">
                              <Phone className="h-3.5 w-3.5 shrink-0" aria-hidden />
                              {c.primaryPhone.numberRaw}
                            </span>
                          ) : (
                            <span className="text-crm-warning">No phone</span>
                          )}
                          {c.primaryEmail ? (
                            <span className="inline-flex min-w-0 items-center gap-1">
                              <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden />
                              <span className="truncate">{c.primaryEmail.email}</span>
                            </span>
                          ) : (
                            <span className="text-crm-warning">No email</span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-crm-muted">
                          {hasLastActivity && (
                            <span className="inline-flex items-center gap-1">
                              <Activity className="h-3 w-3" aria-hidden />
                              Last {formatShortDate(c.lastActivityAt)}
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1">
                            <UserRound className="h-3 w-3" aria-hidden />
                            {assignedLabel(c.assignedTo)}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:justify-end lg:shrink-0 lg:pl-2">
                      <Link
                        href={`/crm/contacts/${c.id}`}
                        className={cn(crm.btnPrimary, "min-w-[5.5rem]")}
                      >
                        Open
                        <ExternalLink className="h-3.5 w-3.5 opacity-80" aria-hidden />
                      </Link>
                      {canLiveWorkspace && !archived && (
                        <Link
                          href={`/crm/live-call?contactId=${encodeURIComponent(c.id)}`}
                          className={cn(crm.btnSecondary, "min-w-[6.5rem]")}
                        >
                          <Radio className="h-3.5 w-3.5 text-crm-muted" aria-hidden />
                          Workspace
                        </Link>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          </CRMCard>
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
