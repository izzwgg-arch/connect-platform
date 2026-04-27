"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Plus, Search, UserPlus } from "lucide-react";
import { useAppContext } from "../hooks/useAppContext";
import { useDebouncedValue } from "../hooks/useDebouncedValue";

type TenantSwitcherProps = {
  railMode?: boolean;
};

export function TenantSwitcher({ railMode = false }: TenantSwitcherProps) {
  const { tenants, tenantId, tenant, setTenantId, adminScope, setAdminScope, can } = useAppContext();
  const canSwitch = can("can_switch_tenants");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 200);
  const [highlight, setHighlight] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return q ? tenants.filter((row) => row.name.toLowerCase().includes(q)) : tenants;
  }, [debouncedSearch, tenants]);

  const rowsForKb = useMemo(() => {
    const list: { kind: "global" | "tenant"; id?: string }[] = [];
    if (tenants.length > 0) list.push({ kind: "global" });
    filtered.forEach((t) => list.push({ kind: "tenant", id: t.id }));
    return list;
  }, [filtered, tenants.length]);

  useEffect(() => {
    setHighlight(0);
  }, [open, debouncedSearch]);

  useEffect(() => {
    if (!open) return;
    setHighlight((h) => Math.min(h, Math.max(rowsForKb.length - 1, 0)));
  }, [open, rowsForKb.length]);

  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => panelRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const tenantInitials = useMemo(() => {
    const n = tenant.name.trim();
    if (!n) return "—";
    const parts = n.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0]![0] + parts[1]![0]).toUpperCase();
    return n.slice(0, 2).toUpperCase();
  }, [tenant.name]);

  const displayName =
    adminScope === "GLOBAL" && canSwitch ? "All workspaces" : tenant.name || "Workspace";

  const selectGlobal = useCallback(() => {
    setAdminScope("GLOBAL");
    setOpen(false);
  }, [setAdminScope]);

  const selectTenant = useCallback(
    (id: string) => {
      setAdminScope("TENANT");
      setTenantId(id);
      setOpen(false);
    },
    [setAdminScope, setTenantId]
  );

  const applyKbSelection = useCallback(() => {
    const row = rowsForKb[highlight];
    if (!row) return;
    if (row.kind === "global") selectGlobal();
    else if (row.kind === "tenant" && row.id) selectTenant(row.id);
  }, [highlight, rowsForKb, selectGlobal, selectTenant]);

  const onPanelKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, Math.max(rowsForKb.length - 1, 0)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        applyKbSelection();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    },
    [applyKbSelection, rowsForKb.length]
  );

  const workspaceCard = (
    <div className={`ws-switcher-card ${railMode ? "ws-switcher-card-rail" : ""}`}>
      <div className="ws-switcher-brand">
        <div className="ws-switcher-logo" aria-hidden>
          {tenantInitials}
        </div>
        {!railMode ? (
          <div className="ws-switcher-brand-text">
            <div className="ws-switcher-tenant-name">{displayName}</div>
            <div className="ws-switcher-user-email">Admin</div>
          </div>
        ) : null}
      </div>
    </div>
  );

  if (!canSwitch) {
    return (
      <div className="ws-switcher ws-switcher-static">
        {workspaceCard}
        {!railMode ? <div className="ws-switcher-static-hint">Workspace is fixed for your account.</div> : null}
      </div>
    );
  }

  return (
    <div className={`ws-switcher ${open ? "ws-switcher-open" : ""} ${railMode ? "ws-switcher-rail" : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`ws-switcher-trigger ${railMode ? "ws-switcher-trigger-rail" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <div className="ws-switcher-trigger-inner">
          <div className="ws-switcher-logo ws-switcher-logo-sm" aria-hidden>
            {tenantInitials}
          </div>
          {!railMode ? (
            <div className="ws-switcher-trigger-text">
              <span className="ws-switcher-trigger-tenant">{displayName}</span>
              <span className="ws-switcher-trigger-email">Admin</span>
            </div>
          ) : null}
          {!railMode ? <ChevronDown className="ws-switcher-trigger-chevron" size={16} strokeWidth={2} /> : null}
        </div>
      </button>

      {open ? (
        <div
          ref={panelRef}
          className="ws-switcher-panel"
          role="dialog"
          aria-label="Switch workspace"
          tabIndex={-1}
          onKeyDown={onPanelKeyDown}
        >
          <div className="ws-switcher-panel-inner">
            <div className="ws-switcher-current">
              <div className="ws-switcher-current-label">Current workspace</div>
              <div className="ws-switcher-current-row">
                <div className="ws-switcher-current-name">{displayName}</div>
              </div>
            </div>

            <div className="ws-switcher-search-wrap">
              <Search className="ws-switcher-search-icon" size={16} strokeWidth={2} aria-hidden />
              <input
                className="ws-switcher-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search tenants..."
                autoComplete="off"
              />
            </div>

            <div className="ws-switcher-scroll">
              <div className="ws-switcher-section-label">Your workspaces</div>
              <div
                className="ws-switcher-list"
                role="listbox"
                aria-activedescendant={
                  rowsForKb[highlight] ? `ws-opt-${highlight}` : undefined
                }
              >
                {tenants.length > 0 ? (
                  <button
                    id="ws-opt-0"
                    type="button"
                    role="option"
                    className={`ws-switcher-row ${highlight === 0 ? "is-highlight" : ""} ${adminScope === "GLOBAL" ? "is-active" : ""}`}
                    onClick={selectGlobal}
                    onMouseEnter={() => setHighlight(0)}
                  >
                    <span className="ws-switcher-row-text">
                      <span className="ws-switcher-row-title">All workspaces</span>
                    </span>
                    {adminScope === "GLOBAL" ? <Check className="ws-switcher-check" size={18} strokeWidth={2} /> : null}
                  </button>
                ) : null}

                {filtered.map((row, i) => {
                  const idx = tenants.length > 0 ? i + 1 : i;
                  const active = adminScope === "TENANT" && tenantId === row.id;
                  const hi = highlight === idx;
                  return (
                    <button
                      key={row.id}
                      id={`ws-opt-${idx}`}
                      type="button"
                      role="option"
                      className={`ws-switcher-row ${hi ? "is-highlight" : ""} ${active ? "is-active" : ""}`}
                      onClick={() => selectTenant(row.id)}
                      onMouseEnter={() => setHighlight(idx)}
                    >
                      <span className="ws-switcher-row-text">
                        <span className="ws-switcher-row-title">{row.name}</span>
                      </span>
                      {active ? <Check className="ws-switcher-check" size={18} strokeWidth={2} /> : null}
                    </button>
                  );
                })}

                {filtered.length === 0 && debouncedSearch.trim() ? (
                  <div className="ws-switcher-empty">No tenants match your search.</div>
                ) : null}
                {tenants.length === 0 ? <div className="ws-switcher-empty">No VitalPBX tenants found.</div> : null}
              </div>

              <div className="ws-switcher-divider" />

              <div className="ws-switcher-section-label">Create</div>
              <div className="ws-switcher-actions">
                <Link href="/admin/tenants" className="ws-switcher-action" onClick={() => setOpen(false)}>
                  <Plus size={16} strokeWidth={2} />
                  Create tenant
                </Link>
                <Link href="/admin/tenants" className="ws-switcher-action" onClick={() => setOpen(false)}>
                  <UserPlus size={16} strokeWidth={2} />
                  Join tenant
                </Link>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
