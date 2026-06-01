"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Download,
  FileUp,
  HandCoins,
  Mail,
  MapPin,
  MoreHorizontal,
  Plus,
  Search,
  SlidersHorizontal,
  Tag,
  Upload,
  Users,
  X,
} from "lucide-react";
import {
  crm,
  cn,
  CRMPageShell,
  CRMWorkspaceShell,
  CRMWorkspaceChrome,
  CRMWorkspaceHeader,
  CRMWorkspaceToolbar,
  CRMWorkspaceBody,
  CRMWorkspaceMain,
  CRMWorkspaceRightRail,
} from "../../../../components/crm";
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
    name: "", organization: "", website: "", email: "", phone: "", phone2: "",
    address: "", city: "", state: "", zip: "", notes: "", status: "ACTIVE" as FunderStatus,
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
      const enrichedNotes = [
        form.website.trim() ? `Website: ${form.website.trim()}` : "",
        form.address.trim() ? `Address: ${form.address.trim()}` : "",
        form.notes.trim(),
      ].filter(Boolean).join("\n\n");
      const funder = await apiPost<Funder>("/crm/funders", {
        name: form.name.trim(),
        organization: form.organization,
        email: form.email,
        phone: form.phone,
        phone2: form.phone2,
        city: form.city,
        state: form.state,
        zip: form.zip,
        notes: enrichedNotes,
        status: form.status,
        tagIds: selectedTagIds,
      });
      onCreated(funder);
      setForm({ name: "", organization: "", website: "", email: "", phone: "", phone2: "", address: "", city: "", state: "", zip: "", notes: "", status: "ACTIVE" });
      setSelectedTagIds([]);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to create funder");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="funders-modal-backdrop fixed inset-0 z-50 flex items-center justify-center px-3 py-6 sm:px-4" onClick={onClose}>
      <div
        className="funders-modal-panel w-full max-w-2xl overflow-hidden rounded-[1.5rem] border bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-slate-200/80 px-5 py-4 sm:px-6">
          <div>
            <h2 className="text-base font-semibold text-slate-950">Add New Funder</h2>
            <p className="mt-1 text-sm text-slate-500">Create a funding partner profile for grants, referrals, and financial relationships.</p>
          </div>
          <button onClick={onClose} className="rounded-full border border-slate-200 bg-white p-2 text-slate-500 shadow-sm transition hover:bg-slate-50 hover:text-slate-900">
            <X size={16} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="max-h-[calc(100vh-7rem)] overflow-y-auto">
          <div className="space-y-5 px-5 py-5 sm:px-6">
            {err && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{err}</div>
            )}

            <section className="funders-form-section">
              <div>
                <h3>Organization Information</h3>
                <p>Core identity and partner classification.</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="funders-field-label">Funder Name *</label>
                  <input className="funders-field mt-1" value={form.name} onChange={field("name")} placeholder="Enter funder name" />
                </div>
                <div>
                  <label className="funders-field-label">Organization Type</label>
                  <select className="funders-field mt-1" value={form.organization} onChange={field("organization")}>
                    <option value="">Select type</option>
                    <option value="Foundation">Foundation</option>
                    <option value="Grantmaker">Grantmaker</option>
                    <option value="Nonprofit">Nonprofit</option>
                    <option value="Corporation">Corporation</option>
                    <option value="Government">Government</option>
                    <option value="Financial Partner">Financial Partner</option>
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className="funders-field-label">Website</label>
                  <input className="funders-field mt-1" value={form.website} onChange={field("website")} placeholder="https://example.org" />
                </div>
              </div>
            </section>

            <section className="funders-form-section">
              <div>
                <h3>Contact Information</h3>
                <p>Primary outreach details for this funder.</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label className="funders-field-label">Email *</label>
                  <input type="email" className="funders-field mt-1" value={form.email} onChange={field("email")} placeholder="email@example.org" />
                </div>
                <div>
                  <label className="funders-field-label">Primary Phone</label>
                  <input className="funders-field mt-1" value={form.phone} onChange={field("phone")} placeholder="(555) 000-0000" />
                </div>
                <div>
                  <label className="funders-field-label">Secondary Phone</label>
                  <input className="funders-field mt-1" value={form.phone2} onChange={field("phone2")} placeholder="(555) 000-0000" />
                </div>
              </div>
            </section>

            <section className="funders-form-section">
              <div>
                <h3>Location</h3>
                <p>Office or mailing location for records.</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-6">
                <div className="sm:col-span-6">
                  <label className="funders-field-label">Address</label>
                  <input className="funders-field mt-1" value={form.address} onChange={field("address")} placeholder="Street address" />
                </div>
                <div className="sm:col-span-2">
                  <label className="funders-field-label">City</label>
                  <input className="funders-field mt-1" value={form.city} onChange={field("city")} placeholder="City" />
                </div>
                <div className="sm:col-span-2">
                  <label className="funders-field-label">State</label>
                  <input className="funders-field mt-1" value={form.state} onChange={field("state")} placeholder="State" />
                </div>
                <div className="sm:col-span-2">
                  <label className="funders-field-label">ZIP Code</label>
                  <input className="funders-field mt-1" value={form.zip} onChange={field("zip")} placeholder="ZIP code" />
                </div>
              </div>
            </section>

            <section className="funders-form-section">
              <div>
                <h3>Additional Information</h3>
                <p>Status, tags, and notes for internal context.</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="funders-field-label">Status</label>
                  <select className="funders-field mt-1" value={form.status} onChange={field("status")}>
                    {(["ACTIVE", "INACTIVE", "PROSPECT", "PENDING"] as FunderStatus[]).map((s) => (
                      <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                    ))}
                  </select>
                </div>
                {tags.length > 0 && (
                  <div>
                    <label className="funders-field-label">Tags</label>
                    <div className="mt-1 flex min-h-[2.75rem] flex-wrap gap-1.5 rounded-xl border border-slate-200 bg-slate-50/80 p-2">
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
                            "rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors",
                            selectedTagIds.includes(t.id)
                              ? "border-orange-200 bg-orange-50 text-orange-700"
                              : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                          )}
                        >
                          {t.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="sm:col-span-2">
                  <label className="funders-field-label">Notes</label>
                  <textarea
                    className="funders-field mt-1 min-h-[92px] resize-y"
                    value={form.notes}
                    onChange={field("notes")}
                    placeholder="Add notes about this funder..."
                  />
                </div>
              </div>
            </section>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-slate-200/80 bg-slate-50/80 px-5 py-4 sm:px-6">
            <button type="button" onClick={onClose} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={saving} className="rounded-xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-orange-500/25 transition hover:bg-orange-600 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none">
              {saving ? "Saving..." : "Save Funder"}
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
    <div className={crm.contactsModalBackdrop} onClick={onClose}>
      <div className={cn(crm.contactsModalPanel, "max-w-xl w-full max-h-[85vh] overflow-y-auto")} onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-crm-text">Import Funders</h2>
          <button onClick={onClose} className={crm.btnGhost} style={{ padding: "0.375rem" }}><X size={16} /></button>
        </div>
        {err && <div className={cn(crm.bannerDanger, "mb-3 rounded-crm px-3 py-2 text-sm")}>{err}</div>}

        {phase === "upload" && (
          <div className="flex flex-col gap-4">
            <p className={crm.muted}>Upload a CSV, Excel (.xlsx / .xls), or spreadsheet file with funder records. Supported columns: name, organization, email, phone, phone2, city, state, zip, notes, tags.</p>
            <div
              className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-crm-lg border-2 border-dashed border-crm-border bg-crm-surface-2/40 px-6 py-10 transition-colors hover:border-crm-accent/50 hover:bg-crm-surface-2/60"
              onClick={() => fileRef.current?.click()}
            >
              <Upload size={32} className="text-crm-muted" />
              <span className={crm.muted}>{fileName !== "import.csv" ? fileName : "Click to select a file"}</span>
              <span className="text-xs text-crm-border">CSV · Excel (.xlsx, .xls) · ODS spreadsheet</span>
              {csvText && <span className="text-xs text-crm-accent">✓ File loaded — {parseCsvLocally(csvText).length - 1} rows</span>}
            </div>
            <input ref={fileRef} type="file" accept=".csv,text/csv,.xlsx,.xls,.ods,.numbers,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" className="hidden" onChange={handleFile} />
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
  const [typeFilter, setTypeFilter] = useState<string>("all");
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

  const typeOptions = Array.from(
    new Set(funders.map((f) => f.organization).filter((value): value is string => Boolean(value))),
  ).sort((a, b) => a.localeCompare(b));
  const visibleFunders = typeFilter === "all"
    ? funders
    : funders.filter((f) => (f.organization || "Other") === typeFilter);

  const selectAll = () => setSelected(new Set(visibleFunders.map((f) => f.id)));
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

  const totalFunders = stats?.total ?? total;
  const activeFunders = stats?.active ?? 0;
  const prospectFunders = stats?.prospects ?? 0;
  const inactiveFunders = Math.max(totalFunders - activeFunders - prospectFunders, 0);
  const selectedCount = selected.size;
  const topTags = [...tags]
    .map((tag) => ({
      ...tag,
      count: funders.filter((f) => f.tags.some((funderTag) => funderTag.id === tag.id)).length,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const recentActivity = [...funders]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 3);
  const statusBreakdown = (["ACTIVE", "INACTIVE", "PROSPECT"] as FunderStatus[]).map((status) => ({
    status,
    label: STATUS_LABELS[status],
    count: status === "ACTIVE" ? activeFunders : status === "PROSPECT" ? prospectFunders : inactiveFunders,
  }));
  const donutTotal = Math.max(statusBreakdown.reduce((sum, item) => sum + item.count, 0), 1);
  let donutCursor = 0;
  const donutColors: Record<string, string> = {
    ACTIVE: "#10b981",
    INACTIVE: "#cbd5e1",
    PROSPECT: "#f59e0b",
  };
  const donutGradient = statusBreakdown
    .map((item) => {
      const start = donutCursor;
      const end = donutCursor + (item.count / donutTotal) * 100;
      donutCursor = end;
      return `${donutColors[item.status]} ${start}% ${end}%`;
    })
    .join(", ");

  const kpiCards = [
    { label: "Total Funders", value: totalFunders, description: "All funders in your CRM", icon: <Users size={18} />, tone: "violet" },
    { label: "Active", value: activeFunders, description: "Currently active funders", icon: <Activity size={18} />, tone: "emerald" },
    { label: "Inactive", value: inactiveFunders, description: "Not currently active", icon: <BarChart3 size={18} />, tone: "slate" },
    { label: "Prospects", value: prospectFunders, description: "Potential funders", icon: <CircleDollarSign size={18} />, tone: "amber" },
  ];

  return (
    <CRMPageShell className={crm.fundersWorkspace} innerClassName={crm.pageInnerFunders}>
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
      <CRMWorkspaceShell>
        <CRMWorkspaceChrome>
          <CRMWorkspaceHeader>
            <div className="funders-command-header">
              <div>
                <h1>Funders</h1>
                <p>Manage funding sources, grant organizations, and financial partners.</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={() => setShowImport(true)} className="funders-btn funders-btn-secondary">
                  <FileUp size={15} /> Import CSV
                </button>
                <button onClick={handleExport} className="funders-btn funders-btn-secondary">
                  <Download size={15} /> Export CSV
                </button>
                <button onClick={() => setShowNew(true)} className="funders-btn funders-btn-primary">
                  <Plus size={15} /> Add Funder
                </button>
              </div>
            </div>
          </CRMWorkspaceHeader>

          <CRMWorkspaceToolbar className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {kpiCards.map((kpi) => (
                <div
                  key={kpi.label}
                  className={cn("funders-kpi-card", `funders-kpi-${kpi.tone}`)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="funders-kpi-icon">{kpi.icon}</div>
                    <span className="funders-kpi-label">{kpi.label}</span>
                  </div>
                  <div className="funders-kpi-value">
                    {loading ? <span className="animate-pulse opacity-40">—</span> : kpi.value}
                  </div>
                  <p className="funders-kpi-description">{kpi.description}</p>
                </div>
              ))}
            </div>

            <div className="funders-filter-card">
              <div className="funders-filter-grid">
                <div className="relative min-w-0">
                  <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    className="funders-control pl-10"
                    placeholder="Search funders..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <select
                  className="funders-control"
                  value={statusFilter}
                  onChange={(e) => { setStatusFilter(e.target.value as any); setPage(0); }}
                >
                  {(["all", "ACTIVE", "INACTIVE", "PROSPECT", "PENDING"] as const).map((s) => (
                    <option key={s} value={s}>{s === "all" ? "All Status" : STATUS_LABELS[s]}</option>
                  ))}
                </select>
                <select
                  className="funders-control"
                  value={typeFilter}
                  onChange={(e) => { setTypeFilter(e.target.value); setPage(0); }}
                >
                  <option value="all">All Types</option>
                  {typeOptions.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
                <select
                  className="funders-control"
                  value={tagFilter ?? ""}
                  onChange={(e) => { setTagFilter(e.target.value || null); setPage(0); }}
                >
                  <option value="">All Tags</option>
                  {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <button type="button" className="funders-btn funders-btn-filter">
                  <SlidersHorizontal size={15} /> Filters
                </button>
              </div>
            </div>

            {bulkEmailToast && (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
                {bulkEmailToast}
              </div>
            )}

            {selectedCount > 0 && (
              <div className="funders-bulk-toolbar">
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-sm font-semibold text-slate-800">{selectedCount} selected</span>
                  <button onClick={clearSelection} className="rounded-full p-1 text-slate-400 transition hover:bg-white hover:text-slate-700">
                    <X size={14} />
                  </button>
                </div>
                <div className="funders-bulk-actions">
                  <button
                    type="button"
                    onClick={() => setShowBulkEmail(true)}
                    className="funders-bulk-action"
                  >
                    <Mail size={14} /> Send Email
                  </button>
                  <select
                    className="funders-bulk-select"
                    value={bulkTagId}
                    onChange={(e) => setBulkTagId(e.target.value)}
                  >
                    <option value="">Add Tag</option>
                    {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                  <select
                    className="funders-bulk-select"
                    value={bulkAction}
                    onChange={(e) => setBulkAction(e.target.value as any)}
                  >
                    <option value="assign">Assign</option>
                    <option value="remove">Remove</option>
                  </select>
                  <button
                    onClick={handleBulkTag}
                    disabled={!bulkTagId || bulkWorking}
                    className="funders-bulk-action"
                  >
                    <Tag size={14} /> {bulkWorking ? "Working..." : "Apply"}
                  </button>
                  <button
                    onClick={handleExport}
                    className="funders-bulk-action"
                  >
                    <Download size={14} /> Export
                  </button>
                </div>
              </div>
            )}
          </CRMWorkspaceToolbar>
        </CRMWorkspaceChrome>

        <CRMWorkspaceBody split>
          <CRMWorkspaceMain className="flex min-w-0 flex-col gap-3">
            <section className="funders-table-shell min-h-0 flex-1">
              <div className="funders-table-topbar">
                <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                  <input
                    type="checkbox"
                    className="funders-checkbox"
                    checked={visibleFunders.length > 0 && visibleFunders.every((f) => selected.has(f.id))}
                    onChange={() => visibleFunders.length > 0 && visibleFunders.every((f) => selected.has(f.id)) ? clearSelection() : selectAll()}
                    title="Select all visible funders"
                  />
                  {visibleFunders.length} shown
                </label>
                <button type="button" onClick={() => setShowNewTag(true)} className="funders-mini-action">
                  <Plus size={13} /> New Tag
                </button>
              </div>

              <div className="funders-table-scroll">
                <div className="funders-table-head">
                  <span></span>
                  <span>Funder</span>
                  <span>Type</span>
                  <span>Email</span>
                  <span>Phone</span>
                  <span>Status</span>
                  <span>Tags</span>
                  <span>Added</span>
                  <span></span>
                </div>

                {loading ? (
                  <div className="px-5 py-12 text-center text-sm font-medium text-slate-500">Loading funders...</div>
                ) : visibleFunders.length === 0 ? (
                  <div className="m-3 rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 px-6 py-12 text-center">
                    <HandCoins size={34} className="mx-auto mb-3 text-slate-300" />
                    <p className="text-base font-semibold text-slate-900">No funders found</p>
                    <p className="mt-1 text-sm text-slate-500">
                      {search || statusFilter !== "all" || tagFilter || typeFilter !== "all"
                        ? "Try adjusting your filters."
                        : "Add your first funder to get started."}
                    </p>
                    {!search && statusFilter === "all" && !tagFilter && typeFilter === "all" && (
                      <button onClick={() => setShowNew(true)} className="funders-btn funders-btn-primary mx-auto mt-4">
                        <Plus size={14} /> Add Funder
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="funders-table-body">
                    {visibleFunders.map((f) => (
                      <div key={f.id} className="funders-table-row">
                        <div>
                          <input
                            type="checkbox"
                            className="funders-checkbox"
                            checked={selected.has(f.id)}
                            onChange={() => toggleSelect(f.id)}
                          />
                        </div>
                        <Link href={`/crm/funders/${f.id}`} className="funders-funder-cell hover:no-underline">
                          <span className="funders-avatar">{initials(f.name)}</span>
                          <span className="min-w-0">
                            <span className="block truncate font-semibold text-slate-950">{f.name}</span>
                            <span className="mt-0.5 flex items-center gap-1 truncate text-xs text-slate-500">
                              <MapPin size={11} />
                              {[f.city, f.state].filter(Boolean).join(", ") || "Location not set"}
                            </span>
                          </span>
                        </Link>
                        <span className="funders-table-text">{f.organization || "Other"}</span>
                        <span className="funders-table-text truncate">{f.email || "No email"}</span>
                        <span className="funders-table-text">{f.phone || "No phone"}</span>
                        <span>
                          <button
                            type="button"
                            onClick={() => { setStatusFilter(f.status); setPage(0); }}
                            className={cn("funders-status-pill", `funders-status-${f.status.toLowerCase()}`)}
                          >
                            {STATUS_LABELS[f.status]}
                          </button>
                        </span>
                        <span className="flex min-w-0 flex-wrap gap-1">
                          {f.tags.length > 0 ? f.tags.slice(0, 2).map((tag) => (
                            <button
                              type="button"
                              key={tag.id}
                              onClick={() => { setTagFilter(tagFilter === tag.id ? null : tag.id); setPage(0); }}
                              className="funders-tag-pill"
                              style={tag.color ? { borderColor: `${tag.color}40`, color: tag.color, background: `${tag.color}12` } : undefined}
                            >
                              {tag.name}
                            </button>
                          )) : <span className="text-xs text-slate-400">No tags</span>}
                          {f.tags.length > 2 && <span className="funders-tag-pill">+{f.tags.length - 2}</span>}
                        </span>
                        <span className="funders-table-text whitespace-nowrap">{formatShortDate(f.createdAt)}</span>
                        <Link href={`/crm/funders/${f.id}`} className="funders-row-action" aria-label={`Open ${f.name}`}>
                          <MoreHorizontal size={16} />
                        </Link>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            {totalPages > 1 && (
              <div className="funders-pagination">
                <span>
                  Showing {page * PAGE_LIMIT + 1} to {Math.min((page + 1) * PAGE_LIMIT, total)} of {total} funders
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="funders-page-button"
                  >
                    <ChevronLeft size={15} />
                  </button>
                  <span className="px-2 text-sm font-semibold text-slate-700">{page + 1} / {totalPages}</span>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                    className="funders-page-button"
                  >
                    <ChevronRight size={15} />
                  </button>
                </div>
              </div>
            )}
          </CRMWorkspaceMain>

          <CRMWorkspaceRightRail className="funders-rail">
            <section className="funders-rail-card">
              <div className="funders-rail-title">
                <h3>Funder Overview</h3>
              </div>
              <div className="funders-donut-wrap">
                <div
                  className="funders-donut"
                  style={{ background: `conic-gradient(${donutGradient})` }}
                >
                  <span>{totalFunders}</span>
                  <small>Total</small>
                </div>
                <div className="flex flex-1 flex-col gap-2">
                  {statusBreakdown.map((item) => (
                    <button
                      type="button"
                      key={item.status}
                      onClick={() => { setStatusFilter(statusFilter === item.status ? "all" : item.status); setPage(0); }}
                      className="funders-legend-row"
                    >
                      <span className="funders-legend-dot" style={{ background: donutColors[item.status] }} />
                      <span>{item.label}</span>
                      <strong>{item.count}</strong>
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <section className="funders-rail-card">
              <div className="funders-rail-title">
                <h3>Top Tags</h3>
                <button type="button" onClick={() => setShowNewTag(true)}>New</button>
              </div>
              <div className="flex flex-col gap-2">
                {topTags.length === 0 ? (
                  <p className="text-sm text-slate-500">No tags yet.</p>
                ) : topTags.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => { setTagFilter(tagFilter === tag.id ? null : tag.id); setPage(0); }}
                    className="funders-tag-stat"
                  >
                    <span className="funders-legend-dot" style={{ background: tag.color || "#f97316" }} />
                    <span>{tag.name}</span>
                    <strong>{tag.count}</strong>
                  </button>
                ))}
              </div>
            </section>

            <section className="funders-rail-card">
              <div className="funders-rail-title">
                <h3>Recent Activity</h3>
              </div>
              <div className="flex flex-col gap-2">
                {recentActivity.length === 0 ? (
                  <p className="text-sm text-slate-500">No recent funder activity.</p>
                ) : recentActivity.map((funder) => (
                  <Link key={funder.id} href={`/crm/funders/${funder.id}`} className="funders-activity-row hover:no-underline">
                    <span className="funders-activity-avatar">{initials(funder.name)}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-slate-900">{funder.name}</span>
                      <span className="block text-xs text-slate-500">Updated {formatShortDate(funder.updatedAt)}</span>
                    </span>
                  </Link>
                ))}
              </div>
              <Link href="/crm/funders" className="mt-2 inline-flex text-xs font-semibold text-orange-600 hover:text-orange-700">
                View all activity
              </Link>
            </section>

          </CRMWorkspaceRightRail>
        </CRMWorkspaceBody>
      </CRMWorkspaceShell>

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
    </CRMPageShell>
  );
}
