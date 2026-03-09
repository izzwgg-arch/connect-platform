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
import { directionClass, directionLabel, formatDurationSec } from "../../../../services/pbxLive";

type CdrRow = {
  id: string;
  startedAt: string;
  extension: string;
  direction: string;
  number: string;
  disposition: string;
  durationSec: number;
  durationFmt: string;
};

export default function ReportsCdrPage() {
  const today = new Date().toISOString().slice(0, 10);
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);
  const [dirFilter, setDirFilter] = useState("all");
  const [dispFilter, setDispFilter] = useState("all");

  const state = useAsyncResource(
    () => loadCallReports({ dateFrom: dateFrom || undefined, dateTo: dateTo || undefined }),
    [dateFrom, dateTo]
  );

  const allRows = useMemo<CdrRow[]>(() => {
    if (state.status !== "success") return [];
    const source = Array.isArray(state.data.report?.items)
      ? state.data.report.items
      : Array.isArray(state.data.report)
        ? state.data.report
        : [];
    return source.map((row: any, idx: number): CdrRow => {
      const sec = Number(row.duration || row.durationSec || row.billsec || 0);
      return {
        id: String(row.id || row.callId || row.uniqueid || idx),
        startedAt: String(row.startedAt || row.start || row.createdAt || "-"),
        extension: String(row.extension || row.src || row.toExtension || "-"),
        direction: String(row.direction || "-").toLowerCase(),
        number: String(row.from || row.to || row.dst || "-"),
        disposition: String(row.disposition || row.status || "-").toLowerCase(),
        durationSec: sec,
        durationFmt: formatDurationSec(sec),
      };
    });
  }, [state]);

  const rows = useMemo<CdrRow[]>(() => {
    return allRows.filter((r) => {
      if (dirFilter !== "all" && r.direction !== dirFilter) return false;
      if (dispFilter !== "all" && r.disposition !== dispFilter) return false;
      return true;
    });
  }, [allRows, dirFilter, dispFilter]);

  const answered = rows.filter((r) => r.disposition === "answered").length;
  const missed = rows.filter((r) => r.disposition !== "answered" && r.disposition !== "-").length;
  const totalSec = rows.reduce((sum, r) => sum + r.durationSec, 0);
  const avgSec = rows.length > 0 ? Math.round(totalSec / rows.length) : 0;

  return (
    <PermissionGate permission="can_view_reports" fallback={<div className="state-box">You do not have report access.</div>}>
      <div className="stack compact-stack">
        <PageHeader
          title="CDR Report"
          subtitle="Call detail records — direction, disposition, and duration analytics from VitalPBX."
        />
        <FilterBar>
          <label className="filter-label">
            From
            <input className="input" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </label>
          <label className="filter-label">
            To
            <input className="input" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </label>
          <label className="filter-label">
            Direction
            <select className="input" value={dirFilter} onChange={(e) => setDirFilter(e.target.value)}>
              <option value="all">All</option>
              <option value="inbound">Inbound</option>
              <option value="outbound">Outbound</option>
              <option value="internal">Internal</option>
            </select>
          </label>
          <label className="filter-label">
            Disposition
            <select className="input" value={dispFilter} onChange={(e) => setDispFilter(e.target.value)}>
              <option value="all">All</option>
              <option value="answered">Answered</option>
              <option value="no answer">No Answer</option>
              <option value="busy">Busy</option>
              <option value="failed">Failed</option>
            </select>
          </label>
        </FilterBar>

        <section className="metric-grid">
          <MetricCard label="Total" value={String(rows.length)} meta={`of ${allRows.length} filtered`} />
          <MetricCard label="Answered" value={String(answered)} />
          <MetricCard label="Missed / No Ans" value={String(missed)} />
          <MetricCard
            label="Answer Rate"
            value={rows.length ? `${Math.round((answered / rows.length) * 100)}%` : "0%"}
          />
          <MetricCard label="Avg Duration" value={formatDurationSec(avgSec)} />
          <MetricCard label="Total Talk Time" value={formatDurationSec(totalSec)} />
        </section>

        <section className="panel">
          {state.status === "loading" ? <LoadingSkeleton rows={8} /> : null}
          {state.status === "error" ? <ErrorState message={state.error} /> : null}
          {state.status === "success" && rows.length === 0 ? (
            <EmptyState title="No CDR rows" message="Adjust your date range or filters." />
          ) : null}
          {state.status === "success" && rows.length > 0 ? (
            <DataTable
              rows={rows}
              columns={[
                {
                  key: "startedAt",
                  label: "Time",
                  render: (r) => <span className="mono text-sm">{r.startedAt}</span>,
                },
                { key: "extension", label: "Extension", render: (r) => r.extension },
                {
                  key: "direction",
                  label: "Direction",
                  render: (r) => (
                    <span className={`badge ${directionClass(r.direction)}`}>
                      {directionLabel(r.direction)}
                    </span>
                  ),
                },
                { key: "number", label: "Number", render: (r) => r.number },
                {
                  key: "disposition",
                  label: "Disposition",
                  render: (r) => (
                    <span className={r.disposition === "answered" ? "text-success" : "text-muted"}>
                      {r.disposition}
                    </span>
                  ),
                },
                { key: "durationFmt", label: "Duration", render: (r) => r.durationFmt },
              ]}
            />
          ) : null}
        </section>
      </div>
    </PermissionGate>
  );
}
