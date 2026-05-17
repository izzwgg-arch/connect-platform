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
} from "lucide-react";
import { CRMPageShell } from "../../../../components/crm";
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-crm border border-crm-border bg-crm-surface p-6 shadow-xl">
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
              className="w-full rounded-lg border border-crm-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-crm-accent/30"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-crm-text">Company</label>
              <input
                value={form.company}
                onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
                placeholder="Optional"
                className="w-full rounded-lg border border-crm-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-crm-accent/30"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-crm-text">Stage</label>
              <select
                value={form.stage}
                onChange={(e) => setForm((f) => ({ ...f, stage: e.target.value as CrmStage }))}
                className="w-full rounded-lg border border-crm-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-crm-accent/30"
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
              className="w-full rounded-lg border border-crm-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-crm-accent/30"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-crm-text">Email</label>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="name@company.com"
              className="w-full rounded-lg border border-crm-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-crm-accent/30"
            />
          </div>

          {error && <p className="text-sm text-crm-danger">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-crm-border px-4 py-2 text-sm font-medium text-crm-text hover:bg-crm-bg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-crm-accent px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
            >
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
    <CRMPageShell>
      {showAdd && <AddContactModal onClose={() => setShowAdd(false)} onCreated={handleContactCreated} />}
        {/* Command header */}
        <div className="mb-6 rounded-crm-lg border border-crm-border bg-crm-surface p-6 shadow-crm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex min-w-0 gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-crm bg-crm-accent/15 text-crm-accent">
                <Users className="h-5 w-5" aria-hidden />
              </div>
              <div className="min-w-0">
                <h1 className="text-2xl font-semibold tracking-tight text-crm-text">Contacts</h1>
                <p className="mt-1 max-w-xl text-sm text-crm-muted">
                  Find people fast, open records, jump to the live workspace when enabled, and bulk-assign when you are
                  admin.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setShowAdd(true)}
                className="inline-flex items-center gap-2 rounded-lg bg-crm-accent px-4 py-2 text-sm font-medium text-white hover:brightness-110"
              >
                <Plus className="h-4 w-4" />
                New contact
              </button>
              {canImport && (
                <Link
                  href="/crm/import"
                  className="inline-flex items-center gap-2 rounded-lg border border-crm-border bg-crm-surface px-3 py-2 text-sm font-medium text-crm-text hover:bg-crm-bg"
                >
                  <FileUp className="h-4 w-4 text-crm-muted" />
                  Import leads
                </Link>
              )}
            </div>
          </div>
        </div>

        {/* Compact operational summary — server total + honest page-scoped counts */}
        {!loading && !error && (rows.length > 0 || total > 0) && (
          <div className="mb-4 rounded-crm-lg border border-crm-border bg-crm-surface px-4 py-3 shadow-crm">
            <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                <span className="font-semibold tabular-nums text-crm-text">{total}</span>
                <span className="text-crm-muted">matching current filters</span>
                <span className="hidden sm:inline text-crm-border" aria-hidden>
                  ·
                </span>
                <span className="text-xs text-crm-muted">
                  Showing{" "}
                  <span className="font-medium tabular-nums text-crm-text">
                    {sliceFrom}–{sliceTo}
                  </span>
                </span>
              </div>
              <dl className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-crm-muted">
                <div className="flex items-center gap-1.5">
                  <dt className="text-crm-muted/80">Active (page)</dt>
                  <dd className="font-semibold tabular-nums text-crm-text">{summary.activeOnPage}</dd>
                </div>
                {isAdmin && (
                  <div className="flex items-center gap-1.5">
                    <dt className="text-crm-muted/80">Archived (page)</dt>
                    <dd className="font-semibold tabular-nums text-crm-text">{summary.archivedOnPage}</dd>
                  </div>
                )}
                <div className="flex items-center gap-1.5">
                  <dt className="text-crm-muted/80">No phone</dt>
                  <dd className="font-semibold tabular-nums text-crm-warning">{summary.missingPhone}</dd>
                </div>
                <div className="flex items-center gap-1.5">
                  <dt className="text-crm-muted/80">No email</dt>
                  <dd className="font-semibold tabular-nums text-crm-warning">{summary.missingEmail}</dd>
                </div>
                <div className="flex items-center gap-1.5 border-l border-crm-border pl-4">
                  <dt className="text-crm-muted/80">Stage</dt>
                  <dd className="font-medium text-crm-text">{stage === "all" ? "All stages" : STAGE_LABELS[stage]}</dd>
                </div>
              </dl>
            </div>
            <p className="mt-2 border-t border-crm-border/60 pt-2 text-[11px] leading-relaxed text-crm-muted">
              Phone, email, and active/archived splits count only contacts on this page. Totals are never blended with
              tenant-wide analytics you have not loaded.
            </p>
          </div>
        )}

        {/* Search + filters — single control surface */}
        <div className="mb-4 rounded-crm-lg border border-crm-border bg-crm-surface p-4 shadow-crm">
          <div className="relative max-w-2xl">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-crm-muted/80" />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="Search by name, phone, email, or company…"
              className="w-full rounded-crm border border-crm-border bg-crm-surface-2/50 py-2.5 pl-10 pr-10 text-sm transition-colors focus:border-crm-accent/40 focus:bg-crm-surface focus:outline-none focus:ring-2 focus:ring-crm-accent/30"
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

          <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center">
            <div className="flex flex-wrap gap-1.5">
              {FILTER_TABS.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => {
                    setPage(0);
                    setStage(tab);
                  }}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                    stage === tab
                      ? "border-blue-600 bg-crm-accent text-white"
                      : "border-crm-border bg-crm-surface text-crm-text hover:bg-crm-bg"
                  }`}
                >
                  {STAGE_LABELS[tab]}
                </button>
              ))}
            </div>

            {isAdmin && (
              <div className="flex flex-wrap items-center gap-1.5 rounded-full bg-crm-bg px-2 py-1">
                <span className="pl-1.5 text-[10px] font-semibold uppercase tracking-wide text-crm-muted/80">List</span>
                {(["active", "archived", "all"] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setPage(0);
                      setArchiveScope(key);
                    }}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
                      archiveScope === key
                        ? "border-crm-accent bg-crm-accent text-white"
                        : "border-transparent bg-crm-surface text-crm-text shadow-crm hover:bg-crm-bg"
                    }`}
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
              className={`rounded-full border px-3 py-1.5 text-xs font-medium lg:ml-auto ${
                assignedToMe
                  ? "border-violet-600 bg-violet-600 text-white"
                  : "border-crm-border bg-crm-surface text-crm-text hover:bg-crm-bg"
              }`}
            >
              Assigned to me
            </button>
          </div>
        </div>

        {/* Bulk bar — compact, not full-width promo */}
        {isAdmin && selectedIds.size > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-crm border border-crm-border bg-crm-surface px-4 py-3 shadow-crm">
            <span className="text-sm font-medium text-crm-text">{selectedIds.size} selected</span>
            <select
              value={bulkAssignUserId}
              onChange={(e) => {
                setBulkAssignUserId(e.target.value);
                void loadCrmUsers();
              }}
              className="rounded-lg border border-crm-border px-2 py-1.5 text-sm"
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
              className="inline-flex items-center gap-1 rounded-lg border border-crm-border bg-crm-bg px-3 py-1.5 text-sm font-medium text-crm-text hover:bg-crm-surface-2 disabled:opacity-50"
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
                className="h-24 animate-pulse rounded-crm-lg border border-crm-border bg-gradient-to-r from-gray-100 via-gray-50 to-gray-100"
              />
            ))}
          </div>
        )}

        {!loading && error && <div className="rounded-crm border border-crm-danger/35 bg-crm-danger/15 px-4 py-3 text-sm text-crm-danger">{error}</div>}

        {!loading && !error && rows.length === 0 && (
          <div className="rounded-crm-lg border border-dashed border-crm-border bg-crm-surface px-6 py-14 text-center">
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
                    className="rounded-lg border border-crm-border bg-crm-surface px-4 py-2 text-sm font-medium text-crm-text hover:bg-crm-bg"
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
                      className="rounded-lg bg-crm-accent px-4 py-2 text-sm font-medium text-white hover:brightness-110"
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
                  className="mt-5 rounded-lg border border-crm-border bg-crm-surface px-4 py-2 text-sm font-medium text-crm-text hover:bg-crm-bg"
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
                    className="inline-flex items-center gap-2 rounded-lg bg-crm-accent px-4 py-2 text-sm font-medium text-white hover:brightness-110"
                  >
                    <Plus className="h-4 w-4" />
                    New contact
                  </button>
                  {canImport && (
                    <Link
                      href="/crm/import"
                      className="inline-flex items-center gap-2 rounded-lg border border-crm-border bg-crm-surface px-4 py-2 text-sm font-medium text-crm-text hover:bg-crm-bg"
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
          <div className="mb-4 flex items-center justify-between gap-2">
            {isAdmin && (
              <label className="flex cursor-pointer items-center gap-2 text-sm text-crm-muted">
                <input
                  type="checkbox"
                  checked={allSelectableSelected}
                  onChange={toggleSelectAll}
                  disabled={selectableRows.length === 0}
                  className="rounded border-crm-border"
                />
                <span>Select active on page</span>
              </label>
            )}
          </div>
        )}

        {!loading && !error && rows.length > 0 && (
          <ul className="space-y-3">
            {rows.map((c) => {
              const archived = isContactArchived(c);
              const hasLastActivity = !!c.lastActivityAt;
              return (
                <li
                  key={c.id}
                  className={`rounded-crm-lg border bg-crm-surface p-4 shadow-crm transition-colors ${
                    archived ? "border-crm-border opacity-80" : "border-crm-border hover:border-crm-border"
                  }`}
                >
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="flex min-w-0 flex-1 gap-3">
                      {isAdmin && (
                        <div className="pt-1" onClick={(e) => e.stopPropagation()}>
                          {archived ? (
                            <span className="inline-block w-4" title="Archived — open record to restore" />
                          ) : (
                            <input
                              type="checkbox"
                              checked={selectedIds.has(c.id)}
                              onChange={() => {
                                toggleSelect(c.id);
                                void loadCrmUsers();
                              }}
                              className="rounded border-crm-border"
                              aria-label={`Select ${c.displayName}`}
                            />
                          )}
                        </div>
                      )}
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-crm-accent text-xs font-bold text-white">
                        {initials(c.displayName)}
                      </div>
                      <div className="min-w-0 flex-1 space-y-1">
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
                        </div>
                        {c.company && <p className="text-sm text-crm-muted">{c.company}</p>}
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-crm-muted">
                          {c.primaryPhone ? (
                            <span className="inline-flex items-center gap-1">
                              <Phone className="h-3.5 w-3.5 shrink-0" aria-hidden />
                              {c.primaryPhone.numberRaw}
                            </span>
                          ) : (
                            <span className="text-amber-700">No phone</span>
                          )}
                          {c.primaryEmail ? (
                            <span className="inline-flex min-w-0 items-center gap-1">
                              <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden />
                              <span className="truncate">{c.primaryEmail.email}</span>
                            </span>
                          ) : (
                            <span className="text-amber-700">No email</span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-crm-muted">
                          {c.crmStage && (
                            <span
                              className={`inline-flex rounded border px-2 py-0.5 text-[11px] font-semibold ${STAGE_BADGE_CLASS[c.crmStage]}`}
                            >
                              {STAGE_LABELS[c.crmStage]}
                            </span>
                          )}
                          {hasLastActivity && (
                            <span className="text-crm-muted">
                              Last activity {formatShortDate(c.lastActivityAt)}
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1.5 text-crm-muted">
                            {hasLastActivity && <span className="text-crm-border" aria-hidden>·</span>}
                            <span className="text-crm-muted/80">Owner</span>
                            <span>{assignedLabel(c.assignedTo)}</span>
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 lg:shrink-0 lg:pl-4">
                      <Link
                        href={`/crm/contacts/${c.id}`}
                        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-crm-border bg-crm-surface px-3 py-2 text-sm font-medium text-crm-text hover:bg-crm-bg"
                      >
                        Open contact
                        <ExternalLink className="h-3.5 w-3.5 text-crm-muted/80" aria-hidden />
                      </Link>
                      {canLiveWorkspace && !archived && (
                        <Link
                          href={`/crm/live-call?contactId=${encodeURIComponent(c.id)}`}
                          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-crm-border bg-crm-surface px-3 py-2 text-sm font-medium text-crm-text hover:bg-crm-bg"
                        >
                          Workspace
                          <Radio className="h-3.5 w-3.5 text-crm-muted/80" aria-hidden />
                        </Link>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {!loading && !error && total > 0 && (canPrev || canNext) && (
          <nav
            className="mt-6 flex flex-col items-stretch gap-3 rounded-crm-lg border border-crm-border bg-crm-surface px-4 py-3 shadow-crm sm:flex-row sm:items-center sm:justify-between"
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
                className="inline-flex items-center gap-1 rounded-lg border border-crm-border bg-crm-surface px-3 py-2 text-sm font-medium text-crm-text hover:bg-crm-bg disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden />
                Previous
              </button>
              <button
                type="button"
                disabled={!canNext}
                onClick={() => setPage((p) => p + 1)}
                className="inline-flex items-center gap-1 rounded-lg border border-crm-border bg-crm-surface px-3 py-2 text-sm font-medium text-crm-text hover:bg-crm-bg disabled:cursor-not-allowed disabled:opacity-40"
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
