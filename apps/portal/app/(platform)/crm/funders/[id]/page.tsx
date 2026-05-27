"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Building2,
  ChevronDown,
  HandCoins,
  Mail,
  MoreHorizontal,
  Phone,
  Plus,
  Save,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import {
  CRMCard,
  crm,
  cn,
} from "../../../../../components/crm";
import { apiGet, apiPost, apiDelete } from "../../../../../services/apiClient";

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

// ── Constants ──────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<FunderStatus, string> = {
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
  return name.split(" ").map((p) => p[0]).filter(Boolean).join("").slice(0, 2).toUpperCase();
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch { return "—"; }
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FunderDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;

  const [funder, setFunder] = useState<Funder | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [allTags, setAllTags] = useState<FunderTag[]>([]);

  // Edit mode state
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Funder & { tagIds: string[] }>>({});
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // Tag assign panel
  const [showTagPanel, setShowTagPanel] = useState(false);
  const [tagWorking, setTagWorking] = useState(false);

  // Archive / delete
  const [confirming, setConfirming] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const fetchFunder = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<Funder>(`/crm/funders/${id}`);
      setFunder(data);
    } catch (e: any) {
      if (e?.status === 404 || e?.message?.includes("404")) setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  const fetchAllTags = useCallback(async () => {
    try {
      const data = await apiGet<{ tags: FunderTag[] }>("/crm/funder-tags");
      setAllTags(data.tags);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchFunder(); fetchAllTags(); }, [fetchFunder, fetchAllTags]);

  const startEdit = () => {
    if (!funder) return;
    setForm({
      name: funder.name,
      organization: funder.organization ?? "",
      email: funder.email ?? "",
      phone: funder.phone ?? "",
      phone2: funder.phone2 ?? "",
      city: funder.city ?? "",
      state: funder.state ?? "",
      zip: funder.zip ?? "",
      notes: funder.notes ?? "",
      status: funder.status,
    });
    setSaveErr(null);
    setEditing(true);
  };

  const handleSave = async () => {
    if (!form.name?.trim()) { setSaveErr("Name is required"); return; }
    setSaving(true); setSaveErr(null);
    try {
      const patch: Record<string, unknown> = {};
      if (form.name !== undefined) patch.name = form.name.trim();
      if ("organization" in form) patch.organization = form.organization || null;
      if ("email" in form) patch.email = form.email || null;
      if ("phone" in form) patch.phone = form.phone || null;
      if ("phone2" in form) patch.phone2 = form.phone2 || null;
      if ("city" in form) patch.city = form.city || null;
      if ("state" in form) patch.state = form.state || null;
      if ("zip" in form) patch.zip = form.zip || null;
      if ("notes" in form) patch.notes = form.notes || null;
      if (form.status) patch.status = form.status;

      const updated = await apiPost<Funder>(`/crm/funders/${id}`, patch as any);
      setFunder(updated);
      setEditing(false);
    } catch (e: any) {
      setSaveErr(e?.message ?? "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleTagAssign = async (tagId: string, action: "assign" | "remove") => {
    if (!funder) return;
    setTagWorking(true);
    try {
      if (action === "assign") {
        await apiPost(`/crm/funders/${id}/tags`, { tagId });
      } else {
        await apiDelete(`/crm/funders/${id}/tags/${tagId}`);
      }
      await fetchFunder();
    } catch { /* ignore */ } finally {
      setTagWorking(false);
    }
  };

  const handleArchive = async () => {
    setArchiving(true);
    try {
      await apiDelete(`/crm/funders/${id}`);
      router.push("/crm/funders");
    } catch { /* ignore */ } finally {
      setArchiving(false); setConfirming(false);
    }
  };

  if (loading) {
    return (
      <div className={crm.contactsWorkspace}>
        <div className={crm.pageInnerContact + " p-8 text-center"}>
          <span className={crm.muted}>Loading…</span>
        </div>
      </div>
    );
  }

  if (notFound || !funder) {
    return (
      <div className={crm.contactsWorkspace}>
        <div className={cn(crm.pageInnerContact, "p-8 text-center")}>
          <p className={crm.emptyTitle}>Funder not found</p>
          <Link href="/crm/funders" className={cn(crm.btnSecondary, "mt-4 inline-flex")}>
            <ArrowLeft size={14} /> Back to Funders
          </Link>
        </div>
      </div>
    );
  }

  const assignedTagIds = new Set(funder.tags.map((t) => t.id));

  const fieldEl = (
    label: string,
    key: keyof typeof form,
    opts?: { type?: string; multiline?: boolean }
  ) => {
    const val = (form[key] as string) ?? "";
    return (
      <div>
        <label className={crm.label}>{label}</label>
        {opts?.multiline ? (
          <textarea
            className={cn(crm.input, "mt-1 min-h-[80px] resize-y")}
            value={val}
            onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
          />
        ) : (
          <input
            type={opts?.type ?? "text"}
            className={cn(crm.input, "mt-1")}
            value={val}
            onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
          />
        )}
      </div>
    );
  };

  return (
    <div className={crm.contactsWorkspace}>
      <div className={crm.pageInnerContact}>
        {/* Back nav */}
        <div>
          <Link href="/crm/funders" className={cn(crm.btnGhost, "inline-flex text-sm")}>
            <ArrowLeft size={14} /> Back to Funders
          </Link>
        </div>

        {/* Header */}
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-crm-lg bg-crm-accent/15 text-xl font-bold text-crm-accent">
            {initials(funder.name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className={crm.title}>{funder.name}</h1>
              <span className={cn("rounded-full border px-2.5 py-0.5 text-xs font-medium", STATUS_COLORS[funder.status])}>
                {STATUS_LABELS[funder.status]}
              </span>
            </div>
            {funder.organization && (
              <div className="mt-1 flex items-center gap-1.5 text-sm text-crm-muted">
                <Building2 size={13} />{funder.organization}
              </div>
            )}
            {funder.tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {funder.tags.map((t) => (
                  <span
                    key={t.id}
                    className="rounded-full border px-2.5 py-0.5 text-xs font-medium"
                    style={t.color ? { borderColor: `${t.color}55`, color: t.color, background: `${t.color}18` } : {}}
                  >
                    {t.name}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {!editing && (
              <>
                <button onClick={startEdit} className={crm.btnPrimary}>Edit</button>
                <button onClick={() => setShowTagPanel(!showTagPanel)} className={crm.btnSecondary}>
                  <Tag size={14} /> Tags
                </button>
                <button onClick={() => setConfirming(true)} className={crm.btnDanger}>
                  <Trash2 size={14} /> Archive
                </button>
              </>
            )}
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] lg:items-start">
          {/* Main content */}
          <div className="flex flex-col gap-4 min-w-0">
            {editing ? (
              <CRMCard className="p-5">
                <h2 className={cn(crm.label, "mb-4")}>Edit Funder</h2>
                {saveErr && (
                  <div className={cn(crm.bannerDanger, "mb-3 rounded-crm px-3 py-2 text-sm")}>{saveErr}</div>
                )}
                <div className="flex flex-col gap-3">
                  <div className="grid grid-cols-2 gap-3">
                    {fieldEl("Name *", "name")}
                    <div>
                      <label className={crm.label}>Status</label>
                      <select
                        className={cn(crm.select, "mt-1")}
                        value={form.status}
                        onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as FunderStatus }))}
                      >
                        {(["ACTIVE", "INACTIVE", "PROSPECT", "PENDING"] as FunderStatus[]).map((s) => (
                          <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {fieldEl("Organization", "organization")}
                  {fieldEl("Email", "email", { type: "email" })}
                  <div className="grid grid-cols-2 gap-3">
                    {fieldEl("Phone", "phone")}
                    {fieldEl("Phone 2", "phone2")}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {fieldEl("City", "city")}
                    {fieldEl("State", "state")}
                    {fieldEl("Zip", "zip")}
                  </div>
                  {fieldEl("Notes", "notes", { multiline: true })}
                  <div className="flex justify-end gap-2 pt-2">
                    <button onClick={() => setEditing(false)} className={crm.btnSecondary} disabled={saving}>Cancel</button>
                    <button onClick={handleSave} disabled={saving} className={crm.btnPrimary}>
                      <Save size={14} /> {saving ? "Saving…" : "Save Changes"}
                    </button>
                  </div>
                </div>
              </CRMCard>
            ) : (
              <CRMCard className="p-5">
                <h2 className={cn(crm.label, "mb-4")}>Contact Info</h2>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {[
                    { label: "Name", value: funder.name },
                    { label: "Organization", value: funder.organization },
                    { label: "Email", value: funder.email },
                    { label: "Phone", value: funder.phone },
                    { label: "Phone 2", value: funder.phone2 },
                    { label: "City", value: funder.city },
                    { label: "State", value: funder.state },
                    { label: "Zip", value: funder.zip },
                  ].map((row) => (
                    row.value ? (
                      <div key={row.label}>
                        <div className={crm.label}>{row.label}</div>
                        <div className="mt-0.5 text-sm text-crm-text">{row.value}</div>
                      </div>
                    ) : null
                  ))}
                </div>
                {funder.notes && (
                  <div className="mt-4 border-t border-crm-border/50 pt-4">
                    <div className={crm.label}>Notes</div>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-crm-text">{funder.notes}</p>
                  </div>
                )}
              </CRMCard>
            )}
          </div>

          {/* Sidebar */}
          <div className="flex flex-col gap-3 min-w-0">
            {/* Tag assignment panel */}
            {showTagPanel && (
              <CRMCard className="p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className={crm.label}>Assign Tags</h3>
                  <button onClick={() => setShowTagPanel(false)} className={crm.btnGhost} style={{ padding: "0.25rem" }}>
                    <X size={14} />
                  </button>
                </div>
                {allTags.length === 0 ? (
                  <p className={crm.muted}>No tags yet. Create tags from the Funders list.</p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {allTags.map((t) => {
                      const assigned = assignedTagIds.has(t.id);
                      return (
                        <button
                          key={t.id}
                          disabled={tagWorking}
                          onClick={() => handleTagAssign(t.id, assigned ? "remove" : "assign")}
                          className={cn(
                            "flex items-center justify-between rounded-crm border px-3 py-2 text-sm transition-colors",
                            assigned
                              ? "border-crm-accent/40 bg-crm-accent/10 text-crm-accent"
                              : "border-crm-border text-crm-muted hover:border-crm-border/80 hover:text-crm-text"
                          )}
                          style={t.color && !assigned ? { borderColor: `${t.color}55`, color: t.color } : {}}
                        >
                          <span>{t.name}</span>
                          {assigned && <span className="text-xs font-semibold">✓ Assigned</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </CRMCard>
            )}

            {/* Metadata */}
            <CRMCard className="p-4">
              <h3 className={cn(crm.label, "mb-3")}>Details</h3>
              <div className="flex flex-col gap-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className={crm.muted}>Status</span>
                  <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", STATUS_COLORS[funder.status])}>
                    {STATUS_LABELS[funder.status]}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className={crm.muted}>Created</span>
                  <span className="text-crm-text">{formatDate(funder.createdAt)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className={crm.muted}>Updated</span>
                  <span className="text-crm-text">{formatDate(funder.updatedAt)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className={crm.muted}>Tags</span>
                  <span className="text-crm-text">{funder.tags.length}</span>
                </div>
              </div>
            </CRMCard>

            {/* Danger zone */}
            {confirming && (
              <CRMCard className={cn("border-crm-danger/30 p-4", crm.bannerDanger.replace("border", "").trim())}>
                <p className="mb-2 text-sm font-medium">Archive this funder?</p>
                <p className={cn(crm.muted, "mb-3 text-xs")}>This will soft-archive the record. It can be restored by an admin.</p>
                <div className="flex gap-2">
                  <button onClick={() => setConfirming(false)} className={crm.btnSecondary}>Cancel</button>
                  <button onClick={handleArchive} disabled={archiving} className={crm.btnDanger}>
                    {archiving ? "Archiving…" : "Archive"}
                  </button>
                </div>
              </CRMCard>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
