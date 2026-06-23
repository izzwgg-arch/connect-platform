"use client";

import { useMemo, useState } from "react";
import { CrmRecordingPlayer } from "../../../components/CrmRecordingPlayer";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorState } from "../../../components/ErrorState";
import { FilterBar } from "../../../components/FilterBar";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { PageHeader } from "../../../components/PageHeader";
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { apiGet } from "../../../services/apiClient";

// Recordings are sourced from the same ConnectCdr-backed call history the Calls
// page uses (hasRecording=yes), and play through the shared
// /api/voice/recording/:linkedId/stream endpoint — which now self-heals stale
// PBX paths. This page intentionally does NOT hit the legacy VitalPBX list
// endpoint (which returned rows with no playable source).

type RecordingRow = {
  rowId: string;
  linkedId: string;
  fromNumber: string;
  fromName: string | null;
  toNumber: string;
  direction: "incoming" | "outgoing" | "internal";
  durationSec: number;
  startedAt: string;
  tenantName: string;
  rangExtension: string | null;
  recordingAvailable: boolean;
};

type CallHistoryResponse = { items: RecordingRow[]; total: number; totalPages: number };

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function directionLabel(dir: RecordingRow["direction"]): string {
  if (dir === "incoming") return "Inbound";
  if (dir === "outgoing") return "Outbound";
  return "Internal";
}

export default function RecordingsPage() {
  const { can } = useAppContext();
  const [search, setSearch] = useState("");
  const [directionFilter, setDirectionFilter] = useState<"all" | "incoming" | "outgoing">("all");
  const [query, setQuery] = useState("");

  const canView = can("can_view_recordings") || can("can_view_pbx_call_recordings");
  const canDownload = can("can_download_recordings");

  const historyQuery = useMemo(() => {
    const p = new URLSearchParams({
      direction: directionFilter,
      status: "all",
      page: "1",
      pageSize: "100",
      hasRecording: "yes",
    });
    if (query) p.set("search", query);
    return p.toString();
  }, [directionFilter, query]);

  const state = useAsyncResource<CallHistoryResponse>(
    () => apiGet<CallHistoryResponse>(`/calls/history?${historyQuery}`),
    [historyQuery],
  );

  if (!canView) {
    return <div className="state-box">You do not have recordings access.</div>;
  }

  const rows = state.status === "success" ? state.data.items.filter((r) => r.recordingAvailable && r.linkedId) : [];

  return (
    <div className="stack">
      <PageHeader title="Recordings Library" subtitle="Search and play call recordings across the current workspace." />
      <FilterBar>
        <input
          className="input"
          placeholder="Search by number, name, or extension..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") setQuery(search.trim()); }}
        />
        <button className="btn ghost" onClick={() => setQuery(search.trim())}>Search</button>
        <select className="input" value={directionFilter} onChange={(e) => setDirectionFilter(e.target.value as typeof directionFilter)}>
          <option value="all">All directions</option>
          <option value="incoming">Inbound</option>
          <option value="outgoing">Outbound</option>
        </select>
      </FilterBar>

      {state.status === "loading" ? <LoadingSkeleton rows={6} /> : null}
      {state.status === "error" ? <ErrorState message={state.error} /> : null}
      {state.status === "success" && rows.length === 0 ? (
        <EmptyState title="No recordings found" message="Recorded calls will appear here. Try adjusting your filters." />
      ) : null}

      {state.status === "success" && rows.length > 0 ? (
        <section className="panel">
          {rows.map((row) => {
            const token =
              typeof window !== "undefined"
                ? window.localStorage.getItem("token") || window.localStorage.getItem("cc-token") || ""
                : "";
            const downloadHref = `/api/voice/recording/${encodeURIComponent(row.linkedId)}/download${token ? `?token=${encodeURIComponent(token)}` : ""}`;
            const party = row.direction === "outgoing"
              ? `${row.rangExtension || row.fromNumber} → ${row.toNumber}`
              : `${row.fromName || row.fromNumber} → ${row.rangExtension || row.toNumber}`;
            return (
              <div key={row.rowId} className="audio-row">
                <div>
                  <strong>{directionLabel(row.direction)}</strong>
                  <div className="meta">{party}</div>
                  <div className="meta">{formatWhen(row.startedAt)} · {row.tenantName}</div>
                </div>
                <div className="meta">{formatDuration(row.durationSec)}</div>
                <CrmRecordingPlayer linkedId={row.linkedId} />
                {canDownload ? (
                  <a className="btn ghost" href={downloadHref} target="_blank" rel="noreferrer">Download</a>
                ) : null}
              </div>
            );
          })}
        </section>
      ) : null}
    </div>
  );
}
