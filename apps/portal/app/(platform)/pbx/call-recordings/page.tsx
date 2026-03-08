"use client";

import { useState } from "react";
import { AudioPlayerRow } from "../../../../components/AudioPlayerRow";
import { EmptyState } from "../../../../components/EmptyState";
import { ErrorState } from "../../../../components/ErrorState";
import { FilterBar } from "../../../../components/FilterBar";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { loadCallRecordings } from "../../../../services/pbxData";

export default function PbxCallRecordingsPage() {
  const [q, setQ] = useState("");
  const [extension, setExtension] = useState("");
  const state = useAsyncResource(() => loadCallRecordings({ q, extension }), [q, extension]);

  return (
    <PermissionGate permission="can_view_recordings" fallback={<div className="state-box">You do not have recording access.</div>}>
      <div className="stack compact-stack">
        <PageHeader title="Call Recordings" subtitle="Filter and review call recordings sourced from VitalPBX." />
        <FilterBar>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by number..." />
          <input className="input" value={extension} onChange={(e) => setExtension(e.target.value)} placeholder="Extension" />
        </FilterBar>
        <section className="panel">
          {state.status === "loading" ? <LoadingSkeleton rows={6} /> : null}
          {state.status === "error" ? <ErrorState message={state.error} /> : null}
          {state.status === "success" && state.data.rows.length === 0 ? (
            <EmptyState title="No recordings found" message="Adjust filters or verify recording storage in PBX." />
          ) : null}
          {state.status === "success"
            ? state.data.rows.map((row: any, idx: number) => (
                <AudioPlayerRow
                  key={String(row.id || row.callId || idx)}
                  title={String(row.title || row.direction || "Call Recording")}
                  from={`${String(row.from || "Unknown")} -> ${String(row.to || "Unknown")}`}
                  duration={String(row.duration || row.durationSec || "00:00")}
                />
              ))
            : null}
        </section>
      </div>
    </PermissionGate>
  );
}
