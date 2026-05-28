"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  Building2,
  ChevronLeft,
  ChevronRight,
  Clock,
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
  TrendingUp,
  Upload,
  Users,
  X,
} from "lucide-react";
import { CRMCard, crm, cn } from "../../../../components/crm";
import { BulkEmailModal } from "../../../../components/crm/email/BulkEmailModal";
import { apiGet, apiPost } from "../../../../services/apiClient";
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
  all: "All Status",
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  PROSPECT: "Prospect",
  PENDING: "Pending",
};

const STATUS_PILL: Record<FunderStatus, string> = {
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

// ── Funder Overview Donut ─────────────────────────────────────────────────────

function FunderDonut({
  active,
  inactive,
  prospects,
  total,
}: {
  active: number;
  inactive: number;
  prospects: number;
  total: number;
}) {
  if (!total) {
    return (
      <div className="relative flex h-28 w-28 shrink-0 items-center justify-center rounded-full border border-crm-border bg-crm-surface-2">
        <span className="text-xs text-crm-muted">No data</span>
      </div>
    );
  }

  const r = 38;
  const C = 2 * Math.PI * r;
  const segs = [
    { v: active, color: "#16a34a" },
    { v: inactive, color: "#94a3b8" },
    { v: prospects, color: "#f97316" },
  ].filter((s) => s.v > 0);

  let acc = 0;

  return (
    <div className="relative h-28 w-28 shrink-0">
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
        <circle
          cx={50} cy={50} r={r}
          fill="none"
          stroke="currentColor"
          className="text-crm-border"
          strokeWidth={11}
        />
        {segs.map((s, i) => {
          const ratio = s.v / total;
          const dash = C * ratio;
          const offset = C * (1 - acc);
          acc += ratio;
          return (
            <circle
              key={i}
              cx={50} cy={50} r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={11}
              strokeDasharray={`${dash} ${C}`}
              strokeDashoffset={offset}
            />
          );
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold tabular-nums leading-none text-crm-text">{total}</span>
        <span className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-crm-muted">Total</span>
      </div>
    </div>
  );
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
  const [addAnother, setAddAnother] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) return null;

  const field =
    (key: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const resetForm = () => {
    setForm({ name: "", organization: "", email: "", phone: "", phone2: "", city: "", state: "", zip: "", notes: "", status: "ACTIVE" });
    setSelectedTagIds([]);
    setErr(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { setErr("Funder name is required"); return; }
    setSaving(true);
    setErr(null);
    try {
      const funder = await apiPost<Funder>("/crm/funders", {
        ...form,
        name: form.name.trim(),
        tagIds: selectedTagIds,
      });
      onCreated(funder);
      if (addAnother) {
        resetForm();
      } else {
        onClose();
        resetForm();
      }
    } catch (e: any) {
      setErr(e?.message ?? "Failed to create funder");
    } finally {
      setSaving(false);
    }
  };

  const SectionDivider = () => (
    <div className="my-5 border-t" style={{ borderColor: "var(--crm-border)" }} />
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6"
      style={{ background: "rgba(15, 23, 42, 0.55)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        className={cn(crm.contactsModalPanel, "w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl shadow-2xl")}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between border-b px-6 py-4"
          style={{ borderColor: "var(--crm-border)" }}
        >
          <div>
            <h2 className="text-base font-semibold text-crm-text">Add New Funder</h2>
            <p className="mt-0.5 text-xs text-crm-muted">Fill in the details to create a new funder record.</p>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-crm-muted transition-colors hover:bg-crm-surface-2 hover:text-crm-text"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6">
          {err && (
            <div className={cn(crm.bannerDanger, "mb-4 rounded-xl px-4 py-3 text-sm")}>{err}</div>
          )}

          {/* A: Organization Information */}
          <div>
            <p className="mb-3 text-[11px] font-bold uppercase tracking-wider text-crm-muted">Organization Information</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-crm-text">
                  Funder Name <span className="text-crm-danger">*</span>
                </label>
                <input
                  className={crm.input}
                  value={form.name}
                  onChange={field("name")}
                  placeholder="Enter funder name"
                  autoFocus
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-crm-text">Organization Type</label>
                <input
                  className={crm.input}
                  value={form.organization}
                  onChange={field("organization")}
                  placeholder="Foundation, Nonprofit, Corp…"
                />
              </div>
            </div>
            <div className="mt-3">
              <label className="mb-1.5 block text-xs font-medium text-crm-text">Status</label>
              <select className={crm.select} value={form.status} onChange={field("status")}>
                {(["ACTIVE", "INACTIVE", "PROSPECT", "PENDING"] as FunderStatus[]).map((s) => (
                  <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                ))}
              </select>
            </div>
          </div>

          <SectionDivider />

          {/* B: Contact Information */}
          <div>
            <p className="mb-3 text-[11px] font-bold uppercase tracking-wider text-crm-muted">Contact Information</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-crm-text">Email</label>
                <input type="email" className={crm.input} value={form.email} onChange={field("email")} placeholder="email@example.com" />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-crm-text">Primary Phone</label>
                <input className={crm.input} value={form.phone} onChange={field("phone")} placeholder="(555) 000-0000" />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-crm-text">Secondary Phone</label>
                <input className={crm.input} value={form.phone2} onChange={field("phone2")} placeholder="(555) 000-0000" />
              </div>
            </div>
          </div>

          <SectionDivider />

          {/* C: Location */}
          <div>
            <p className="mb-3 text-[11px] font-bold uppercase tracking-wider text-crm-muted">Location</p>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-crm-text">City</label>
                <input className={crm.input} value={form.city} onChange={field("city")} placeholder="City" />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-crm-text">State</label>
                <input className={crm.input} value={form.state} onChange={field("state")} placeholder="State" />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-crm-text">ZIP Code</label>
                <input className={crm.input} value={form.zip} onChange={field("zip")} placeholder="ZIP" />
              </div>
            </div>
          </div>

          <SectionDivider />

          {/* D: Additional Information */}
          <div>
            <p className="mb-3 text-[11px] font-bold uppercase tracking-wider text-crm-muted">Additional Information</p>
            {tags.length > 0 && (
              <div className="mb-3">
                <label className="mb-1.5 block text-xs font-medium text-crm-text">Tags</label>
                <div className="flex flex-wrap gap-1.5">
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
              <label className="mb-1.5 block text-xs font-medium text-crm-text">Notes</label>
              <textarea
                className={cn(crm.input, "min-h-[80px] resize-y")}
                value={form.notes}
                onChange={field("notes")}
                placeholder="Add any notes about this funder…"
              />
            </div>
          </div>

          {/* Footer */}
          <div
            className="mt-5 flex items-center justify-between border-t pt-4"
            style={{ borderColor: "var(--crm-border)" }}
          >
            <label className="flex cursor-pointer items-center gap-2 text-sm text-crm-muted">
              <input
                type="checkbox"
                checked={addAnother}
                onChange={(e) => setAddAnother(e.target.checked)}
                className={crm.checkbox}
              />
              Add another
            </label>
            <div className="flex items-center gap-2">
              <button type="button" onClick={onClose} className={crm.btnSecondary}>Cancel</button>
              <button type="submit" disabled={saving} className={crm.btnPrimary}>
                {saving ? "Saving…" : "Save Funder"}
              </button>
            </div>
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
      onClose();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to create tag");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "rgba(15, 23, 42, 0.55)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        className={cn(crm.contactsModalPanel, "w-full max-w-sm rounded-2xl shadow-2xl")}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between border-b px-5 py-4"
          style={{ borderColor: "var(--crm-border)" }}
        >
          <h2 className="text-base font-semibold text-crm-text">New Tag</h2>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-crm-muted transition-colors hover:bg-crm-surface-2 hover:text-crm-text"
          >
            <X size={16} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 flex flex-col gap-3">
          {err && <div className={cn(crm.bannerDanger, "rounded-xl px-3 py-2 text-sm")}>{err}</div>}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-crm-text">Tag Name</label>
            <input
              className={crm.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Insurance, Medicaid"
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-crm-text">Color</label>
            <input
              type="color"
              className="h-9 w-16 cursor-pointer rounded-lg border border-crm-border bg-crm-surface-2 p-0.5"
              value={color}
              onChange={(e) => setColor(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className={crm.btnSecondary}>Cancel</button>
            <button type="submit" disabled={saving} className={crm.btnPrimary}>
              {saving ? "Creating…" : "Create Tag"}
            </button>
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "rgba(15, 23, 42, 0.55)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        className={cn(crm.contactsModalPanel, "w-full max-w-xl max-h-[85vh] overflow-y-auto rounded-2xl shadow-2xl")}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between border-b px-6 py-4"
          style={{ borderColor: "var(--crm-border)" }}
        >
          <h2 className="text-base font-semibold text-crm-text">Import Funders</h2>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-crm-muted transition-colors hover:bg-crm-surface-2 hover:text-crm-text"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-6">
          {err && <div className={cn(crm.bannerDanger, "mb-4 rounded-xl px-4 py-3 text-sm")}>{err}</div>}

          {phase === "upload" && (
            <div className="flex flex-col gap-4">
              <p className={crm.muted}>
                Upload a CSV, Excel (.xlsx / .xls), or spreadsheet file. Supported columns: name, organization, email, phone, phone2, city, state, zip, notes, tags.
              </p>
              <div
                className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-crm-border bg-crm-surface-2/40 px-6 py-10 transition-colors hover:border-crm-accent/50 hover:bg-crm-surface-2/60"
                onClick={() => fileRef.current?.click()}
              >
                <Upload size={32} className="text-crm-muted" />
                <span className={crm.muted}>{fileName !== "import.csv" ? fileName : "Click to select a file"}</span>
                <span className="text-xs text-crm-muted/60">CSV · Excel (.xlsx, .xls) · ODS</span>
                {csvText && (
                  <span className="text-xs text-crm-accent">✓ File loaded — {parseCsvLocally(csvText).length - 1} rows</span>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv,.xlsx,.xls,.ods,.numbers,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                className="hidden"
                onChange={handleFile}
              />
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
              <div className="rounded-xl border border-crm-border bg-crm-surface-2/40 p-3">
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
                  <div className="overflow-x-auto rounded-xl border border-crm-border">
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
              <div className={cn("rounded-xl border px-4 py-3", result.errorCount === result.totalRows ? crm.bannerDanger : crm.bannerSuccess)}>
                <p className="font-semibold">
                  {result.status === "DONE" ? "Import complete" : result.status === "PARTIAL" ? "Import completed with some errors" : "Import failed"}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  { label: "Created", value: result.createdCount, color: "text-crm-success" },
                  { label: "Updated", value: result.updatedCount, color: "text-crm-accent" },
                  { label: "Skipped", value: result.skippedCount, color: "text-crm-muted" },
                  { label: "Errors", value: result.errorCount, color: "text-crm-danger" },
                ].map((m) => (
                  <div key={m.label} className="rounded-xl border border-crm-border bg-crm-surface-2/40 p-3 text-center">
                    <div className={cn("text-2xl font-bold tabular-nums", m.color)}>{m.value}</div>
                    <div className={crm.muted}>{m.label}</div>
                  </div>
                ))}
              </div>
              {result.errors?.length > 0 && (
                <details className="rounded-xl border border-crm-danger/30 bg-crm-danger/5 p-3">
                  <summary className="cursor-pointer text-sm font-medium text-crm-danger">
                    View {result.errors.length} errors
                  </summary>
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
  const [showBulkEmail, setShowBulkEmail] = useState(false);
  const [bulkEmailToast, setBulkEmailToast] = useState<string | null>(null);

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

  useEffect(() => { fetchFunders(); }, [fetchFunders]);
  useEffect(() => { fetchTags(); }, [fetchTags]);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(0);
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [search]);

  const totalPages = Math.ceil(total / PAGE_LIMIT);
  const inactive = stats ? Math.max(0, stats.total - stats.active - stats.prospects) : 0;

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

  // KPI card definitions
  const kpiCards = [
    {
      label: "Total Funders",
      value: stats?.total ?? 0,
      desc: "All funders in your CRM",
      iconVariant: "contacts-kpi-violet",
      icon: <HandCoins size={18} />,
      valueClass: "text-crm-text",
    },
    {
      label: "Active",
      value: stats?.active ?? 0,
      desc: "Currently active funders",
      iconVariant: "contacts-kpi-green",
      icon: <Users size={18} />,
      valueClass: "text-emerald-600",
    },
    {
      label: "Inactive",
      value: inactive,
      desc: "Not currently active",
      iconVariant: "",
      icon: <Activity size={18} />,
      valueClass: "text-crm-muted",
    },
    {
      label: "Prospects",
      value: stats?.prospects ?? 0,
      desc: "Potential funders",
      iconVariant: "contacts-kpi-amber",
      icon: <TrendingUp size={18} />,
      valueClass: "text-orange-500",
    },
  ];

  // Sidebar: top tags with counts from current funders
  const tagCounts = tags
    .map((t) => ({
      ...t,
      count: funders.filter((f) => f.tags.some((ft) => ft.id === t.id)).length,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  // Sidebar: recent activity (last 4 funders by createdAt)
  const recentFunders = [...funders]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 4);

  return (
    <div
      className={cn(crm.contactsWorkspace)}
      style={{
        "--crm-light-panel": "rgba(255,255,255,0.97)",
        "--crm-light-panel-2": "#f8fafc",
        "--crm-light-border": "rgba(15,23,42,0.11)",
        "--crm-light-border-strong": "rgba(15,23,42,0.18)",
        "--crm-light-text": "#0f172a",
        "--crm-light-muted": "#64748b",
        "--crm-light-accent": "#0284c7",
        "--crm-light-success": "#16a34a",
        "--crm-light-warning": "#d97706",
        "--crm-light-danger": "#dc2626",
      } as React.CSSProperties}
    >
      {/* Bulk Email Modal */}
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

      <div className={crm.pageInnerContacts}>

        {/* ── Page Header ────────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-crm-text">Funders</h1>
            <p className="mt-1 text-sm leading-relaxed text-crm-muted">
              Manage funding sources, grant organizations, and financial partners.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button
              onClick={() => setShowImport(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 active:bg-slate-100"
            >
              <FileUp size={14} />
              Import CSV
            </button>
            <button
              onClick={handleExport}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 active:bg-slate-100"
            >
              <Download size={14} />
              Export CSV
            </button>
            <button
              onClick={() => setShowNew(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-transparent bg-orange-500 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-orange-600 active:bg-orange-700"
            >
              <Plus size={14} />
              Add Funder
            </button>
          </div>
        </div>

        {/* ── KPI Row ────────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {kpiCards.map((kpi) => (
            <div key={kpi.label} className={cn(crm.contactsKpiTile, "border-crm-border")}>
              <div className="flex items-center justify-between">
                <div className={cn(crm.contactsKpiIcon, "h-9 w-9 rounded-xl", kpi.iconVariant)}>
                  {kpi.icon}
                </div>
                <span className="contacts-kpi-label">{kpi.label}</span>
              </div>
              <div className={cn("contacts-kpi-value", kpi.valueClass)}>
                {loading ? <span className="opacity-40">—</span> : kpi.value}
              </div>
              <div className="contacts-kpi-micro">{kpi.desc}</div>
            </div>
          ))}
        </div>

        {/* ── Bulk Email Toast ───────────────────────────────────────────────── */}
        {bulkEmailToast && (
          <div className="rounded-xl border border-crm-success/40 bg-crm-success/10 px-4 py-2.5 text-sm font-medium text-crm-success">
            {bulkEmailToast}
          </div>
        )}

        {/* ── Main Grid ──────────────────────────────────────────────────────── */}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] lg:items-start">

          {/* Left column */}
          <div className="flex min-w-0 flex-col gap-3">

            {/* Filter Bar */}
            <div className={cn(crm.contactsFilterBar, "flex flex-wrap items-center gap-2 rounded-xl border border-crm-border p-3")}>
              <div className="relative min-w-[180px] flex-1">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-crm-muted" />
                <input
                  className={cn(crm.input, "pl-9 py-2 rounded-xl")}
                  placeholder="Search funders…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <select
                className={cn(crm.selectCompact, "rounded-xl")}
                value={statusFilter}
                onChange={(e) => { setStatusFilter(e.target.value as any); setPage(0); }}
              >
                {(["all", "ACTIVE", "INACTIVE", "PROSPECT", "PENDING"] as const).map((s) => (
                  <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                ))}
              </select>
              <select
                className={cn(crm.selectCompact, "rounded-xl")}
                value={tagFilter ?? ""}
                onChange={(e) => { setTagFilter(e.target.value || null); setPage(0); }}
              >
                <option value="">All Tags</option>
                {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <button className={cn(crm.btnSecondary, "rounded-xl gap-1.5")}>
                <Filter size={14} />
                Filters
              </button>
            </div>

            {/* Bulk Action Bar */}
            {selected.size > 0 && (
              <div className={cn(crm.contactsBulkBar, "rounded-xl")}>
                <span className="text-sm font-semibold text-crm-text">{selected.size} selected</span>
                <button onClick={clearSelection} className="flex h-6 w-6 items-center justify-center rounded-md text-crm-muted transition-colors hover:bg-crm-surface-2 hover:text-crm-text">
                  <X size={14} />
                </button>
                <button
                  onClick={() => setShowBulkEmail(true)}
                  className={cn(crm.btnSecondary, "rounded-xl gap-1.5 text-sm")}
                >
                  <Mail size={13} />
                  Send Email
                </button>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <select
                    className={cn(crm.selectCompact, "rounded-xl")}
                    value={bulkTagId}
                    onChange={(e) => setBulkTagId(e.target.value)}
                  >
                    <option value="">Add Tag…</option>
                    {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                  <select
                    className={cn(crm.selectCompact, "rounded-xl")}
                    value={bulkAction}
                    onChange={(e) => setBulkAction(e.target.value as any)}
                  >
                    <option value="assign">Assign tag</option>
                    <option value="remove">Remove tag</option>
                  </select>
                  <button
                    onClick={handleBulkTag}
                    disabled={!bulkTagId || bulkWorking}
                    className={cn(crm.btnSecondary, "rounded-xl")}
                  >
                    {bulkWorking ? "Working…" : "Apply"}
                  </button>
                  <button onClick={handleExport} className={cn(crm.btnSecondary, "rounded-xl gap-1.5")}>
                    <Download size={13} />
                    Export
                  </button>
                </div>
              </div>
            )}

            {/* Funder Table */}
            <CRMCard className={cn(crm.contactsListShell, "rounded-xl")}>
              {/* Select-all bar */}
              <div className={cn(crm.contactsListSelectBar, "rounded-t-xl")}>
                <input
                  type="checkbox"
                  className={crm.checkbox}
                  checked={funders.length > 0 && selected.size === funders.length}
                  onChange={() => selected.size === funders.length ? clearSelection() : selectAll()}
                  title="Select all on this page"
                />
                <span className="text-xs text-crm-muted">{total} funders</span>
              </div>

              {/* Desktop column headers */}
              {funders.length > 0 && (
                <div className="hidden items-center gap-3 border-b border-crm-border/50 bg-crm-surface-2/40 px-4 py-2 lg:flex">
                  <div className="h-4 w-4 shrink-0" />
                  <div className="funders-table-cols min-w-0 flex-1 grid items-center gap-3 text-[10px] font-bold uppercase tracking-wider text-crm-muted">
                    <span>Funder</span>
                    <span>Type</span>
                    <span>Email</span>
                    <span>Phone</span>
                    <span>Status</span>
                    <span>Tags</span>
                    <span>Added</span>
                    <span />
                  </div>
                </div>
              )}

              {loading ? (
                <div className="flex items-center justify-center p-12">
                  <div className="flex flex-col items-center gap-3">
                    <div className="h-8 w-8 animate-spin rounded-full border-2 border-crm-border border-t-crm-accent" />
                    <span className="text-sm text-crm-muted">Loading funders…</span>
                  </div>
                </div>
              ) : funders.length === 0 ? (
                <div className={cn(crm.contactsEmpty, "m-4 rounded-xl")}>
                  <HandCoins size={32} className="mx-auto mb-3 text-crm-muted/50" />
                  <p className={crm.emptyTitle}>No funders found</p>
                  <p className={crm.emptyBody}>
                    {search || statusFilter !== "all" || tagFilter
                      ? "Try adjusting your filters."
                      : "Add your first funder to get started."}
                  </p>
                  {!search && statusFilter === "all" && !tagFilter && (
                    <button onClick={() => setShowNew(true)} className={cn(crm.btnPrimary, "mt-4")}>
                      <Plus size={14} />
                      Add Funder
                    </button>
                  )}
                </div>
              ) : (
                <ul className="divide-y divide-crm-border/50">
                  {funders.map((f) => (
                    <li
                      key={f.id}
                      className={cn(
                        crm.contactsListRow,
                        "flex items-center gap-3 px-4 py-3",
                        selected.has(f.id) && "bg-crm-accent/5"
                      )}
                    >
                      {/* Checkbox */}
                      <input
                        type="checkbox"
                        className={cn(crm.checkbox, "shrink-0")}
                        checked={selected.has(f.id)}
                        onChange={() => toggleSelect(f.id)}
                      />

                      {/* Desktop table row */}
                      <div className="funders-table-cols hidden min-w-0 flex-1 items-center gap-3 lg:grid">
                        {/* Funder column */}
                        <Link href={`/crm/funders/${f.id}`} className="flex min-w-0 items-center gap-2.5 hover:no-underline">
                          <div className="contacts-avatar flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white">
                            {initials(f.name)}
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-crm-text">{f.name}</div>
                            {(f.city || f.state) && (
                              <div className="truncate text-xs text-crm-muted">
                                {[f.city, f.state].filter(Boolean).join(", ")}
                              </div>
                            )}
                          </div>
                        </Link>
                        {/* Type */}
                        <span className="truncate text-sm text-crm-muted">
                          {f.organization || <span className="text-crm-border">—</span>}
                        </span>
                        {/* Email */}
                        <span className="truncate text-sm text-crm-muted">
                          {f.email ? (
                            <a href={`mailto:${f.email}`} className="hover:text-crm-text hover:underline">{f.email}</a>
                          ) : (
                            <span className="text-crm-border">—</span>
                          )}
                        </span>
                        {/* Phone */}
                        <span className="truncate text-sm text-crm-muted">
                          {f.phone || <span className="text-crm-border">—</span>}
                        </span>
                        {/* Status */}
                        <span className={cn("inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold", STATUS_PILL[f.status])}>
                          {STATUS_LABELS[f.status]}
                        </span>
                        {/* Tags */}
                        <div className="flex min-w-0 flex-wrap gap-1">
                          {f.tags.slice(0, 2).map((t) => (
                            <span
                              key={t.id}
                              className="rounded-full border px-2 py-0.5 text-[10px] font-medium"
                              style={t.color ? { borderColor: `${t.color}55`, color: t.color, background: `${t.color}18` } : {}}
                            >
                              {t.name}
                            </span>
                          ))}
                          {f.tags.length > 2 && (
                            <span className="rounded-full border border-crm-border bg-crm-surface-2 px-1.5 py-0.5 text-[10px] text-crm-muted">
                              +{f.tags.length - 2}
                            </span>
                          )}
                        </div>
                        {/* Added */}
                        <span className="shrink-0 text-xs text-crm-muted">{formatShortDate(f.createdAt)}</span>
                        {/* Actions */}
                        <Link
                          href={`/crm/funders/${f.id}`}
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-crm-border text-crm-muted transition-colors hover:border-crm-border/90 hover:text-crm-text"
                        >
                          <MoreHorizontal size={14} />
                        </Link>
                      </div>

                      {/* Mobile card row */}
                      <Link href={`/crm/funders/${f.id}`} className="flex min-w-0 flex-1 items-start gap-3 hover:no-underline lg:hidden">
                        <div className="contacts-avatar flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white">
                          {initials(f.name)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-crm-text">{f.name}</span>
                            <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-semibold", STATUS_PILL[f.status])}>
                              {STATUS_LABELS[f.status]}
                            </span>
                          </div>
                          {f.organization && (
                            <div className="mt-0.5 flex items-center gap-1 text-xs text-crm-muted">
                              <Building2 size={11} />
                              <span>{f.organization}</span>
                            </div>
                          )}
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-crm-muted">
                            {f.email && <span className="flex items-center gap-1"><Mail size={10} />{f.email}</span>}
                            {f.phone && <span className="flex items-center gap-1"><Phone size={10} />{f.phone}</span>}
                          </div>
                          {f.tags.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {f.tags.map((t) => (
                                <span
                                  key={t.id}
                                  className="rounded-full border px-2 py-0.5 text-[10px] font-medium"
                                  style={t.color ? { borderColor: `${t.color}55`, color: t.color, background: `${t.color}18` } : {}}
                                >
                                  {t.name}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="shrink-0 text-xs text-crm-muted">{formatShortDate(f.createdAt)}</div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CRMCard>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className={cn(crm.contactsPagination, "rounded-xl")}>
                <span className={crm.muted}>
                  {page * PAGE_LIMIT + 1}–{Math.min((page + 1) * PAGE_LIMIT, total)} of {total}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className={cn(crm.btnSecondary, "rounded-xl p-1.5")}
                  >
                    <ChevronLeft size={15} />
                  </button>
                  <span className="min-w-[4rem] text-center text-sm text-crm-text">
                    {page + 1} / {totalPages}
                  </span>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                    className={cn(crm.btnSecondary, "rounded-xl p-1.5")}
                  >
                    <ChevronRight size={15} />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* ── Right Sidebar ───────────────────────────────────────────────── */}
          <div className="flex flex-col gap-3">

            {/* Funder Overview */}
            <CRMCard className="rounded-xl p-4">
              <h3 className={cn(crm.label, "mb-4")}>Funder Overview</h3>
              <div className="flex items-center gap-4">
                <FunderDonut
                  active={stats?.active ?? 0}
                  inactive={inactive}
                  prospects={stats?.prospects ?? 0}
                  total={stats?.total ?? 0}
                />
                <div className="flex flex-col gap-2">
                  {[
                    { label: "Active", value: stats?.active ?? 0, color: "#16a34a", pct: stats?.total ? Math.round((stats.active / stats.total) * 100) : 0 },
                    { label: "Inactive", value: inactive, color: "#94a3b8", pct: stats?.total ? Math.round((inactive / stats.total) * 100) : 0 },
                    { label: "Prospects", value: stats?.prospects ?? 0, color: "#f97316", pct: stats?.total ? Math.round((stats.prospects / stats.total) * 100) : 0 },
                  ].map((item) => (
                    <div key={item.label} className="flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: item.color }}
                      />
                      <span className="text-xs text-crm-muted">{item.label}</span>
                      <span className="ml-auto text-xs font-semibold tabular-nums text-crm-text">{item.value}</span>
                      <span className="w-8 text-right text-[10px] text-crm-muted">{item.pct}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </CRMCard>

            {/* Top Tags */}
            <CRMCard className="rounded-xl p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className={crm.label}>Top Tags</h3>
                <button
                  onClick={() => setShowNewTag(true)}
                  className="flex items-center gap-1 text-[11px] font-medium text-crm-accent hover:underline"
                >
                  <Plus size={11} />
                  New
                </button>
              </div>
              {tags.length === 0 ? (
                <p className={crm.muted}>No tags yet.</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {tagCounts.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => { setTagFilter(tagFilter === t.id ? null : t.id); setPage(0); }}
                      className={cn(
                        "flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition-colors",
                        tagFilter === t.id
                          ? "bg-crm-accent/10 text-crm-accent"
                          : "text-crm-text hover:bg-crm-surface-2"
                      )}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={t.color ? { background: t.color } : { background: "var(--crm-accent)" }}
                        />
                        <span className="truncate font-medium">{t.name}</span>
                      </div>
                      <span className="ml-2 shrink-0 font-semibold tabular-nums text-crm-muted">{t.count}</span>
                    </button>
                  ))}
                  {tagFilter && (
                    <button
                      onClick={() => { setTagFilter(null); setPage(0); }}
                      className="mt-1 flex items-center gap-1 text-[11px] text-crm-muted hover:text-crm-text"
                    >
                      <X size={11} /> Clear filter
                    </button>
                  )}
                </div>
              )}
            </CRMCard>

            {/* Recent Activity */}
            <CRMCard className="rounded-xl p-4">
              <h3 className={cn(crm.label, "mb-3")}>Recent Activity</h3>
              {recentFunders.length === 0 ? (
                <p className={crm.muted}>No recent activity.</p>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {recentFunders.map((f) => (
                    <Link
                      key={f.id}
                      href={`/crm/funders/${f.id}`}
                      className="flex items-center gap-2.5 rounded-lg p-1.5 transition-colors hover:bg-crm-surface-2 hover:no-underline"
                    >
                      <div className="contacts-avatar flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white">
                        {initials(f.name)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-semibold text-crm-text">{f.name}</div>
                        <div className="flex items-center gap-1 text-[10px] text-crm-muted">
                          <Clock size={9} />
                          <span>{formatShortDate(f.createdAt)}</span>
                        </div>
                      </div>
                      <span className={cn("shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold", STATUS_PILL[f.status])}>
                        {STATUS_LABELS[f.status]}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </CRMCard>

            {/* Status Breakdown */}
            {stats && (
              <CRMCard className="rounded-xl p-4">
                <h3 className={cn(crm.label, "mb-3")}>Status Breakdown</h3>
                <div className="flex flex-col gap-1.5">
                  {(["ACTIVE", "INACTIVE", "PROSPECT", "PENDING"] as FunderStatus[]).map((s) => {
                    const count = funders.filter((f) => f.status === s).length;
                    return (
                      <button
                        key={s}
                        onClick={() => { setStatusFilter(statusFilter === s ? "all" : s); setPage(0); }}
                        className={cn(
                          "flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition-colors",
                          statusFilter === s
                            ? "bg-crm-accent/10 text-crm-accent"
                            : "text-crm-text hover:bg-crm-surface-2"
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span className={cn(
                            "h-2 w-2 rounded-full",
                            s === "ACTIVE" && "bg-emerald-500",
                            s === "INACTIVE" && "bg-gray-400",
                            s === "PROSPECT" && "bg-blue-500",
                            s === "PENDING" && "bg-amber-500",
                          )} />
                          <span>{STATUS_LABELS[s]}</span>
                        </div>
                        <span className="font-semibold tabular-nums">{count}</span>
                      </button>
                    );
                  })}
                </div>
              </CRMCard>
            )}

            {/* Quick Actions */}
            <CRMCard className="rounded-xl p-4">
              <h3 className={cn(crm.label, "mb-3")}>Quick Actions</h3>
              <div className="flex flex-col gap-2">
                <button onClick={() => setShowNew(true)} className={cn(crm.btnPrimary, "w-full rounded-xl text-sm")}>
                  <Plus size={14} /> Add Funder
                </button>
                <button onClick={() => setShowImport(true)} className={cn(crm.btnSecondary, "w-full rounded-xl text-sm")}>
                  <FileUp size={14} /> Import CSV
                </button>
                <button onClick={handleExport} className={cn(crm.btnSecondary, "w-full rounded-xl text-sm")}>
                  <Download size={14} /> Export CSV
                </button>
              </div>
            </CRMCard>

          </div>
        </div>
      </div>

      {/* ── Modals ───────────────────────────────────────────────────────────── */}
      <NewFunderModal
        open={showNew}
        tags={tags}
        onClose={() => setShowNew(false)}
        onCreated={() => { fetchFunders(); }}
      />
      <NewTagModal
        open={showNewTag}
        onClose={() => setShowNewTag(false)}
        onCreated={(t) => {
          setTags((prev) => [...prev, t].sort((a, b) => a.name.localeCompare(b.name)));
          setShowNewTag(false);
        }}
      />
      <ImportModal open={showImport} onClose={() => setShowImport(false)} onImported={fetchFunders} />
    </div>
  );
}
