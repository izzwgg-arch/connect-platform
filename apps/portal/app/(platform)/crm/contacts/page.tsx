"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Phone, Mail, Plus, Search, X, UserRound, UserCheck } from "lucide-react";
import { PageHeader } from "../../../../components/PageHeader";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { apiGet, apiPost } from "../../../../services/apiClient";
import { useAppContext } from "../../../../hooks/useAppContext";

// ── Types ─────────────────────────────────────────────────────────────────────

type CrmStage = "LEAD" | "CONTACTED" | "QUALIFIED" | "CUSTOMER" | "CLOSED_LOST";

type AssignedUser = {
  id: string;
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
  /** Phase 16B — present on list when using includeArchived */
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
  all: "All",
  LEAD: "Lead",
  CONTACTED: "Contacted",
  QUALIFIED: "Qualified",
  CUSTOMER: "Customer",
  CLOSED_LOST: "Closed Lost",
};

const STAGE_COLORS: Record<CrmStage, string> = {
  LEAD: "#6366f1",
  CONTACTED: "#f59e0b",
  QUALIFIED: "#10b981",
  CUSTOMER: "#3b82f6",
  CLOSED_LOST: "#6b7280",
};

const FILTER_TABS = ["all", "LEAD", "CONTACTED", "QUALIFIED", "CUSTOMER", "CLOSED_LOST"] as const;

/** Phase 16B — admin-only CRM list scope (server-backed; agents always behave as active). */
type ArchiveListScope = "active" | "archived" | "all";

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
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function assignedLabel(u: AssignedUser | null | undefined): string {
  if (!u) return "—";
  return u.displayName || `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.email;
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

  useEffect(() => { firstRef.current?.focus(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.displayName.trim()) { setError("Name is required"); return; }
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
    } catch (err: any) {
      setError(err?.message || "Failed to create contact");
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 999,
        background: "rgba(0,0,0,0.55)", backdropFilter: "blur(2px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: "1rem",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "0.75rem",
          padding: "1.5rem",
          width: "100%",
          maxWidth: 480,
          display: "flex",
          flexDirection: "column",
          gap: "1.125rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 700 }}>Add CRM Contact</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: "0.25rem" }}>
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>
          <div>
            <label style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, marginBottom: "0.3rem" }}>
              Name *
            </label>
            <input
              ref={firstRef}
              value={form.displayName}
              onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
              placeholder="Full name"
              style={inputStyle}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div>
              <label style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, marginBottom: "0.3rem" }}>
                Company
              </label>
              <input
                value={form.company}
                onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
                placeholder="Company name"
                style={inputStyle}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, marginBottom: "0.3rem" }}>
                Stage
              </label>
              <select
                value={form.stage}
                onChange={(e) => setForm((f) => ({ ...f, stage: e.target.value as CrmStage }))}
                style={inputStyle}
              >
                {(Object.keys(STAGE_LABELS) as Array<CrmStage | "all">)
                  .filter((k) => k !== "all")
                  .map((k) => (
                    <option key={k} value={k}>{STAGE_LABELS[k]}</option>
                  ))}
              </select>
            </div>
          </div>

          <div>
            <label style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, marginBottom: "0.3rem" }}>
              Phone
            </label>
            <input
              type="tel"
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              placeholder="+1 555 000 0000"
              style={inputStyle}
            />
          </div>

          <div>
            <label style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, marginBottom: "0.3rem" }}>
              Email
            </label>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="name@company.com"
              style={inputStyle}
            />
          </div>

          {error && (
            <p style={{ margin: 0, fontSize: "0.8125rem", color: "#ef4444" }}>{error}</p>
          )}

          <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end", paddingTop: "0.25rem" }}>
            <button
              type="button"
              onClick={onClose}
              style={{ ...btnBase, background: "var(--surface-hover)", color: "var(--text)" }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              style={{ ...btnBase, background: "var(--accent)", color: "#fff", opacity: saving ? 0.7 : 1 }}
            >
              {saving ? "Adding…" : "Add Contact"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.4375rem 0.625rem",
  border: "1px solid var(--border)",
  borderRadius: "0.375rem",
  background: "var(--surface-hover)",
  color: "var(--text)",
  fontSize: "0.875rem",
  boxSizing: "border-box",
};

const btnBase: React.CSSProperties = {
  padding: "0.4375rem 1rem",
  border: "none",
  borderRadius: "0.5rem",
  fontSize: "0.875rem",
  fontWeight: 600,
  cursor: "pointer",
  transition: "opacity 0.15s",
};

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CrmContactsPage() {
  const router = useRouter();
  const { backendJwtRole } = useAppContext();
  const isAdmin =
    backendJwtRole === "ADMIN" ||
    backendJwtRole === "TENANT_ADMIN" ||
    backendJwtRole === "SUPER_ADMIN";

  const [rows, setRows] = useState<CrmContact[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [stage, setStage] = useState<CrmStage | "all">("all");
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [archiveScope, setArchiveScope] = useState<ArchiveListScope>("active");
  const [showAdd, setShowAdd] = useState(false);

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [crmUsers, setCrmUsers] = useState<CrmUser[]>([]);
  const [bulkAssignUserId, setBulkAssignUserId] = useState<string>("");
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (q: string, s: CrmStage | "all", mine: boolean, scope: ArchiveListScope) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (q) params.set("q", q);
        if (s !== "all") params.set("stage", s);
        if (mine) params.set("assignedToMe", "true");
        params.set("limit", "50");
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
      } catch (err: any) {
        setError(err?.message || "Failed to load contacts");
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
    load(search, stage, assignedToMe, isAdmin ? archiveScope : "active");
  }, [stage, assignedToMe, archiveScope, load, isAdmin]);

  useEffect(() => {
    setSelectedIds(new Set());
    setBulkAssignUserId("");
    setBulkError(null);
  }, [archiveScope]);

  const handleSearchChange = (val: string) => {
    setSearch(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(
      () => load(val, stage, assignedToMe, isAdmin ? archiveScope : "active"),
      320,
    );
  };

  const handleContactCreated = (c: CrmContact) => {
    setRows((prev) => [c, ...prev]);
    setTotal((t) => t + 1);
  };

  const loadCrmUsers = useCallback(async () => {
    if (crmUsers.length > 0) return; // loaded already
    try {
      const data = await apiGet<{ users: CrmUser[] }>("/crm/users");
      setCrmUsers(data.users ?? []);
    } catch {
      // Non-fatal — dropdown will just be empty
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
      // Optimistically update displayed rows
      const assignee = assignUserId ? crmUsers.find((u) => u.userId === assignUserId) ?? null : null;
      setRows((prev) =>
        prev.map((r) =>
          selectedIds.has(r.id)
            ? {
                ...r,
                assignedTo: assignee
                  ? { id: assignee.userId, displayName: assignee.displayName, email: assignee.email }
                  : null,
              }
            : r,
        ),
      );
      clearSelection();
    } catch (e: any) {
      setBulkError(e?.message || "Bulk reassign failed");
    } finally {
      setBulkAssigning(false);
    }
  };

  const selectableRows = useMemo(() => rows.filter((r) => !isContactArchived(r)), [rows]);
  const allSelectableSelected =
    selectableRows.length > 0 && selectableRows.every((r) => selectedIds.has(r.id));

  const hasListFilters =
    !!search || stage !== "all" || assignedToMe || (isAdmin && archiveScope !== "active");

  return (
    <div className="stack compact-stack">
      <PageHeader
        title="Contacts"
        subtitle={`${total} CRM contact${total !== 1 ? "s" : ""}`}
        actions={
          <button
            onClick={() => setShowAdd(true)}
            style={{ ...btnBase, background: "var(--accent)", color: "#fff", display: "flex", alignItems: "center", gap: "0.375rem" }}
          >
            <Plus size={15} />
            Add Contact
          </button>
        }
      />

      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
        {/* Search */}
        <div style={{ position: "relative", flex: "1 1 240px", maxWidth: 340 }}>
          <Search
            size={14}
            style={{ position: "absolute", left: "0.625rem", top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)", pointerEvents: "none" }}
          />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search by name, phone, email…"
            style={{ ...inputStyle, paddingLeft: "2rem" }}
          />
          {search && (
            <button
              onClick={() => {
                setSearch("");
                load("", stage, assignedToMe, isAdmin ? archiveScope : "active");
              }}
              style={{ position: "absolute", right: "0.5rem", top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: 0, display: "flex" }}
            >
              <X size={13} />
            </button>
          )}
        </div>

        {/* Stage filter tabs */}
        <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
          {FILTER_TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setStage(tab)}
              style={{
                padding: "0.3125rem 0.75rem",
                border: "1px solid var(--border)",
                borderRadius: "2rem",
                fontSize: "0.8125rem",
                fontWeight: stage === tab ? 700 : 400,
                cursor: "pointer",
                background: stage === tab ? "var(--accent)" : "var(--surface-hover)",
                color: stage === tab ? "#fff" : "var(--text)",
                transition: "all 0.12s",
              }}
            >
              {STAGE_LABELS[tab]}
            </button>
          ))}
        </div>

        {/* Phase 16B — admin-only active / archived / all (real API includeArchived / archivedOnly) */}
        {isAdmin && (
          <div style={{ display: "flex", alignItems: "center", gap: "0.35rem", flexWrap: "wrap" }}>
            <span
              style={{
                fontSize: "0.6875rem",
                fontWeight: 700,
                color: "var(--text-dim)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                marginRight: "0.15rem",
              }}
            >
              List
            </span>
            {(["active", "archived", "all"] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setArchiveScope(key)}
                style={{
                  padding: "0.3125rem 0.75rem",
                  border: "1px solid var(--border)",
                  borderRadius: "2rem",
                  fontSize: "0.8125rem",
                  fontWeight: archiveScope === key ? 700 : 400,
                  cursor: "pointer",
                  background: archiveScope === key ? "var(--accent)" : "var(--surface-hover)",
                  color: archiveScope === key ? "#fff" : "var(--text)",
                  transition: "all 0.12s",
                  whiteSpace: "nowrap",
                }}
              >
                {ARCHIVE_SCOPE_LABELS[key]}
              </button>
            ))}
          </div>
        )}

        {/* Assigned to me toggle */}
        <button
          onClick={() => setAssignedToMe((v) => !v)}
          style={{
            padding: "0.3125rem 0.75rem",
            border: "1px solid var(--border)",
            borderRadius: "2rem",
            fontSize: "0.8125rem",
            fontWeight: assignedToMe ? 700 : 400,
            cursor: "pointer",
            background: assignedToMe ? "var(--accent)" : "var(--surface-hover)",
            color: assignedToMe ? "#fff" : "var(--text)",
            transition: "all 0.12s",
            whiteSpace: "nowrap",
          }}
        >
          Assigned to me
        </button>
      </div>

      {/* ── Bulk action bar ──────────────────────────────────────────────────── */}
      {isAdmin && selectedIds.size > 0 && (
        <div style={{
          display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap",
          padding: "0.625rem 1rem",
          background: "var(--accent)", borderRadius: "0.5rem",
          color: "#fff",
        }}>
          <span style={{ fontWeight: 700, fontSize: "0.875rem" }}>
            {selectedIds.size} selected
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flex: 1, flexWrap: "wrap" }}>
            <select
              value={bulkAssignUserId}
              onChange={(e) => setBulkAssignUserId(e.target.value)}
              style={{
                padding: "0.3125rem 0.625rem", borderRadius: "0.375rem",
                border: "1px solid rgba(255,255,255,0.4)", background: "rgba(255,255,255,0.15)",
                color: "#fff", fontSize: "0.8125rem", minWidth: 160,
              }}
            >
              <option value="">Assign to…</option>
              {crmUsers.map((u) => (
                <option key={u.userId} value={u.userId}>{u.displayName}</option>
              ))}
            </select>
            <button
              onClick={() => handleBulkReassign(bulkAssignUserId || null)}
              disabled={bulkAssigning || !bulkAssignUserId}
              style={{
                padding: "0.3125rem 0.75rem", borderRadius: "0.375rem",
                border: "1px solid rgba(255,255,255,0.5)", background: "rgba(255,255,255,0.2)",
                color: "#fff", fontSize: "0.8125rem", fontWeight: 600, cursor: "pointer",
                display: "flex", alignItems: "center", gap: "0.25rem",
                opacity: (!bulkAssignUserId || bulkAssigning) ? 0.5 : 1,
              }}
            >
              <UserCheck size={13} /> {bulkAssigning ? "Assigning…" : "Assign"}
            </button>
            <button
              onClick={() => handleBulkReassign(null)}
              disabled={bulkAssigning}
              style={{
                padding: "0.3125rem 0.75rem", borderRadius: "0.375rem",
                border: "1px solid rgba(255,255,255,0.4)", background: "transparent",
                color: "#fff", fontSize: "0.8125rem", cursor: "pointer",
                opacity: bulkAssigning ? 0.5 : 1,
              }}
            >
              Clear assignment
            </button>
            {bulkError && (
              <span style={{ fontSize: "0.8125rem", color: "#fca5a5" }}>{bulkError}</span>
            )}
          </div>
          <button
            onClick={clearSelection}
            style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.7)", padding: "0.2rem", lineHeight: 1 }}
            title="Clear selection"
          >
            <X size={15} />
          </button>
        </div>
      )}

      {/* ── Table ────────────────────────────────────────────────────────────── */}
      <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
        {loading && (
          <div style={{ padding: "1rem 1.25rem" }}>
            <LoadingSkeleton rows={6} />
          </div>
        )}

        {!loading && error && (
          <div style={{ padding: "1.5rem", color: "#ef4444", fontSize: "0.875rem" }}>{error}</div>
        )}

        {!loading && !error && rows.length === 0 && (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <UserRound size={32} style={{ color: "var(--text-dim)", margin: "0 auto 0.75rem" }} />
            <h4 style={{ margin: "0 0 0.375rem", fontWeight: 600, fontSize: "1rem" }}>No contacts found</h4>
            <p style={{ margin: "0 0 1rem", color: "var(--text-dim)", fontSize: "0.875rem" }}>
              {hasListFilters
                ? "Try clearing your filters."
                : isAdmin && archiveScope === "archived"
                  ? "No archived contacts."
                  : "Import leads or add a contact to get started."}
            </p>
            {!search && stage === "all" && !assignedToMe && !(isAdmin && archiveScope === "archived") && (
              <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center", flexWrap: "wrap" }}>
                <button
                  onClick={() => setShowAdd(true)}
                  style={{ padding: "0.4375rem 1rem", border: "none", borderRadius: "0.5rem", background: "var(--accent)", color: "#fff", fontSize: "0.875rem", fontWeight: 600, cursor: "pointer" }}
                >
                  Add Contact
                </button>
                <a
                  href="/crm/import"
                  style={{ padding: "0.4375rem 1rem", borderRadius: "0.5rem", background: "transparent", color: "var(--accent, #6366f1)", border: "1px solid var(--accent, #6366f1)", fontSize: "0.875rem", fontWeight: 600, cursor: "pointer", textDecoration: "none" }}
                >
                  Import Leads
                </a>
              </div>
            )}
          </div>
        )}

        {!loading && !error && rows.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
              <thead>
                <tr style={{ background: "var(--surface-hover)" }}>
                  {isAdmin && (
                    <th style={{ padding: "0.5rem 0.75rem", width: 32 }}>
                      <input
                        type="checkbox"
                        checked={allSelectableSelected}
                        onChange={toggleSelectAll}
                        disabled={selectableRows.length === 0}
                        style={{ cursor: selectableRows.length === 0 ? "not-allowed" : "pointer" }}
                        title="Select all active (non-archived) contacts on this page"
                      />
                    </th>
                  )}
                  {["Contact", "Phone", "Email", "Stage", "Assigned To", ""].map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: "0.5rem 1rem",
                        textAlign: "left",
                        fontWeight: 600,
                        fontSize: "0.75rem",
                        color: "var(--text-dim)",
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((c, idx) => {
                  const archived = isContactArchived(c);
                  return (
                  <tr
                    key={c.id}
                    onClick={(e) => {
                      // Don't navigate if clicking the checkbox cell
                      if ((e.target as HTMLElement).tagName === "INPUT") return;
                      router.push(`/crm/contacts/${c.id}`);
                    }}
                    style={{
                      borderTop: idx === 0 ? undefined : "1px solid var(--border)",
                      cursor: "pointer",
                      transition: "background 0.1s, opacity 0.1s",
                      opacity: archived ? 0.88 : 1,
                      background: selectedIds.has(c.id) ? "var(--accent-muted, #eef2ff)" : archived ? "var(--surface-hover)" : undefined,
                    }}
                    onMouseEnter={(e) => {
                      if (!selectedIds.has(c.id)) {
                        (e.currentTarget as HTMLElement).style.background = archived ? "var(--border)" : "var(--surface-hover)";
                      }
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.background = selectedIds.has(c.id)
                        ? "var(--accent-muted, #eef2ff)"
                        : archived
                          ? "var(--surface-hover)"
                          : "";
                    }}
                  >
                  {isAdmin && (
                    <td style={{ padding: "0.625rem 0.75rem", width: 32 }} onClick={(e) => e.stopPropagation()}>
                      {archived ? (
                        <span style={{ display: "inline-block", width: 14 }} title="Archived — use detail to restore" />
                      ) : (
                      <input
                        type="checkbox"
                        checked={selectedIds.has(c.id)}
                        onChange={() => {
                          toggleSelect(c.id);
                          loadCrmUsers();
                        }}
                        style={{ cursor: "pointer" }}
                      />
                      )}
                    </td>
                  )}
                    {/* Contact name + avatar */}
                    <td style={{ padding: "0.625rem 1rem", whiteSpace: "nowrap" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.625rem" }}>
                        <div style={{
                          width: 30,
                          height: 30,
                          borderRadius: "50%",
                          background: "var(--accent)",
                          color: "#fff",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: "0.6875rem",
                          fontWeight: 700,
                          flexShrink: 0,
                        }}>
                          {initials(c.displayName)}
                        </div>
                        <div>
                          <div style={{ fontWeight: 600, lineHeight: 1.3 }}>{c.displayName}</div>
                          {c.company && (
                            <div style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>{c.company}</div>
                          )}
                        </div>
                        {c.doNotCall && (
                          <span
                            title="Do Not Call"
                            style={{ fontSize: "0.6875rem", padding: "0.1rem 0.375rem", borderRadius: 3, background: "#ef444420", color: "#ef4444", fontWeight: 700 }}
                          >
                            DNC
                          </span>
                        )}
                        {archived && (
                          <span
                            title="Archived — hidden from active lists"
                            style={{
                              fontSize: "0.6875rem",
                              padding: "0.1rem 0.375rem",
                              borderRadius: 3,
                              background: "#e5e7eb",
                              color: "#374151",
                              fontWeight: 700,
                              textTransform: "uppercase",
                              letterSpacing: "0.03em",
                            }}
                          >
                            Archived
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Phone */}
                    <td style={{ padding: "0.625rem 1rem", color: "var(--text-dim)" }}>
                      {c.primaryPhone ? (
                        <span style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}>
                          <Phone size={12} />
                          {c.primaryPhone.numberRaw}
                        </span>
                      ) : "—"}
                    </td>

                    {/* Email */}
                    <td style={{ padding: "0.625rem 1rem", color: "var(--text-dim)" }}>
                      {c.primaryEmail ? (
                        <span style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}>
                          <Mail size={12} />
                          {c.primaryEmail.email}
                        </span>
                      ) : "—"}
                    </td>

                    {/* Stage */}
                    <td style={{ padding: "0.625rem 1rem" }}>
                      {c.crmStage ? (
                        <span style={{
                          padding: "0.15rem 0.5rem",
                          borderRadius: 3,
                          fontSize: "0.75rem",
                          fontWeight: 700,
                          background: `${STAGE_COLORS[c.crmStage]}20`,
                          color: STAGE_COLORS[c.crmStage],
                        }}>
                          {STAGE_LABELS[c.crmStage]}
                        </span>
                      ) : "—"}
                    </td>

                    {/* Assigned to */}
                    <td style={{ padding: "0.625rem 1rem", color: "var(--text-dim)", fontSize: "0.8125rem" }}>
                      {assignedLabel(c.assignedTo)}
                    </td>

                    {/* Row action */}
                    <td style={{ padding: "0.625rem 1rem", textAlign: "right" }}>
                      <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>View →</span>
                    </td>
                  </tr>
                );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add contact modal */}
      {showAdd && (
        <AddContactModal
          onClose={() => setShowAdd(false)}
          onCreated={handleContactCreated}
        />
      )}
    </div>
  );
}
