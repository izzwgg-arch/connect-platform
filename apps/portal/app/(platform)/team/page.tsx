"use client";

import { useMemo, useState } from "react";
import { DataTable } from "../../../components/DataTable";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorState } from "../../../components/ErrorState";
import { FilterBar } from "../../../components/FilterBar";
import { GlobalScopeNotice } from "../../../components/GlobalScopeNotice";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";
import { PresenceBadge } from "../../../components/PresenceBadge";
import { RegistrationBadge } from "../../../components/RegistrationBadge";
import { SearchInput } from "../../../components/SearchInput";
import { ScopedActionButton } from "../../../components/ScopedActionButton";
import { ScopeBadge } from "../../../components/ScopeBadge";
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { loadTeamMembers } from "../../../services/platformData";

export default function TeamPage() {
  const { adminScope } = useAppContext();
  const isGlobal = adminScope === "GLOBAL";
  const teamState = useAsyncResource(() => loadTeamMembers(adminScope), [adminScope]);
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    if (teamState.status !== "success") return [];
    return teamState.data.rows.filter((row) => row.name.toLowerCase().includes(query.toLowerCase()));
  }, [teamState, query]);

  if (teamState.status === "loading") return <LoadingSkeleton rows={8} />;
  if (teamState.status === "error") return <ErrorState message={teamState.error} />;

  return (
    <PermissionGate permission="can_view_team" fallback={<div className="state-box">You do not have team access.</div>}>
      <div className="stack">
      <PageHeader
        title="Team Extensions"
        subtitle={`Scan registration, presence, and call handling quickly (${teamState.status === "success" ? teamState.data.scopeLabel.toLowerCase() : adminScope.toLowerCase()} scope).`}
        badges={<ScopeBadge scope={teamState.status === "success" ? teamState.data.scopeLabel : adminScope} />}
      />
      {isGlobal ? <GlobalScopeNotice /> : null}
      <FilterBar>
        <SearchInput value={query} onChange={setQuery} placeholder="Search by name, ext, role..." />
        <button className="btn ghost">Presence Filter</button>
        <button className="btn ghost">Registration Filter</button>
        <button className="btn ghost">Role Filter</button>
        <ScopedActionButton className="btn">Create Extension</ScopedActionButton>
      </FilterBar>
      {rows.length === 0 ? (
        <EmptyState title="No team members found" message="Try another filter or add a new extension user." />
      ) : (
        <DataTable
          rows={rows}
          columns={[
            { key: "name", label: "Member", render: (r) => <strong>{r.name}</strong> },
            { key: "ext", label: "Extension", render: (r) => r.extension },
            { key: "email", label: "Email", render: (r) => r.email },
            { key: "presence", label: "Presence", render: (r) => <PresenceBadge presence={r.presence} /> },
            { key: "registered", label: "Registration", render: (r) => <RegistrationBadge registered={r.registered} /> },
            { key: "forward", label: "Forwarding", render: (r) => (r.forwarding ? "Active" : "Off") },
            { key: "vm", label: "Voicemail", render: (r) => (r.voicemail ? "Enabled" : "Disabled") },
            {
              key: "actions",
              label: "Actions",
              render: () => <ScopedActionButton className="btn ghost">Manage</ScopedActionButton>
            }
          ]}
        />
      )}
      </div>
    </PermissionGate>
  );
}
