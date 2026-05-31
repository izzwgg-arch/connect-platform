"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Clock3,
  FileAudio,
  Loader2,
  MoreVertical,
  Play,
  Plus,
  Search,
  Sparkles,
  Upload,
  Voicemail,
  X,
} from "lucide-react";
import { CRMPageShell, cn } from "../../../../components/crm";
import {
  CRMWorkspaceShell,
  CRMWorkspaceChrome,
  CRMWorkspaceHeader,
  CRMWorkspaceToolbar,
  CRMWorkspaceScrollRegion,
  CRMWorkspaceFooter,
} from "../../../../components/crm/CRMWorkspaceShell";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet, apiUploadCrmVoicemailDrop } from "../../../../services/apiClient";

export type CrmVoicemailDrop = {
  id: string;
  name: string;
  description?: string | null;
  status: "READY" | "PROCESSING" | "FAILED" | "ARCHIVED";
  durationSeconds?: number | null;
  originalFileName?: string | null;
  campaign?: { id: string; name: string } | null;
  isDefault: boolean;
  usageCount: number;
  conversionStatus: string;
  conversionError?: string | null;
  streamUrl?: string | null;
  updatedAt: string;
};

type DropsResponse = {
  voicemailDrops: CrmVoicemailDrop[];
  stats: {
    totalRecordings: number;
    totalDurationSeconds: number;
    dropSuccessRate: number;
  };
};

function fmtDuration(total: number | null | undefined): string {
  const sec = Math.max(0, Number(total || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `0:${String(s).padStart(2, "0")}`;
}

function timeAgo(value: string): string {
  const ms = Date.now() - new Date(value).getTime();
  const days = Math.max(0, Math.floor(ms / 86400000));
  if (days === 0) return "Updated today";
  if (days === 1) return "Updated 1d ago";
  if (days < 30) return `Updated ${days}d ago`;
  return new Date(value).toLocaleDateString();
}

function authToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
}

function withToken(url: string | null | undefined): string {
  if (!url) return "";
  const token = authToken();
  if (!token) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

function Waveform({ seed }: { seed: string }) {
  const bars = useMemo(() => Array.from({ length: 42 }, (_, i) => {
    const code = seed.charCodeAt(i % Math.max(seed.length, 1)) || 7;
    return 18 + ((code * (i + 3)) % 46);
  }), [seed]);
  return (
    <div className="flex h-10 min-w-[160px] flex-1 items-center gap-1 overflow-hidden">
      {bars.map((h, idx) => (
        <span
          key={idx}
          className="w-1 rounded-full bg-gradient-to-t from-indigo-200 via-violet-300 to-sky-200"
          style={{ height: `${h}%` }}
        />
      ))}
    </div>
  );
}

export default function CrmVoicemailDropsPage() {
  const [drops, setDrops] = useState<CrmVoicemailDrop[]>([]);
  const [stats, setStats] = useState<DropsResponse["stats"]>({ totalRecordings: 0, totalDurationSeconds: 0, dropSuccessRate: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [modalOpen, setModalOpen] = useState(false);

  async function loadDrops() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<DropsResponse>("/crm/voicemail-drops?includeArchived=true");
      setDrops(res.voicemailDrops ?? []);
      setStats(res.stats ?? { totalRecordings: 0, totalDurationSeconds: 0, dropSuccessRate: 0 });
    } catch (err: any) {
      setError(err?.message || "Failed to load voicemail drops");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDrops();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return drops.filter((drop) => {
      if (statusFilter !== "all" && drop.status !== statusFilter) return false;
      if (!q) return true;
      return `${drop.name} ${drop.description || ""} ${drop.campaign?.name || ""}`.toLowerCase().includes(q);
    });
  }, [drops, search, statusFilter]);

  return (
    <PermissionGate permission="can_view_crm_voicemail_drops" fallback={<div className="state-box">You do not have Voicemail Drops access.</div>}>
    <CRMPageShell className="crm-voicemail-drops-workspace w-full min-h-0 bg-[#f8f5ef]" innerClassName="crm-voicemail-drops-inner mx-auto w-full max-w-[1320px] px-3 py-5 sm:px-6 lg:px-8 flex min-h-0 flex-1 flex-col gap-5 text-slate-900">
      <CRMWorkspaceShell>
        <CRMWorkspaceChrome>
          <CRMWorkspaceHeader>
            <section className="rounded-[2rem] border border-white/80 bg-white/85 p-5 shadow-[0_24px_70px_-42px_rgba(46,43,79,0.45)] backdrop-blur">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-lg shadow-indigo-500/20">
                    <Voicemail className="h-6 w-6" />
                  </div>
                  <div>
                    <p className="text-xs font-black uppercase tracking-[0.22em] text-indigo-500">Voicemail Drop</p>
                    <h1 className="text-2xl font-black tracking-tight text-slate-950 sm:text-3xl">Pre-recorded Voicemails</h1>
                    <p className="mt-1 text-sm text-slate-500">Record, manage, and drop voicemails when calls go to voicemail.</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setModalOpen(true)}
                  className="inline-flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-indigo-600 to-violet-600 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-indigo-500/25 hover:brightness-105"
                >
                  <Plus className="h-4 w-4" />
                  New Voicemail
                </button>
              </div>
            </section>
          </CRMWorkspaceHeader>

          <CRMWorkspaceToolbar className="flex flex-col gap-3">
            <div className="grid gap-3 md:grid-cols-3">
              <KpiCard icon={<Voicemail className="h-5 w-5" />} label="Total Recordings" value={String(stats.totalRecordings)} />
              <KpiCard icon={<Play className="h-5 w-5" />} label="Total Duration" value={fmtDuration(stats.totalDurationSeconds)} />
              <KpiCard icon={<Sparkles className="h-5 w-5" />} label="Drop Success Rate" value={`${Math.round(stats.dropSuccessRate)}%`} />
            </div>

            <section className="overflow-hidden rounded-[1.75rem] border border-white/80 bg-white/90 shadow-[0_18px_60px_-42px_rgba(46,43,79,0.5)]">
              <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search voicemails..."
                    className="w-full rounded-2xl border border-slate-200 bg-white py-2.5 pl-10 pr-3 text-sm text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                  />
                </div>
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                >
                  <option value="all">All Statuses</option>
                  <option value="READY">Ready</option>
                  <option value="PROCESSING">Processing</option>
                  <option value="FAILED">Failed</option>
                  <option value="ARCHIVED">Archived</option>
                </select>
              </div>
            </section>
          </CRMWorkspaceToolbar>
        </CRMWorkspaceChrome>

        <CRMWorkspaceScrollRegion>
          <section className="overflow-hidden rounded-[1.75rem] border border-white/80 bg-white/90 shadow-[0_18px_60px_-42px_rgba(46,43,79,0.5)]">
            {loading ? (
              <div className="flex items-center justify-center gap-2 p-12 text-sm font-semibold text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading voicemail drops...
              </div>
            ) : error ? (
              <div className="m-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>
            ) : filtered.length === 0 ? (
              <div className="p-12 text-center">
                <FileAudio className="mx-auto h-10 w-10 text-slate-300" />
                <h2 className="mt-3 text-lg font-bold text-slate-900">No voicemail drops yet</h2>
                <p className="mt-1 text-sm text-slate-500">Upload your first PBX-safe voicemail recording to get started.</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {filtered.map((drop) => (
                  <VoicemailRow key={drop.id} drop={drop} />
                ))}
              </div>
            )}
          </section>
        </CRMWorkspaceScrollRegion>

        <CRMWorkspaceFooter>
          <div className="rounded-[1.25rem] border border-indigo-100 bg-indigo-50/80 px-4 py-3 text-center text-sm font-medium text-indigo-700">
            Tip: Keep voicemails under 30 seconds for best results.
          </div>
        </CRMWorkspaceFooter>
      </CRMWorkspaceShell>

      {modalOpen ? (
        <NewVoicemailModal
          onClose={() => setModalOpen(false)}
          onCreated={(drop) => {
            setDrops((prev) => [drop, ...prev]);
            setModalOpen(false);
            void loadDrops();
          }}
        />
      ) : null}
    </CRMPageShell>
    </PermissionGate>
  );
}

function KpiCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-[1.5rem] border border-white/80 bg-white/90 p-4 shadow-[0_18px_55px_-42px_rgba(46,43,79,0.55)]">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">{icon}</div>
        <div>
          <p className="text-2xl font-black tracking-tight text-slate-950">{value}</p>
          <p className="text-xs font-bold uppercase tracking-wide text-slate-400">{label}</p>
        </div>
      </div>
    </div>
  );
}

function VoicemailRow({ drop }: { drop: CrmVoicemailDrop }) {
  const [playing, setPlaying] = useState(false);
  const src = withToken(drop.streamUrl);
  return (
    <article className="grid gap-3 px-4 py-4 transition hover:bg-indigo-50/35 lg:grid-cols-[minmax(0,1fr)_minmax(180px,0.7fr)_auto_auto] lg:items-center">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          disabled={!src || drop.status !== "READY"}
          onClick={() => setPlaying((v) => !v)}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-lg shadow-indigo-500/20 disabled:bg-slate-200 disabled:from-slate-200 disabled:to-slate-200"
        >
          <Play className="h-4 w-4 fill-current" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-black text-slate-950">{drop.name}</h3>
            {drop.isDefault ? <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-bold text-indigo-600">Default</span> : null}
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold", drop.status === "READY" ? "bg-emerald-50 text-emerald-600" : drop.status === "FAILED" ? "bg-rose-50 text-rose-600" : "bg-amber-50 text-amber-600")}>
              {drop.status}
            </span>
          </div>
          <p className="mt-1 text-xs font-medium text-slate-500">
            {fmtDuration(drop.durationSeconds)} · Used {drop.usageCount} times
          </p>
          {playing && src ? <audio className="mt-2 w-full max-w-md" src={src} controls autoPlay onEnded={() => setPlaying(false)} /> : null}
        </div>
      </div>
      <Waveform seed={drop.id + drop.name} />
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-bold text-violet-600">
          {drop.campaign?.name || "General"}
        </span>
        <span className="whitespace-nowrap text-xs font-semibold text-slate-400">{timeAgo(drop.updatedAt)}</span>
      </div>
      <button className="justify-self-start rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 lg:justify-self-end" type="button" title="More actions">
        <MoreVertical className="h-4 w-4" />
      </button>
    </article>
  );
}

function NewVoicemailModal({ onClose, onCreated }: { onClose: () => void; onCreated: (drop: CrmVoicemailDrop) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!file || !name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiUploadCrmVoicemailDrop({
        name: name.trim(),
        description: description.trim() || undefined,
        isDefault,
        file,
      }) as { voicemailDrop: CrmVoicemailDrop };
      onCreated(res.voicemailDrop);
    } catch (err: any) {
      setError(err?.message || "Failed to upload voicemail");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/35 px-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="w-full max-w-xl overflow-hidden rounded-[1.75rem] border border-white bg-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
              <Upload className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-black text-slate-950">New Voicemail</h2>
              <p className="text-xs text-slate-500">Upload audio. Connect converts it to PBX-safe WAV.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="space-y-4 p-5">
          {error ? (
            <div className="flex gap-2 rounded-2xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          ) : null}
          <div>
            <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-slate-500">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" placeholder="Standard Voicemail" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-slate-500">Description / notes</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-24 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" placeholder="Short context for agents" />
          </div>
          <label className="flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-700">
            Set as default voicemail drop
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} className="h-4 w-4 accent-indigo-600" />
          </label>
          <div className="rounded-2xl border border-dashed border-indigo-200 bg-indigo-50/50 p-4">
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 text-center">
              <Upload className="h-7 w-7 text-indigo-500" />
              <span className="text-sm font-bold text-slate-900">{file ? file.name : "Upload WAV, MP3, M4A, or OGG"}</span>
              <span className="text-xs text-slate-500">Browser recording is intentionally deferred for this slice.</span>
              <input type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
          </div>
        </div>
        <footer className="flex flex-col-reverse gap-2 border-t border-slate-100 px-5 py-4 sm:flex-row sm:justify-end">
          <button type="button" onClick={onClose} className="rounded-2xl border border-slate-200 px-4 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50">Cancel</button>
          <button type="button" disabled={saving || !name.trim() || !file} onClick={() => void submit()} className="inline-flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-indigo-600 to-violet-600 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-60">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock3 className="h-4 w-4" />}
            Create Voicemail
          </button>
        </footer>
      </div>
    </div>
  );
}
