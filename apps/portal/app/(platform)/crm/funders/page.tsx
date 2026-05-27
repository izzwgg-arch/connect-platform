"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Building2,
  ChevronLeft,
  ChevronRight,
  Download,
  FileUp,
  Filter,
  HandCoins,
  Mail,
  MoreHorizontal,
  Phone,
  Plus,
  Search,
  Tag,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  CRMPageHeader,
  CRMCard,
  crm,
  cn,
} from "../../../../components/crm";
import { apiGet, apiPost, apiDelete } from "../../../../services/apiClient";
import { useAppContext } from "../../../../hooks/useAppContext";

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

// ── Modal: New Funder ─────────────────────────────────────────────────────────

type NewFunderModalProps = {
  open: boolean;
  tags: FunderTag[];
  onClose: () => void;
  onCreated: (funder: Funder) => void;
};

function NewFunderModal({ open, tags, onClose, onCreated }: NewFunderModalProps) {
  const [form, setForm] = useState({
    name: "", organization: "", email: "", phone: "", phone2: "",
    city: "", state: "", zip: "", notes: "", status: "ACTIVE" as FunderStatus,
  });
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) return null;

  const field = (key: keyof typeof form) => (
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }))
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { setErr("Name is required"); return; }
    setSaving(true);
    setErr(null);
    try {
      const funder = await apiPost<Funder>("/crm/funders", {
        ...form,
        name: form.name.trim(),
        tagIds: selectedTagIds,
      });
      onCreated(funder);
      setForm({ name: "", organization: "", email: "", phone: "", phone2: "", city: "", state: "", zip: "", notes: "", status: "ACTIVE" });
      setSelectedTagIds([]);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to create funder");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={crm.contactsModalBackdrop} onClick={onClose}>
      <div
        className={cn(crm.contactsModalPanel, "max-w-lg w-full max-h-[90vh] overflow-y-auto")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-crm-text">New Funder</h2>
          <button onClick={onClose} className={crm.btnGhost} style={{ padding: "0.375rem" }}>
            <X size={16} />
          </button>
        </div>
        {err && (
          <div className={cn(crm.bannerDanger, "mb-3 rounded-crm px-3 py-2 text-sm")}>{err}</div>
        )}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div>
            <label className={crm.label}>Name *</label>
            <input className={cn(crm.input, "mt-1")} value={form.name} onChange={field("name")} placeholder="Funder name" />
          </div>
          <div>
            <label className={crm.label}>Organization</label>
            <input className={cn(crm.input, "mt-1")} value={form.organization} onChange={field("organization")} placeholder="Company or organization" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={crm.label}>Email</label>
              <input type="email" className={cn(crm.input, "mt-1")} value={form.email} onChange={field("email")} placeholder="email@example.com" />
            </div>
            <div>
              <label className={crm.label}>Status</label>
              <select className={cn(crm.select, "mt-1")} value={form.status} onChange={field("status")}>
                {(["ACTIVE", "INACTIVE", "PROSPECT", "PENDING"] as FunderStatus[]).map((s) => (
                  <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={crm.label}>Phone</label>
              <input className={cn(crm.input, "mt-1")} value={form.phone} onChange={field("phone")} placeholder="Primary phone" />
            </div>
            <div>
              <label className={crm.label}>Phone 2</label>
              <input className={cn(crm.input, "mt-1")} value={form.phone2} onChange={field("phone2")} placeholder="Secondary phone" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-1">
              <label className={crm.label}>City</label>
              <input className={cn(crm.input, "mt-1")} value={form.city} onChange={field("city")} placeholder="City" />
            </div>
            <div>
              <label className={crm.label}>State</label>
              <input className={cn(crm.input, "mt-1")} value={form.state} onChange={field("state")} placeholder="State" />
            </div>
            <div>
              <label className={crm.label}>Zip</label>
              <input className={cn(crm.input, "mt-1")} value={form.zip} onChange={field("zip")} placeholder="Zip" />
            </div>
          </div>
          {tags.length > 0 && (
            <div>
              <label className={crm.label}>Tags</label>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {tags.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() =>
                      setSelectedTagIds((prev) =>
                        prev.includes(t.id) ? prev.filter((id) => id !== t.id) : [...prev, t.id]
                      )
                    }
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                      selectedTagIds.includes(t.id)
                        ? "border-crm-accent/50 bg-crm-accent/15 text-crm-accent"
                        : "border-crm-border bg-crm-surface-2 text-crm-muted hover:border-crm-border/90"
                    )}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <label className={crm.label}>Notes</label>
            <textarea
              className={cn(crm.input, "mt-1 min-h-[80px] resize-y")}
              value={form.notes}
              onChange={field("notes")}
              placeholder="Notes..."
            />
          </div>
          <div className="mt-1 flex justify-end gap-2">
            <button type="button" onClick={onClose} className={crm.btnSecondary}>Cancel</button>
            <button type="submit" disabled={saving} className={crm.btnPrimary}>
              {saving ? "Creating…" : "Create Funder"}
            </button>
          </div>
        </form>
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

// ── Modal: Import CSV ─────────────────────────────────────────────────────────

type ImportModalProps = {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
};

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

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => setCsvText((ev.target?.result as string) ?? "");
    reader.readAsText(file);
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
            <p className={crm.muted}>Upload a CSV file with funder records. Supported columns: name, organization, email, phone, phone2, city, state, zip, notes, tags.</p>
            <div
              className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-crm-lg border-2 border-dashed border-crm-border bg-crm-surface-2/40 px-6 py-10 transition-colors hover:border-crm-accent/50 hover:bg-crm-surface-2/60"
              onClick={() => fileRef.current?.click()}
            >
              <Upload size={32} className="text-crm-muted" />
              <span className={crm.muted}>{fileName !== "import.csv" ? fileName : "Click to select CSV file"}</span>
              {csvText && <span className="text-xs text-crm-accent">✓ File loaded — {parseCsvLocally(csvText).length - 1} rows</span>}
            </div>
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleFile} />
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
  const { can } = useAppContext();
  const canManage = can("can_view_crm_funders");

  const [funders, setFunders] = useState<Funder[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<FunderStatus | "all">("all");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [tags, setTags] = useState<FunderTag[]>([]);
  const [stats, setStats] = useState<FunderStats | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkTagId, setBulkTagId] = useState("");
  const [bulkAction, setBulkAction] = useState<"assign" | "remove">("assign");
  const [bulkWorking, setBulkWorking] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showNewTag, setShowNewTag] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

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

  const totalPages = Math.ceil(total / PAGE_LIMIT);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(funders.map((f) => f.id)));
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

  const handleExport = () => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("q", debouncedSearch);
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (tagFilter) params.set("tagId", tagFilter);
    if (selected.size > 0) params.set("ids", [...selected].join(","));
    window.open(`/api/crm/funders/export?${params.toString()}`, "_blank");
  };

  const kpiCards = [
    { label: "Total Funders", value: stats?.total ?? 0, gradient: "from-violet-500/20 to-indigo-500/10", textColor: "text-violet-600", icon: <HandCoins size={20} /> },
    { label: "Active", value: stats?.active ?? 0, gradient: "from-emerald-500/20 to-teal-500/10", textColor: "text-emerald-600", icon: <HandCoins size={20} /> },
    { label: "Prospects", value: stats?.prospects ?? 0, gradient: "from-blue-500/20 to-cyan-500/10", textColor: "text-blue-600", icon: <HandCoins size={20} /> },
    { label: "Added (7d)", value: stats?.recentlyAdded ?? 0, gradient: "from-amber-500/20 to-orange-500/10", textColor: "text-amber-600", icon: <HandCoins size={20} /> },
  ];

  return (
    <div className={cn(crm.contactsWorkspace)}>
      <div className={crm.pageInnerContacts}>
        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <CRMPageHeader
          title="Funders"
          subtitle="Manage funding sources, referral partners, insurance providers, and funder records"
          icon={<HandCoins size={22} />}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => setShowImport(true)} className={crm.btnSecondary}>
                <FileUp size={14} /> Import CSV
              </button>
              <button onClick={handleExport} className={crm.btnSecondary}>
                <Download size={14} /> Export
              </button>
              <button onClick={() => setShowNewTag(true)} className={crm.btnSecondary}>
                <Tag size={14} /> New Tag
              </button>
              <button onClick={() => setShowNew(true)} className={crm.btnPrimary}>
                <Plus size={14} /> New Funder
              </button>
            </div>
          }
        />

        {/* ── KPI Cards ──────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {kpiCards.map((kpi) => (
            <div
              key={kpi.label}
              className={cn(
                crm.contactsKpiTile,
                `bg-gradient-to-br ${kpi.gradient}`
              )}
            >
              <div className={cn("mb-1 flex items-center gap-1.5", kpi.textColor)}>
                {kpi.icon}
                <span className={crm.label}>{kpi.label}</span>
              </div>
              <div className={cn("text-3xl font-bold tabular-nums", kpi.textColor)}>
                {loading ? <span className="animate-pulse opacity-40">—</span> : kpi.value}
              </div>
            </div>
          ))}
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] lg:items-start">
          <div className="flex flex-col gap-3 min-w-0">
            {/* ── Filter Bar ───────────────────────────────────────────────── */}
            <div className={crm.contactsFilterBar + " flex flex-wrap items-center gap-2 p-3"}>
              <div className="relative flex-1 min-w-[180px]">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-crm-muted" />
                <input
                  className={cn(crm.input, "pl-9 py-2")}
                  placeholder="Search funders…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <select
                className={cn(crm.selectCompact)}
                value={statusFilter}
                onChange={(e) => { setStatusFilter(e.target.value as any); setPage(0); }}
              >
                {(["all", "ACTIVE", "INACTIVE", "PROSPECT", "PENDING"] as const).map((s) => (
                  <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                ))}
              </select>
              <select
                className={crm.selectCompact}
                value={tagFilter ?? ""}
                onChange={(e) => { setTagFilter(e.target.value || null); setPage(0); }}
              >
                <option value="">All tags</option>
                {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>

            {/* ── Bulk Action Bar ───────────────────────────────────────────── */}
            {selected.size > 0 && (
              <div className={crm.contactsBulkBar}>
                <span className="text-sm font-medium text-crm-text">{selected.size} selected</span>
                <button onClick={clearSelection} className={crm.btnGhost} style={{ padding: "0.375rem" }}><X size={14} /></button>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <select
                    className={crm.selectCompact}
                    value={bulkTagId}
                    onChange={(e) => setBulkTagId(e.target.value)}
                  >
                    <option value="">Select tag…</option>
                    {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                  <select
                    className={crm.selectCompact}
                    value={bulkAction}
                    onChange={(e) => setBulkAction(e.target.value as any)}
                  >
                    <option value="assign">Assign tag</option>
                    <option value="remove">Remove tag</option>
                  </select>
                  <button
                    onClick={handleBulkTag}
                    disabled={!bulkTagId || bulkWorking}
                    className={crm.btnSecondary}
                  >
                    {bulkWorking ? "Working…" : "Apply"}
                  </button>
                  <button onClick={handleExport} className={crm.btnSecondary}>
                    <Download size={13} /> Export selected
                  </button>
                </div>
              </div>
            )}

            {/* ── Funder List ───────────────────────────────────────────────── */}
            <CRMCard className={crm.contactsListShell}>
              {/* Select bar */}
              <div className={crm.contactsListSelectBar}>
                <input
                  type="checkbox"
                  className={crm.checkbox}
                  checked={funders.length > 0 && selected.size === funders.length}
                  onChange={() => selected.size === funders.length ? clearSelection() : selectAll()}
                  title="Select all on this page"
                />
                <span className={crm.muted}>{total} funders</span>
              </div>

              {loading ? (
                <div className="p-8 text-center">
                  <div className={crm.muted}>Loading…</div>
                </div>
              ) : funders.length === 0 ? (
                <div className={cn(crm.contactsEmpty, "m-4")}>
                  <HandCoins size={32} className="mx-auto mb-3 text-crm-muted/50" />
                  <p className={crm.emptyTitle}>No funders found</p>
                  <p className={crm.emptyBody}>
                    {search || statusFilter !== "all" || tagFilter
                      ? "Try adjusting your filters."
                      : "Add your first funder to get started."}
                  </p>
                  {!search && statusFilter === "all" && !tagFilter && (
                    <button onClick={() => setShowNew(true)} className={cn(crm.btnPrimary, "mt-4")}>
                      <Plus size={14} /> New Funder
                    </button>
                  )}
                </div>
              ) : (
                <ul className="divide-y divide-crm-border/50">
                  {funders.map((f) => (
                    <li
                      key={f.id}
                      className={cn(crm.contactsListRow, "flex items-start gap-3")}
                    >
                      <input
                        type="checkbox"
                        className={cn(crm.checkbox, "mt-0.5 shrink-0")}
                        checked={selected.has(f.id)}
                        onChange={() => toggleSelect(f.id)}
                      />
                      <Link href={`/crm/funders/${f.id}`} className="flex min-w-0 flex-1 items-start gap-3 hover:no-underline">
                        {/* Avatar */}
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-crm-lg bg-crm-accent/15 text-sm font-bold text-crm-accent">
                          {initials(f.name)}
                        </div>
                        {/* Info */}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-crm-text">{f.name}</span>
                            <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", STATUS_COLORS[f.status])}>
                              {STATUS_LABELS[f.status]}
                            </span>
                          </div>
                          {f.organization && (
                            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-crm-muted">
                              <Building2 size={11} />
                              <span>{f.organization}</span>
                            </div>
                          )}
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-crm-muted">
                            {f.email && (
                              <span className="flex items-center gap-1"><Mail size={11} />{f.email}</span>
                            )}
                            {f.phone && (
                              <span className="flex items-center gap-1"><Phone size={11} />{f.phone}</span>
                            )}
                            {(f.city || f.state) && (
                              <span>{[f.city, f.state].filter(Boolean).join(", ")}</span>
                            )}
                          </div>
                          {f.tags.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {f.tags.map((t) => (
                                <span
                                  key={t.id}
                                  className="rounded-full border px-2 py-0.5 text-xs font-medium"
                                  style={t.color ? { borderColor: `${t.color}55`, color: t.color, background: `${t.color}18` } : {}}
                                >
                                  {t.name}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </Link>
                      <div className="shrink-0 text-xs text-crm-muted">{formatShortDate(f.createdAt)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </CRMCard>

            {/* ── Pagination ────────────────────────────────────────────────── */}
            {totalPages > 1 && (
              <div className={crm.contactsPagination}>
                <span className={crm.muted}>
                  {page * PAGE_LIMIT + 1}–{Math.min((page + 1) * PAGE_LIMIT, total)} of {total}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className={crm.btnSecondary}
                    style={{ padding: "0.375rem" }}
                  >
                    <ChevronLeft size={15} />
                  </button>
                  <span className="text-sm text-crm-text">{page + 1} / {totalPages}</span>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                    className={crm.btnSecondary}
                    style={{ padding: "0.375rem" }}
                  >
                    <ChevronRight size={15} />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* ── Right Rail ─────────────────────────────────────────────────── */}
          <div className="flex flex-col gap-3">
            <CRMCard className="p-4">
              <h3 className={cn(crm.label, "mb-3")}>Funder Tags</h3>
              {tags.length === 0 ? (
                <p className={crm.muted}>No tags yet.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {tags.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => { setTagFilter(tagFilter === t.id ? null : t.id); setPage(0); }}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                        tagFilter === t.id
                          ? "border-crm-accent/50 bg-crm-accent/15 text-crm-accent"
                          : "border-crm-border bg-crm-surface-2 text-crm-muted hover:border-crm-border/80"
                      )}
                      style={t.color && tagFilter !== t.id ? { borderColor: `${t.color}55`, color: t.color } : {}}
                    >
                      {t.name}
                    </button>
                  ))}
                </div>
              )}
              <button onClick={() => setShowNewTag(true)} className={cn(crm.btnGhost, "mt-3 w-full text-xs")}>
                <Plus size={12} /> New Tag
              </button>
            </CRMCard>

            <CRMCard className="p-4">
              <h3 className={cn(crm.label, "mb-3")}>Quick Actions</h3>
              <div className="flex flex-col gap-2">
                <button onClick={() => setShowNew(true)} className={cn(crm.btnPrimary, "w-full text-sm")}>
                  <Plus size={14} /> New Funder
                </button>
                <button onClick={() => setShowImport(true)} className={cn(crm.btnSecondary, "w-full text-sm")}>
                  <FileUp size={14} /> Import CSV
                </button>
                <button onClick={handleExport} className={cn(crm.btnSecondary, "w-full text-sm")}>
                  <Download size={14} /> Export CSV
                </button>
              </div>
            </CRMCard>

            {stats && (
              <CRMCard className="p-4">
                <h3 className={cn(crm.label, "mb-3")}>Status Breakdown</h3>
                <div className="flex flex-col gap-2">
                  {(["ACTIVE", "INACTIVE", "PROSPECT", "PENDING"] as FunderStatus[]).map((s) => {
                    const count = funders.filter((f) => f.status === s).length;
                    return (
                      <button
                        key={s}
                        onClick={() => { setStatusFilter(statusFilter === s ? "all" : s); setPage(0); }}
                        className={cn(
                          "flex items-center justify-between rounded-crm border px-2.5 py-1.5 text-xs transition-colors",
                          statusFilter === s
                            ? "border-crm-accent/40 bg-crm-accent/10 text-crm-accent"
                            : "border-crm-border text-crm-muted hover:border-crm-border/80 hover:text-crm-text"
                        )}
                      >
                        <span>{STATUS_LABELS[s]}</span>
                        <span className={cn("font-bold tabular-nums", STATUS_COLORS[s].split(" ")[2])}>{count}</span>
                      </button>
                    );
                  })}
                </div>
              </CRMCard>
            )}
          </div>
        </div>
      </div>

      {/* ── Modals ───────────────────────────────────────────────────────────── */}
      <NewFunderModal
        open={showNew}
        tags={tags}
        onClose={() => setShowNew(false)}
        onCreated={(f) => { setShowNew(false); fetchFunders(); }}
      />
      <NewTagModal
        open={showNewTag}
        onClose={() => setShowNewTag(false)}
        onCreated={(t) => { setTags((prev) => [...prev, t].sort((a, b) => a.name.localeCompare(b.name))); setShowNewTag(false); }}
      />
      <ImportModal open={showImport} onClose={() => setShowImport(false)} onImported={fetchFunders} />
    </div>
  );
}
