"use client";

import { AudioPlayerRow } from "../../../components/AudioPlayerRow";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorState } from "../../../components/ErrorState";
import { FilterBar } from "../../../components/FilterBar";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";
import { StatusChip } from "../../../components/StatusChip";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { loadRecordingsData } from "../../../services/platformData";

export default function RecordingsPage() {
  const state = useAsyncResource(loadRecordingsData, []);
  if (state.status === "loading") return <LoadingSkeleton rows={6} />;
  if (state.status === "error") return <ErrorState message={state.error} />;
  const recordings = state.data;

  return (
    <PermissionGate permission="can_view_recordings" fallback={<div className="state-box">You do not have recordings access.</div>}>
      <div className="stack">
      <PageHeader title="Recordings Library" subtitle="Search and review call recordings across the current tenant." />
      <FilterBar>
        <input className="input" placeholder="Search by number or extension..." />
        <button className="btn ghost">Date Range</button>
        <button className="btn ghost">Direction</button>
      </FilterBar>
      <div className="row-wrap">
        <StatusChip tone="info" label="Retention Policy: 180 days" />
        <StatusChip tone="warning" label={`${Math.max(0, recordings.length - 1)} recordings pending compliance tag`} />
      </div>
      {recordings.length === 0 ? (
        <EmptyState title="No recordings yet" message="Once calls are recorded, they will appear in this library." />
      ) : (
        recordings.map((item) => <AudioPlayerRow key={item.id} title={item.title} from={item.from} duration={item.duration} />)
      )}
      </div>
    </PermissionGate>
  );
}
