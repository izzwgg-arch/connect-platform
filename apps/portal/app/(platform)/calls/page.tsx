"use client";

import { DataTable } from "../../../components/DataTable";
import { DetailCard } from "../../../components/DetailCard";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorState } from "../../../components/ErrorState";
import { GlobalScopeNotice } from "../../../components/GlobalScopeNotice";
import { LiveCallBadge } from "../../../components/LiveCallBadge";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";
import { ScopedActionButton } from "../../../components/ScopedActionButton";
import { ScopeBadge } from "../../../components/ScopeBadge";
import { StatusChip } from "../../../components/StatusChip";
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { loadCallsData } from "../../../services/platformData";

export default function CallsPage() {
  const { adminScope } = useAppContext();
  const isGlobal = adminScope === "GLOBAL";
  const state = useAsyncResource(() => loadCallsData(adminScope), [adminScope]);
  if (state.status === "loading") return <LoadingSkeleton rows={8} />;
  if (state.status === "error") return <ErrorState message={state.error} />;
  const { live, history, scopeLabel } = state.data;

  return (
    <PermissionGate permission="can_view_calls" fallback={<div className="state-box">You do not have calls access.</div>}>
      <div className="stack">
      <PageHeader
        title="Calls Console"
        subtitle={`Live operational visibility and historical records (${scopeLabel.toLowerCase()} scope).`}
        badges={<ScopeBadge scope={scopeLabel} />}
      />
      {isGlobal ? <GlobalScopeNotice /> : null}

      <DetailCard title="Live Calls">
        {live.length === 0 ? (
          <EmptyState title="No live calls" message="Active tenant calls appear here in real time." />
        ) : (
          <DataTable
            rows={live}
            columns={[
              { key: "ext", label: "Extension", render: (r) => r.extension },
              { key: "dir", label: "Direction", render: (r) => r.direction },
              { key: "caller", label: "Caller", render: (r) => r.caller },
              { key: "dur", label: "Duration", render: (r) => r.duration },
              { key: "state", label: "Status", render: (r) => <StatusChip tone="info" label={r.state} /> },
              { key: "live", label: "Live", render: () => <LiveCallBadge active={true} /> }
            ]}
          />
        )}
      </DetailCard>

      <DetailCard title="Call History">
        {history.length === 0 ? (
          <EmptyState title="No call history" message="Historical call records will populate once CDR sync runs." />
        ) : (
          <DataTable
            rows={history}
            columns={[
              { key: "when", label: "Time", render: (r) => r.when },
              { key: "ext", label: "Extension", render: (r) => r.ext },
              { key: "dir", label: "Direction", render: (r) => r.direction },
              { key: "num", label: "Number", render: (r) => r.number },
              { key: "disp", label: "Disposition", render: (r) => <StatusChip tone={r.disposition === "Answered" ? "success" : "warning"} label={r.disposition} /> },
              { key: "rec", label: "Recording", render: (r) => (r.recording ? "Available" : "No") },
              {
                key: "act",
                label: "Actions",
                render: () => <ScopedActionButton className="btn ghost" allowInGlobal>Open</ScopedActionButton>
              }
            ]}
          />
        )}
      </DetailCard>
      </div>
    </PermissionGate>
  );
}
