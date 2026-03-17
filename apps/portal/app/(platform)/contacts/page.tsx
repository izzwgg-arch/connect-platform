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
import { ScopeBadge } from "../../../components/ScopeBadge";
import { SearchInput } from "../../../components/SearchInput";
import { ScopeActionGuard } from "../../../components/ScopeActionGuard";
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { apiPost } from "../../../services/apiClient";
import { loadContacts, type ContactRow } from "../../../services/platformData";

function AddContactModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    displayName: "", primaryPhone: "", primaryEmail: "", companyName: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function set(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));
  }

  async function handleSave() {
    if (!form.displayName.trim() && !form.primaryPhone.trim()) {
      setError("Name or phone number is required.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await apiPost("/customers", form);
      onSaved();
      onClose();
    } catch (e: any) {
      setError(e?.message || "Failed to create contact.");
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="panel" style={{ width: 420, maxWidth: "96vw" }}>
        <div className="panel-head">
          <h3>Add Contact</h3>
          <button className="btn ghost" onClick={onClose} disabled={saving}>×</button>
        </div>
        <div className="form-grid">
          <div className="form-field" style={{ gridColumn: "1 / -1" }}>
            <label className="label">Display Name</label>
            <input className="input" value={form.displayName} onChange={set("displayName")} autoFocus />
          </div>
          <div className="form-field">
            <label className="label">Phone Number</label>
            <input className="input" value={form.primaryPhone} onChange={set("primaryPhone")} type="tel" />
          </div>
          <div className="form-field">
            <label className="label">Email</label>
            <input className="input" value={form.primaryEmail} onChange={set("primaryEmail")} type="email" />
          </div>
          <div className="form-field" style={{ gridColumn: "1 / -1" }}>
            <label className="label">Company</label>
            <input className="input" value={form.companyName} onChange={set("companyName")} />
          </div>
        </div>
        {error ? <div className="chip danger" style={{ marginTop: 10 }}>{error}</div> : null}
        <div className="row-actions" style={{ marginTop: 14 }}>
          <button className="btn ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn" onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

function ContactDrawer({ contact, onClose }: { contact: ContactRow; onClose: () => void }) {
  const { adminScope } = useAppContext();
  // Try to initiate a call via the SIP phone
  function callContact() {
    if (!contact.number || contact.number === "-") return;
    const phoneEl = document.querySelector<HTMLInputElement>("[data-dialpad-input]");
    if (phoneEl) {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      nativeInputValueSetter?.call(phoneEl, contact.number);
      phoneEl.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  return (
    <div
      style={{
        position: "fixed", right: 0, top: 0, bottom: 0, width: 360,
        background: "var(--surface-1)", borderLeft: "1px solid var(--border)",
        zIndex: 150, padding: 24, overflowY: "auto",
        boxShadow: "-4px 0 24px rgba(0,0,0,0.2)",
      }}
    >
      <div className="panel-head" style={{ marginBottom: 20 }}>
        <h3>Contact</h3>
        <button className="btn ghost" onClick={onClose}>×</button>
      </div>
      <div className="stack">
        <div style={{ textAlign: "center", paddingBottom: 16, borderBottom: "1px solid var(--border)" }}>
          <div style={{
            width: 56, height: 56, borderRadius: "50%",
            background: "var(--accent)", color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 22, fontWeight: 700, margin: "0 auto 10px",
          }}>
            {(contact.name || "?")[0].toUpperCase()}
          </div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{contact.name}</div>
          {contact.company && contact.company !== "-" ? (
            <div className="muted" style={{ fontSize: 13 }}>{contact.company}</div>
          ) : null}
        </div>
        <div className="compact-stack">
          {contact.number && contact.number !== "-" ? (
            <div>
              <div className="label">Phone</div>
              <div style={{ fontFamily: "monospace", fontSize: 14 }}>{contact.number}</div>
            </div>
          ) : null}
          {contact.email && contact.email !== "-" ? (
            <div>
              <div className="label">Email</div>
              <div style={{ fontSize: 14 }}>{contact.email}</div>
            </div>
          ) : null}
          {contact.tags ? (
            <div>
              <div className="label">Tags</div>
              <div style={{ fontSize: 13 }}>{contact.tags}</div>
            </div>
          ) : null}
        </div>
        {contact.number && contact.number !== "-" ? (
          <ScopeActionGuard>
            {({ disabled }) => (
              <button className="btn" onClick={callContact} disabled={disabled}>
                Call {contact.number}
              </button>
            )}
          </ScopeActionGuard>
        ) : null}
      </div>
    </div>
  );
}

export default function ContactsPage() {
  const { adminScope } = useAppContext();
  const isGlobal = adminScope === "GLOBAL";
  const [query, setQuery] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [showAdd, setShowAdd] = useState(false);
  const [selected, setSelected] = useState<ContactRow | null>(null);
  const state = useAsyncResource(() => loadContacts(query, adminScope), [query, adminScope, reloadKey]);
  const contacts = useMemo(() => (state.status === "success" ? state.data.rows : []), [state]);

  if (state.status === "loading") return <LoadingSkeleton rows={8} />;
  if (state.status === "error") return <ErrorState message={state.error} />;

  return (
    <PermissionGate permission="can_view_contacts" fallback={<div className="state-box">You do not have contacts access.</div>}>
      <div className="stack">
        <PageHeader
          title="Contacts"
          subtitle={`Unified contacts for call, SMS, and CRM activities (${state.data.scopeLabel.toLowerCase()} scope).`}
          badges={<ScopeBadge scope={state.data.scopeLabel} />}
        />
        {isGlobal ? <GlobalScopeNotice /> : null}
        <FilterBar>
          <SearchInput value={query} onChange={setQuery} placeholder="Search contacts..." />
          <ScopeActionGuard>
            {({ disabled }) => (
              <button className="btn" onClick={() => !disabled && setShowAdd(true)} disabled={disabled}>
                Add Contact
              </button>
            )}
          </ScopeActionGuard>
        </FilterBar>
        {contacts.length === 0 ? (
          <EmptyState title="No contacts found" message="Try a different search or add a new contact." />
        ) : (
          <DataTable
            rows={contacts}
            columns={[
              { key: "name",    label: "Name",    render: (r) => <span style={{ fontWeight: 600 }}>{r.name}</span> },
              { key: "company", label: "Company", render: (r) => r.company },
              { key: "number",  label: "Phone",   render: (r) => <span style={{ fontFamily: "monospace" }}>{r.number}</span> },
              { key: "email",   label: "Email",   render: (r) => r.email },
              { key: "tags",    label: "Tags",    render: (r) => r.tags },
              {
                key: "act",
                label: "",
                render: (r) => (
                  <button
                    className="btn ghost"
                    style={{ fontSize: 12, padding: "3px 10px" }}
                    onClick={(e) => { e.stopPropagation(); setSelected(r); }}
                  >
                    View
                  </button>
                ),
              },
            ]}
          />
        )}
      </div>

      {showAdd ? (
        <AddContactModal
          onClose={() => setShowAdd(false)}
          onSaved={() => setReloadKey((k) => k + 1)}
        />
      ) : null}

      {selected ? (
        <ContactDrawer contact={selected} onClose={() => setSelected(null)} />
      ) : null}
    </PermissionGate>
  );
}
