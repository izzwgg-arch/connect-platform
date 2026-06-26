"use client";

import { useMemo, useState } from "react";
import { CrmRecordingPlayer } from "../../../../components/CrmRecordingPlayer";
import { EmptyState } from "../../../../components/EmptyState";
import { ErrorState } from "../../../../components/ErrorState";
import { FilterBar } from "../../../../components/FilterBar";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../components/PageHeader";
import { useAppContext } from "../../../../hooks/useAppContext";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet } from "../../../../services/apiClient";
import { downloadRecording } from "../../../../services/recordingDownload";

// Recordings are sourced from ConnectCdr-backed call history (hasRecording=yes)
// and play through /api/voice/recording/:linkedId/stream, which self-heals stale
// PBX paths. The previous implementation rendered a srcless <audio> element and
// could never play.

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

export default function PbxCallRecordingsPage() {
  const { can } = useAppContext();
  const [search, setSearch] = useState("");
  const [extension, setExtension] = useState("");
  const [query, setQuery] = useState("");
  const [extQuery, setExtQuery] = useState("");

  const canView = can("can_view_recordings") || can("can_view_pbx_call_recordings");
  const canDownload = can("can_download_recordings");

  const historyQuery = useMemo(() => {
    const p = new URLSearchParams({
      direction: "all",
      status: "all",
      page: "1",
      pageSize: "100",
      hasRecording: "yes",
    });
    const term = [query, extQuery].filter(Boolean).join(" ").trim();
    if (term) p.set("search", term);
    return p.toString();
  }, [query, extQuery]);

  const state = useAsyncResource<CallHistoryResponse>(
    () => apiGet<CallHistoryResponse>(`/calls/history?${historyQuery}`),
    [historyQuery],
  );

  if (!canView) {
    return <div className="state-box">You do not have recording access.</div>;
  }

  const rows = state.status === "success" ? state.data.items.filter((r) => r.recordingAvailable && r.linkedId) : [];

  return (
    <div className="stack compact-stack">
      <PageHeader title="Call Recordings" subtitle="Filter and play recorded calls." />
      <FilterBar>
        <input
          className="input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") setQuery(search.trim()); }}
          placeholder="Search by number or name..."
        />
        <input
          className="input"
          value={extension}
          onChange={(e) => setExtension(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") setExtQuery(extension.trim()); }}
          placeholder="Extension"
        />
        <button className="btn ghost" onClick={() => { setQuery(search.trim()); setExtQuery(extension.trim()); }}>Search</button>
      </FilterBar>

      <section className="panel">
        {state.status === "loading" ? <LoadingSkeleton rows={6} /> : null}
        {state.status === "error" ? <ErrorState message={state.error} /> : null}
        {state.status === "success" && rows.length === 0 ? (
          <EmptyState title="No recordings found" message="Adjust filters or verify the call was recorded." />
        ) : null}
        {rows.map((row) => {
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
                <button
                  type="button"
                  className="btn ghost"
                  onClick={async () => {
                    const ok = await downloadRecording(row.linkedId);
                    if (!ok) window.alert("Download failed — the recording could not be retrieved. Please try again.");
                  }}
                >
                  Download
                </button>
              ) : null}
            </div>
          );
        })}
      </section>
    </div>
  );
}
