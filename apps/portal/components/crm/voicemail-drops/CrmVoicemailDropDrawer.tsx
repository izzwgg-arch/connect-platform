"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2, Play, Search, Voicemail, X, Zap } from "lucide-react";
import { apiGet, apiPost } from "../../../services/apiClient";
import { cn } from "../cn";
import { crm } from "../crmClasses";

type VoicemailDrop = {
  id: string;
  name: string;
  status: string;
  durationSeconds?: number | null;
  usageCount: number;
  isDefault: boolean;
  campaign?: { id: string; name: string } | null;
  streamUrl?: string | null;
};

function fmtDuration(seconds?: number | null): string {
  const sec = Math.max(0, Number(seconds || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function tokenized(url?: string | null): string {
  if (!url || typeof window === "undefined") return url || "";
  const token = localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

export function CrmVoicemailDropDrawer({
  open,
  onClose,
  contactId,
  contactName,
  activeCallId,
  onDropped,
}: {
  open: boolean;
  onClose: () => void;
  contactId: string;
  contactName: string;
  activeCallId: string | null;
  onDropped?: () => void;
}) {
  const [drops, setDrops] = useState<VoicemailDrop[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string>("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setSuccess(false);
    void apiGet<{ voicemailDrops: VoicemailDrop[] }>("/crm/voicemail-drops")
      .then((res) => {
        const ready = (res.voicemailDrops ?? []).filter((drop) => drop.status === "READY");
        setDrops(ready);
        setSelectedId(ready.find((drop) => drop.isDefault)?.id || ready[0]?.id || "");
      })
      .catch((err: any) => setError(err?.message || "Failed to load voicemail drops"))
      .finally(() => setLoading(false));
  }, [open]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return drops;
    return drops.filter((drop) => `${drop.name} ${drop.campaign?.name || ""}`.toLowerCase().includes(q));
  }, [drops, search]);

  const selected = drops.find((drop) => drop.id === selectedId) ?? null;

  async function playVoicemail() {
    if (!selected || !activeCallId) return;
    setPosting(true);
    setError(null);
    try {
      await apiPost("/crm/voicemail-drops/drop", {
        activeCallId,
        contactId,
        voicemailDropId: selected.id,
      }, undefined, { timeoutMs: 20000 });
      setSuccess(true);
      onDropped?.();
      setTimeout(() => onClose(), 900);
    } catch (err: any) {
      setError(err?.message || "Failed to play voicemail");
    } finally {
      setPosting(false);
    }
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Drop voicemail"
      className="fixed inset-0 z-[60] flex justify-end bg-black/35 backdrop-blur-[2px]"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex h-full w-full max-w-[620px] flex-col border-l border-slate-200 bg-[#fbfaf7] shadow-2xl">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
              <Voicemail className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-base font-black text-slate-950">Drop Voicemail</h2>
              <p className="truncate text-xs text-slate-500">Select a voicemail to play for {contactName}.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {!activeCallId ? (
            <div className="mb-4 flex gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              No active outbound call was found for this contact. Start the call in the floating dialer, then drop voicemail when voicemail answers.
            </div>
          ) : null}
          {error ? (
            <div className="mb-4 flex gap-2 rounded-2xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          ) : null}
          {success ? (
            <div className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-700">
              Voicemail playback started.
            </div>
          ) : null}

          <div className="relative mb-4">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search voicemails..."
              className="w-full rounded-2xl border border-slate-200 bg-white py-2.5 pl-10 pr-3 text-sm text-slate-900 outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
            />
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading voicemails...
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
              No ready voicemail drops found.
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((drop) => (
                <button
                  key={drop.id}
                  type="button"
                  onClick={() => setSelectedId(drop.id)}
                  className={cn(
                    "w-full rounded-2xl border bg-white p-3 text-left transition",
                    selectedId === drop.id ? "border-indigo-300 ring-4 ring-indigo-100" : "border-slate-200 hover:border-indigo-200",
                  )}
                >
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white">
                      <Play className="h-3.5 w-3.5 fill-current" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-black text-slate-950">{drop.name}</span>
                        {drop.isDefault ? <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-bold text-indigo-600">Default</span> : null}
                      </span>
                      <span className="mt-0.5 block text-xs font-medium text-slate-500">
                        {fmtDuration(drop.durationSeconds)} · Used {drop.usageCount} times · {drop.campaign?.name || "General"}
                      </span>
                    </span>
                  </div>
                  {drop.streamUrl ? <audio className="mt-3 w-full" src={tokenized(drop.streamUrl)} controls /> : null}
                </button>
              ))}
            </div>
          )}

          <div className="mt-4 rounded-2xl border border-indigo-100 bg-indigo-50 p-3 text-sm text-indigo-700">
            <strong>Tip</strong>: Keep it short and clear. Under 30 seconds gets the best results.
          </div>
        </div>

        <footer className="flex shrink-0 flex-col gap-2 border-t border-slate-200 bg-white px-5 py-4">
          <button
            type="button"
            disabled={!selected || !activeCallId || posting}
            onClick={() => void playVoicemail()}
            className={cn(crm.btnPrimary, "rounded-2xl bg-gradient-to-r from-indigo-600 to-violet-600 py-3 text-white")}
          >
            {posting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
            Play Voicemail
          </button>
          <button type="button" onClick={onClose} className="rounded-2xl px-4 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-50">
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
}
