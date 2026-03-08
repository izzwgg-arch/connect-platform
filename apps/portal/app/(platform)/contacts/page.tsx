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
import { ScopedActionButton } from "../../../components/ScopedActionButton";
import { ScopeBadge } from "../../../components/ScopeBadge";
import { SearchInput } from "../../../components/SearchInput";
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { loadContacts } from "../../../services/platformData";

export default function ContactsPage() {
  const { adminScope } = useAppContext();
  const isGlobal = adminScope === "GLOBAL";
  const [query, setQuery] = useState("");
  const state = useAsyncResource(() => loadContacts(query, adminScope), [query, adminScope]);
  const contacts = useMemo(() => (state.status === "success" ? state.data.rows : []), [state]);

  if (state.status === "loading") return <LoadingSkeleton rows={8} />;
  if (state.status === "error") return <ErrorState message={state.error} />;

  return (
    <PermissionGate permission="can_view_contacts" fallback={<div className="state-box">You do not have contacts access.</div>}>
      <div className="stack">
      <PageHeader
        title="Contacts"
        subtitle={`Unified contacts for call, SMS, and CRM activities (${state.status === "success" ? state.data.scopeLabel.toLowerCase() : adminScope.toLowerCase()} scope).`}
        badges={<ScopeBadge scope={state.status === "success" ? state.data.scopeLabel : adminScope} />}
      />
      {isGlobal ? <GlobalScopeNotice /> : null}
      <FilterBar>
        <SearchInput value={query} onChange={setQuery} placeholder="Search contacts..." />
        <button className="btn ghost">Tags</button>
        <button className="btn ghost">Source</button>
        <ScopedActionButton className="btn">Add Contact</ScopedActionButton>
      </FilterBar>
        {contacts.length === 0 ? (
          <EmptyState title="No contacts found" message="Try a different search or create a new contact." />
        ) : (
          <DataTable
            rows={contacts}
            columns={[
              { key: "name", label: "Name", render: (r) => r.name },
              { key: "company", label: "Company", render: (r) => r.company },
              { key: "number", label: "Phone", render: (r) => r.number },
              { key: "email", label: "Email", render: (r) => r.email },
              { key: "tags", label: "Tags", render: (r) => r.tags },
              {
                key: "act",
                label: "Actions",
                render: () => <ScopedActionButton className="btn ghost" allowInGlobal>Open</ScopedActionButton>
              }
            ]}
          />
        )}
      </div>
    </PermissionGate>
  );
}
