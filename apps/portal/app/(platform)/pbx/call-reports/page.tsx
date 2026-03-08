"use client";

import { useMemo, useState } from "react";
import { DataTable } from "../../../../components/DataTable";
import { EmptyState } from "../../../../components/EmptyState";
import { ErrorState } from "../../../../components/ErrorState";
import { FilterBar } from "../../../../components/FilterBar";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { MetricCard } from "../../../../components/MetricCard";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { loadCallReports } from "../../../../services/pbxData";

export default function PbxCallReportsPage() {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const state = useAsyncResource(() => loadCallReports({ dateFrom: dateFrom || undefined, dateTo: dateTo || undefined }), [dateFrom, dateTo]);

  const rows = useMemo(() => {
    if (state.status !== "success") return [];
    const source = Array.isArray(state.data.report?.items)
      ? state.data.report.items
      : Array.isArray(state.data.report)
        ? state.data.report
        : [];
    return source.map((row: any, idx: number) => ({
      id: String(row.id || row.callId || idx),
      startedAt: String(row.startedAt || row.createdAt || "-"),
      extension: String(row.extension || row.toExtension || "-"),
      direction: String(row.direction || "-"),
      number: String(row.from || row.to || "-"),
      disposition: String(row.disposition || row.status || "-"),
      duration: String(row.duration || row.durationSec || "-")
    }));
  }, [state]);

  const answered = rows.filter((row) => row.disposition.toLowerCase() === "answered").length;
  const missed = rows.filter((row) => row.disposition.toLowerCase().includes("miss")).length;

  return (
    <PermissionGate permission="can_view_reports" fallback={<div className="state-box">You do not have report access.</div>}>
      <div className="stack compact-stack">
        <PageHeader title="Call Reports / CDR" subtitle="CDR analytics with answered, missed, duration, and extension filters." />
        <FilterBar>
          <input className="input" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          <input className="input" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </FilterBar>
        <section className="metric-grid">
          <MetricCard label="Calls" value={String(rows.length)} />
          <MetricCard label="Answered" value={String(answered)} />
          <MetricCard label="Missed" value={String(missed)} />
          <MetricCard label="Answer Rate" value={rows.length ? `${Math.round((answered / rows.length) * 100)}%` : "0%"} />
        </section>
        <section className="panel">
          {state.status === "loading" ? <LoadingSkeleton rows={8} /> : null}
          {state.status === "error" ? <ErrorState message={state.error} /> : null}
          {state.status === "success" && rows.length === 0 ? <EmptyState title="No CDR rows found" message="Try a wider date range." /> : null}
          {state.status === "success" && rows.length > 0 ? (
            <DataTable
              rows={rows}
              columns={[
                { key: "startedAt", label: "Time", render: (r) => r.startedAt },
                { key: "extension", label: "Extension", render: (r) => r.extension },
                { key: "direction", label: "Direction", render: (r) => r.direction },
                { key: "number", label: "Number", render: (r) => r.number },
                { key: "disposition", label: "Disposition", render: (r) => r.disposition },
                { key: "duration", label: "Duration", render: (r) => r.duration }
              ]}
            />
          ) : null}
        </section>
      </div>
    </PermissionGate>
  );
}
