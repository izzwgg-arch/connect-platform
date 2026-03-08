"use client";

import { useMemo, useState } from "react";
import { DataTable } from "./DataTable";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { FilterBar } from "./FilterBar";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { PageHeader } from "./PageHeader";
import { PermissionGate } from "./PermissionGate";
import { ScopedActionButton } from "./ScopedActionButton";
import { SearchInput } from "./SearchInput";
import { useAsyncResource } from "../hooks/useAsyncResource";
import { createPbxResource, deletePbxResource, loadPbxResource, type PbxResourceName } from "../services/pbxData";

type Props = {
  title: string;
  subtitle: string;
  resource: PbxResourceName;
  permission?: "can_view_calls" | "can_view_team" | "can_view_recordings" | "can_view_reports" | "can_view_admin";
};

function resolveId(row: Record<string, unknown>, idx: number): string {
  const id = row.id || row.uuid || row.extension || row.name || idx;
  return String(id);
}

export function PbxResourcePage({ title, subtitle, resource, permission = "can_view_calls" }: Props) {
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState("");
  const [createPayload, setCreatePayload] = useState("{}");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const state = useAsyncResource(() => loadPbxResource(resource), [resource, reloadKey]);

  const rows = useMemo(() => {
    if (state.status !== "success") return [] as Array<Record<string, unknown> & { __id: string }>;
    const q = query.trim().toLowerCase();
    return state.data.rows
      .map((row, idx) => ({ ...row, __id: resolveId(row, idx) }))
      .filter((row) => {
        if (!q) return true;
        return Object.values(row).some((value) => String(value ?? "").toLowerCase().includes(q));
      });
  }, [query, state]);

  const columns = useMemo(() => {
    const sample = rows[0];
    if (!sample) return [] as Array<{ key: string; label: string; render: (row: any) => any }>;
    const keys = Object.keys(sample).filter((key) => key !== "__id").slice(0, 6);
    return [
      ...keys.map((key) => ({
        key,
        label: key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        render: (row: Record<string, unknown>) => String(row[key] ?? "-")
      })),
      {
        key: "actions",
        label: "Actions",
        render: (row: Record<string, unknown> & { __id: string }) => (
          <button
            className="btn ghost"
            onClick={async () => {
              try {
                setError("");
                setMessage("");
                await deletePbxResource(resource, row.__id);
                setMessage(`${title} row deleted.`);
                setReloadKey((k) => k + 1);
              } catch (e: any) {
                setError(e?.message || "Delete failed.");
              }
            }}
          >
            Delete
          </button>
        )
      }
    ];
  }, [resource, rows, title]);

  return (
    <PermissionGate permission={permission} fallback={<div className="state-box">You do not have access to this PBX module.</div>}>
      <div className="stack compact-stack">
        <PageHeader title={title} subtitle={subtitle} />
        <FilterBar>
          <SearchInput value={query} onChange={setQuery} placeholder={`Search ${title.toLowerCase()}...`} />
          <button className="btn ghost" onClick={() => setReloadKey((k) => k + 1)}>Refresh</button>
        </FilterBar>
        <section className="panel stack compact-stack">
          <h3>Create {title.replace(/s$/, "")}</h3>
          <textarea
            className="input"
            style={{ minHeight: 96 }}
            value={createPayload}
            onChange={(event) => setCreatePayload(event.target.value)}
            placeholder='{"name":"Sample"}'
          />
          <div className="row-actions">
            <ScopedActionButton
              className="btn"
              onClick={async () => {
                try {
                  const payload = JSON.parse(createPayload) as Record<string, unknown>;
                  await createPbxResource(resource, payload);
                  setMessage(`${title} item created.`);
                  setError("");
                  setReloadKey((k) => k + 1);
                } catch (e: any) {
                  setError(e?.message || "Create failed.");
                }
              }}
            >
              Create
            </ScopedActionButton>
          </div>
          {message ? <div className="chip success">{message}</div> : null}
          {error ? <div className="chip danger">{error}</div> : null}
        </section>
        <section className="panel">
          {state.status === "loading" ? <LoadingSkeleton rows={6} /> : null}
          {state.status === "error" ? <ErrorState message={state.error} /> : null}
          {state.status === "success" && rows.length === 0 ? (
            <EmptyState title={`No ${title.toLowerCase()} found`} message="No data returned from VitalPBX for this module yet." />
          ) : null}
          {state.status === "success" && rows.length > 0 && columns.length > 0 ? (
            <DataTable columns={columns as any} rows={rows.map((row) => ({ ...row, id: row.__id })) as any} />
          ) : null}
        </section>
      </div>
    </PermissionGate>
  );
}
