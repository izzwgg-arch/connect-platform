"use client";

/**
 * DID Routing — shared-entry architecture.
 *
 * Every inbound DID is a row here. Admins pick the tenant, the active IVR
 * profile, the active MOH/hold profile, and an optional hold announcement,
 * then Publish. Publish writes to AstDB and (if PBX_INBOUND_API is on)
 * upserts the VitalPBX inbound route via REST — zero manual PBX edits per
 * DID after the one-time Asterisk install.
 *
 * Design notes:
 *   - Call path stays 100% on-PBX at live-call time. This page talks only to
 *     Connect; the only moving parts on the PBX are AstDB keys (cheap reads).
 *   - Tenant selection is scoped: super-admins see every tenant; tenant admins
 *     are pinned to their own tenantId by the API.
 *   - IVR / MOH profile dropdowns are filtered to the selected tenant so a
 *     tenant admin can't accidentally point their DID at another tenant's
 *     greeting. The API enforces the same rule.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useAppContext } from "../../../../hooks/useAppContext";
import { apiGet, apiPost, apiPatch, apiDelete } from "../../../../services/apiClient";

// ── Types ─────────────────────────────────────────────────────────────────────

type FallbackBehavior = "default_ivr" | "terminate" | "voicemail";

interface IvrProfileLite { id: string; name: string; type: string }
interface MohProfileLite { id: string; name: string; vitalPbxMohClassName: string }

interface DidMapping {
  id: string;
  tenantId: string;
  e164: string;
  phoneNumberId: string | null;
  pbxInstanceId: string | null;
  pbxInboundRouteId: string | null;
  ivrProfileId: string | null;
  mohProfileId: string | null;
  holdAnnouncePromptRef: string | null;
  holdRepeatSec: number;
  fallbackBehavior: FallbackBehavior;
  enabled: boolean;
  lastPublishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  ivrProfile: IvrProfileLite | null;
  mohProfile: MohProfileLite | null;
  tenant: { id: string; name: string } | null;
  // ── Takeover state (added for DID route takeover) ──
  routingMode?: "pbx" | "connect";
  originalPbxDestinationType?: string | null;
  originalPbxDestination?: string | null;
  originalPbxChannelVariables?: Record<string, unknown> | null;
  originalCapturedAt?: string | null;
  lastSwitchedAt?: string | null;
  lastSwitchedBy?: string | null;
  lastSwitchError?: string | null;
}

// Response shape from GET /voice/did/:id/inspect — live PBX state + drift flag.
interface InspectResponse {
  ok: true;
  mapping: DidMapping;
  pbxLive: {
    destination_type: string | null;
    destination: string | null;
    channel_variables: Record<string, unknown> | null;
    description: string | null;
  } | null;
  pbxFetchError: string | null;
  driftDetected: boolean;
  driftReason: string | null;
}

interface PreviewResponse {
  ok: true;
  e164: string;
  tenantSlug: string;
  mapping: DidMapping;
  live: {
    tenant: string;
    profileId: string;
    mohClass: string;
    holdAnnounce: string;
    holdRepeat: string;
  };
}

interface PublishHistoryRow {
  id: string;
  publishedAt: string;
  mode: string;
  status: string;
  isRollback: boolean;
  error: string | null;
}

// ── Small styles (match existing PBX pages for consistency) ──────────────────

const card: React.CSSProperties = {
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 10,
  padding: "18px 22px",
};

const inputStyle: React.CSSProperties = {
  background: "rgba(0,0,0,0.25)",
  border: "1px solid rgba(255,255,255,0.12)",
  color: "#f1f5f9",
  padding: "7px 10px",
  borderRadius: 6,
  fontSize: 13,
  minWidth: 140,
};

const buttonPrimary: React.CSSProperties = {
  background: "#6366f1",
  border: "none",
  color: "#fff",
  padding: "8px 16px",
  borderRadius: 6,
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 13,
};

const buttonSecondary: React.CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.15)",
  color: "#e2e8f0",
  padding: "7px 14px",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
};

const buttonDanger: React.CSSProperties = { ...buttonSecondary, color: "#fca5a5", borderColor: "rgba(239,68,68,0.4)" };

// ── Main page ─────────────────────────────────────────────────────────────────

export default function DidRoutingPage() {
  const { tenantId, tenants, can, role } = useAppContext();
  const isSuper = role === "SUPER_ADMIN";

  const canManage = can("can_manage_did_routing");
  const canPublish = can("can_publish_did_routing");

  const [mappings, setMappings] = useState<DidMapping[]>([]);
  const [ivrProfiles, setIvrProfiles] = useState<IvrProfileLite[]>([]);
  const [mohProfiles, setMohProfiles] = useState<MohProfileLite[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);

  // Per-row takeover state: which row is expanded, its inspect payload, and
  // an in-flight busy flag so we can disable buttons during switch.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [inspectByMapping, setInspectByMapping] = useState<Record<string, InspectResponse | null>>({});
  const [inspectLoading, setInspectLoading] = useState<string | null>(null);

  // Capabilities flag: when PBX_INBOUND_API is off, the Take-over / Restore
  // buttons can't succeed — we surface a banner so super-admins know why.
  const [capabilities, setCapabilities] = useState<{ inboundApiEnabled: boolean; howToEnable: string | null } | null>(null);
  useEffect(() => {
    apiGet<{ ok: true; inboundApiEnabled: boolean; howToEnable: string | null }>("/voice/did/capabilities")
      .then((res) => setCapabilities({ inboundApiEnabled: !!res.inboundApiEnabled, howToEnable: res.howToEnable ?? null }))
      .catch(() => setCapabilities(null));
  }, []);

  // Add-form state (only rendered when canManage).
  const [addE164, setAddE164] = useState("");
  const [addTenantId, setAddTenantId] = useState(tenantId ?? "");
  const [addIvrId, setAddIvrId] = useState<string>("");
  const [addMohId, setAddMohId] = useState<string>("");

  // Scope tenant for the Add-form's IVR/MOH dropdowns. Super-admins drive this
  // via the tenant <select>; tenant-admins are pinned to their own tenantId.
  const scopeTenantId = isSuper ? (addTenantId || tenantId || "") : (tenantId || "");

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Mappings list: tenant-admin = scoped; super-admin = unscoped (all tenants).
      const qs = tenantId && !isSuper ? `?tenantId=${encodeURIComponent(tenantId)}` : "";
      const m = await apiGet<{ mappings: DidMapping[] }>(`/voice/did/mappings${qs}`);
      setMappings(m.mappings ?? []);

      // IVR + MOH profile dropdowns load against the *scope* tenant so the
      // super-admin can pick any tenant first and see its options. Backend
      // still enforces cross-tenant rules at create/update time.
      if (scopeTenantId) {
        const [p, h] = await Promise.allSettled([
          apiGet<{ profiles: IvrProfileLite[] }>(`/voice/ivr/route-profiles?tenantId=${encodeURIComponent(scopeTenantId)}`),
          apiGet<{ profiles: MohProfileLite[] }>(`/voice/moh/profiles?tenantId=${encodeURIComponent(scopeTenantId)}`),
        ]);
        if (p.status === "fulfilled") setIvrProfiles(p.value.profiles ?? []);
        else setIvrProfiles([]);
        if (h.status === "fulfilled") setMohProfiles(h.value.profiles ?? []);
        else setMohProfiles([]);
      } else {
        setIvrProfiles([]);
        setMohProfiles([]);
      }
    } catch (e: any) {
      setError(e?.message ?? "Failed to load DID mappings");
    } finally {
      setLoading(false);
    }
  }, [tenantId, isSuper, scopeTenantId]);

  useEffect(() => { reload(); }, [reload]);

  const create = useCallback(async () => {
    if (!addE164.trim()) { setError("Phone number is required"); return; }
    const targetTenantId = addTenantId || tenantId;
    if (!targetTenantId) { setError("Tenant is required"); return; }
    setBusy("create");
    setError(null);
    try {
      await apiPost(`/voice/did/mappings`, {
        tenantId: targetTenantId,
        e164: addE164.trim(),
        ivrProfileId: addIvrId || null,
        mohProfileId: addMohId || null,
      });
      setAddE164("");
      setAddIvrId("");
      setAddMohId("");
      await reload();
    } catch (e: any) {
      setError(e?.message ?? "Failed to create mapping");
    } finally { setBusy(null); }
  }, [addE164, addTenantId, tenantId, addIvrId, addMohId, reload]);

  const updateField = useCallback(async (id: string, patch: Partial<DidMapping>) => {
    setBusy(id);
    setError(null);
    try {
      await apiPatch(`/voice/did/mappings/${id}`, patch);
      await reload();
    } catch (e: any) {
      setError(e?.message ?? "Failed to update mapping");
    } finally { setBusy(null); }
  }, [reload]);

  const publish = useCallback(async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await apiPost(`/voice/did/publish`, { mappingId: id });
      await reload();
    } catch (e: any) {
      setError(e?.message ?? "Publish failed");
    } finally { setBusy(null); }
  }, [reload]);

  const remove = useCallback(async (id: string, hard: boolean) => {
    if (!confirm(hard ? "Permanently delete this DID mapping? (row is gone)" : "Disable this DID mapping? (row kept for audit)"))
      return;
    setBusy(id);
    try {
      await apiDelete(`/voice/did/mappings/${id}${hard ? "?hard=1" : ""}`);
      await reload();
    } catch (e: any) {
      setError(e?.message ?? "Delete failed");
    } finally { setBusy(null); }
  }, [reload]);

  const loadPreview = useCallback(async (e164: string) => {
    try {
      const p = await apiGet<PreviewResponse>(`/voice/did/${encodeURIComponent(e164)}/preview`);
      setPreview(p);
    } catch (e: any) {
      setError(e?.message ?? "Preview failed");
    }
  }, []);

  const rollback = useCallback(async (e164: string) => {
    try {
      // Find most recent successful publish for this DID in history and roll it back.
      const hist = await apiGet<{ records: PublishHistoryRow[] }>(
        `/voice/ivr/publish-history?tenantId=${encodeURIComponent(tenantId ?? "")}&limit=50`,
      );
      const target = (hist.records ?? []).find(
        (r) => r.mode === "did" && r.status === "success" && !r.isRollback,
      );
      if (!target) { setError("No prior DID publish found to roll back to"); return; }
      if (!confirm(`Roll back DID ${e164} to publish from ${new Date(target.publishedAt).toLocaleString()}?`)) return;
      await apiPost(`/voice/did/rollback/${target.id}`, {});
      await reload();
    } catch (e: any) {
      setError(e?.message ?? "Rollback failed");
    }
  }, [tenantId, reload]);

  // ── DID takeover actions (Phase 4 UI wiring) ───────────────────────────────
  // Run GET /voice/did/:id/inspect and stash the result under inspectByMapping.
  // Called on expand and after every successful switch so the row's panel
  // always reflects the most recent live PBX state.
  const loadInspect = useCallback(async (id: string) => {
    setInspectLoading(id);
    try {
      const res = await apiGet<InspectResponse>(`/voice/did/${encodeURIComponent(id)}/inspect`);
      setInspectByMapping((prev) => ({ ...prev, [id]: res }));
    } catch (e: any) {
      setInspectByMapping((prev) => ({ ...prev, [id]: null }));
      setError(e?.message ?? "Inspect failed");
    } finally {
      setInspectLoading(null);
    }
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setExpandedId((cur) => {
      const next = cur === id ? null : id;
      if (next && !inspectByMapping[next]) void loadInspect(next);
      return next;
    });
  }, [inspectByMapping, loadInspect]);

  const switchToConnect = useCallback(async (m: DidMapping) => {
    if (!m.ivrProfileId) {
      setError("Assign an IVR profile to this DID before switching to Connect IVR.");
      return;
    }
    const live = inspectByMapping[m.id]?.pbxLive;
    const currentDest = live ? `${live.destination_type ?? "?"} → ${live.destination ?? "?"}` : "(unknown current PBX destination)";
    if (!confirm(
      `Take over ${m.e164}?\n\n` +
      `Current PBX destination:\n  ${currentDest}\n\n` +
      `After: the PBX will enter [connect-tenant-ivr] for this DID and Connect's IVR profile "${m.ivrProfile?.name ?? "?"}" will answer.\n\n` +
      `The original PBX destination is saved and can be restored at any time.`,
    )) return;
    setBusy(m.id);
    setError(null);
    try {
      await apiPost(`/voice/did/${encodeURIComponent(m.id)}/switch-to-connect`, {});
      await reload();
      await loadInspect(m.id);
    } catch (e: any) {
      setError(e?.message ?? "Switch to Connect failed");
    } finally { setBusy(null); }
  }, [inspectByMapping, reload, loadInspect]);

  const switchToPbx = useCallback(async (m: DidMapping) => {
    if (!m.originalPbxDestination || !m.originalPbxDestinationType) {
      setError("Connect has no stored pre-takeover destination for this DID. Use Override restore (not yet exposed in this UI) or contact support.");
      return;
    }
    const target = `${m.originalPbxDestinationType} → ${m.originalPbxDestination}`;
    if (!confirm(
      `Restore ${m.e164} to the PBX?\n\n` +
      `Target (captured ${m.originalCapturedAt ? new Date(m.originalCapturedAt).toLocaleString() : "at takeover"}):\n  ${target}\n\n` +
      `Connect will stop answering this DID and the PBX takes over again.`,
    )) return;
    setBusy(m.id);
    setError(null);
    try {
      await apiPost(`/voice/did/${encodeURIComponent(m.id)}/switch-to-pbx`, {});
      await reload();
      await loadInspect(m.id);
    } catch (e: any) {
      setError(e?.message ?? "Restore to PBX failed");
    } finally { setBusy(null); }
  }, [reload, loadInspect]);

  const tenantsInTable = useMemo(() => {
    const s = new Set<string>();
    for (const m of mappings) s.add(m.tenant?.name ?? m.tenantId);
    return [...s];
  }, [mappings]);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: "24px 32px", minHeight: "100vh", color: "var(--text-primary, #f1f5f9)" }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: -0.5 }}>DID Routing</h1>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-muted, #94a3b8)" }}>
          Per-number routing: pick the tenant, the IVR profile, and the hold profile — publish to VitalPBX in one click.
        </p>
        <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--text-muted, #94a3b8)" }}>
          {mappings.length} mapping{mappings.length === 1 ? "" : "s"} across {tenantsInTable.length} tenant{tenantsInTable.length === 1 ? "" : "s"}.
        </p>
      </div>

      {error && (
        <div style={{
          background: "rgba(239,68,68,0.1)", border: "1px solid #ef4444",
          borderRadius: 8, padding: "10px 16px", marginBottom: 20, fontSize: 13, color: "#fca5a5",
        }}>
          {error}
          <button onClick={() => setError(null)} style={{ ...buttonSecondary, marginLeft: 12, fontSize: 11 }}>dismiss</button>
        </div>
      )}

      {/* Super-admin warning when the PBX inbound-numbers REST API is disabled
          — without it, Take-over and Restore cannot mutate VitalPBX. Hidden
          for tenant-admins who can't fix it anyway. */}
      {isSuper && capabilities && !capabilities.inboundApiEnabled && (
        <div style={{
          background: "rgba(250,204,21,0.08)", border: "1px solid rgba(250,204,21,0.35)",
          borderRadius: 8, padding: "10px 16px", marginBottom: 20, fontSize: 13, color: "#fde68a",
        }}>
          <strong>Takeover disabled:</strong> VitalPBX inbound-numbers REST API is currently off on this Connect deployment.
          Take-over and Restore buttons will return an error until it's turned on.
          {capabilities.howToEnable && (
            <div style={{ marginTop: 4, fontSize: 12, color: "#fef9c3" }}>{capabilities.howToEnable}</div>
          )}
        </div>
      )}

      {/* Add mapping */}
      {canManage && (
        <div style={{ ...card, marginBottom: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Add a DID mapping</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <input
              type="tel"
              placeholder="+18005551212"
              value={addE164}
              onChange={(e) => setAddE164(e.target.value)}
              style={{ ...inputStyle, minWidth: 180 }}
            />
            {isSuper && (
              <select
                value={addTenantId}
                onChange={(e) => setAddTenantId(e.target.value)}
                style={{ ...inputStyle, minWidth: 220 }}
                title="Tenant this DID belongs to"
              >
                <option value="">— Select tenant —</option>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            )}
            <select value={addIvrId} onChange={(e) => setAddIvrId(e.target.value)} style={inputStyle} disabled={!scopeTenantId}>
              <option value="">— No IVR —</option>
              {ivrProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select value={addMohId} onChange={(e) => setAddMohId(e.target.value)} style={inputStyle} disabled={!scopeTenantId}>
              <option value="">— PBX default MOH —</option>
              {mohProfiles.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.vitalPbxMohClassName})</option>)}
            </select>
            <button onClick={create} disabled={busy === "create" || !scopeTenantId} style={buttonPrimary}>
              {busy === "create" ? "Creating…" : "Add mapping"}
            </button>
          </div>

          {/* Empty-state guidance. Missing IVR/MOH profiles is by far the most
              common reason the Add-form looks broken: the picks exist but the
              tenant has no profiles configured yet. Point admins at the right
              page rather than letting them stare at a blank dropdown. */}
          {scopeTenantId && !loading && (ivrProfiles.length === 0 || mohProfiles.length === 0) && (
            <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 8, background: "rgba(250,204,21,0.08)", border: "1px solid rgba(250,204,21,0.25)", fontSize: 12, color: "#fde68a" }}>
              {ivrProfiles.length === 0 && (
                <div>No IVR profiles for this tenant yet — create one on <a href="/pbx/ivr-routing" style={{ color: "#facc15" }}>IVR Routing</a>.</div>
              )}
              {mohProfiles.length === 0 && (
                <div>No Hold profiles for this tenant yet — create one on <a href="/pbx/moh-scheduling" style={{ color: "#facc15" }}>MOH Scheduling</a>.</div>
              )}
            </div>
          )}

          <p style={{ margin: "10px 0 0", fontSize: 11, color: "var(--text-muted, #94a3b8)" }}>
            Adding a mapping does not change live routing — click <strong>Publish</strong> on its row to push the state to Asterisk and VitalPBX.
          </p>
        </div>
      )}

      {/* Mappings table */}
      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "rgba(255,255,255,0.03)", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
              <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600, color: "#cbd5e1", width: 30 }}></th>
              <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600, color: "#cbd5e1" }}>DID</th>
              <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600, color: "#cbd5e1" }}>Tenant</th>
              <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600, color: "#cbd5e1" }}>Mode</th>
              <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600, color: "#cbd5e1" }}>IVR Profile</th>
              <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600, color: "#cbd5e1" }}>Hold Profile</th>
              <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600, color: "#cbd5e1" }}>Status</th>
              <th style={{ textAlign: "right", padding: "10px 14px", fontWeight: 600, color: "#cbd5e1" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={8} style={{ padding: 18, textAlign: "center", color: "#94a3b8" }}>Loading…</td></tr>
            )}
            {!loading && mappings.length === 0 && (
              <tr><td colSpan={8} style={{ padding: 18, textAlign: "center", color: "#94a3b8" }}>
                No DID mappings yet. {canManage ? "Add one above to get started." : "Ask an admin to add one."}
              </td></tr>
            )}
            {mappings.map((m) => {
              const mode = (m.routingMode ?? "pbx") as "pbx" | "connect";
              const isExpanded = expandedId === m.id;
              const inspect = inspectByMapping[m.id];
              return (
              <Fragment key={m.id}>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                <td style={{ padding: "10px 6px 10px 14px", verticalAlign: "middle" }}>
                  <button
                    onClick={() => toggleExpand(m.id)}
                    style={{ ...buttonSecondary, padding: "3px 8px", fontSize: 11, minWidth: 24 }}
                    title={isExpanded ? "Collapse" : "Show takeover details"}
                  >{isExpanded ? "▾" : "▸"}</button>
                </td>
                <td style={{ padding: "10px 14px", fontFamily: "monospace" }}>{m.e164}</td>
                <td style={{ padding: "10px 14px" }}>{m.tenant?.name ?? m.tenantId}</td>
                <td style={{ padding: "10px 14px" }}>
                  <ModeBadge mode={mode} />
                </td>
                <td style={{ padding: "10px 14px" }}>
                  {canManage ? (
                    <select
                      value={m.ivrProfileId ?? ""}
                      disabled={busy === m.id}
                      onChange={(e) => updateField(m.id, { ivrProfileId: e.target.value || null })}
                      style={{ ...inputStyle, minWidth: 180 }}
                    >
                      <option value="">— No IVR —</option>
                      {ivrProfiles
                        .filter((p) => p.id === m.ivrProfileId || true /* show all; API validates tenant */)
                        .map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  ) : (m.ivrProfile?.name ?? "—")}
                </td>
                <td style={{ padding: "10px 14px" }}>
                  {canManage ? (
                    <select
                      value={m.mohProfileId ?? ""}
                      disabled={busy === m.id}
                      onChange={(e) => updateField(m.id, { mohProfileId: e.target.value || null })}
                      style={{ ...inputStyle, minWidth: 180 }}
                    >
                      <option value="">— PBX default —</option>
                      {mohProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  ) : (m.mohProfile?.name ?? "—")}
                </td>
                <td style={{ padding: "10px 14px" }}>
                  {m.enabled ? (
                    <span style={{ color: "#22c55e" }}>● Enabled</span>
                  ) : (
                    <span style={{ color: "#ef4444" }}>● Disabled</span>
                  )}
                  {m.lastPublishedAt && (
                    <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
                      Published {new Date(m.lastPublishedAt).toLocaleString()}
                    </div>
                  )}
                </td>
                <td style={{ padding: "10px 14px", textAlign: "right" }}>
                  <div style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <button
                      onClick={() => loadPreview(m.e164)}
                      style={buttonSecondary}
                      disabled={busy === m.id}
                    >Preview</button>
                    {canPublish && mode === "pbx" && (
                      <button
                        onClick={() => switchToConnect(m)}
                        style={buttonPrimary}
                        disabled={busy === m.id || !m.ivrProfileId}
                        title={!m.ivrProfileId ? "Assign an IVR profile first" : "Point this DID at Connect IVR"}
                      >{busy === m.id ? "…" : "Take over"}</button>
                    )}
                    {canPublish && mode === "connect" && (
                      <button
                        onClick={() => switchToPbx(m)}
                        style={{ ...buttonPrimary, background: "#334155" }}
                        disabled={busy === m.id || !m.originalPbxDestination}
                        title={!m.originalPbxDestination ? "No captured original PBX destination" : "Restore original PBX destination"}
                      >{busy === m.id ? "…" : "Restore PBX"}</button>
                    )}
                    {canPublish && (
                      <button
                        onClick={() => publish(m.id)}
                        style={buttonSecondary}
                        disabled={busy === m.id}
                        title="Re-publish AstDB keys (tenant/profile/MOH) for this DID"
                      >Republish</button>
                    )}
                    {canPublish && (
                      <button onClick={() => rollback(m.e164)} style={buttonSecondary}>Rollback</button>
                    )}
                    {canManage && (
                      <button onClick={() => remove(m.id, false)} style={buttonDanger}>Disable</button>
                    )}
                  </div>
                </td>
              </tr>
              {isExpanded && (
                <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.05)", background: "rgba(255,255,255,0.015)" }}>
                  <td colSpan={8} style={{ padding: "14px 22px 18px 52px" }}>
                    <TakeoverPanel
                      mapping={m}
                      inspect={inspect ?? null}
                      loading={inspectLoading === m.id}
                      onRefresh={() => loadInspect(m.id)}
                    />
                  </td>
                </tr>
              )}
              </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Preview panel */}
      {preview && (
        <div style={{ ...card, marginTop: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Live routing for {preview.e164}</div>
            <button onClick={() => setPreview(null)} style={buttonSecondary}>Close</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, fontSize: 12 }}>
            <div>
              <div style={{ color: "#94a3b8", marginBottom: 4 }}>Configured (Connect)</div>
              <div>Tenant: <strong>{preview.mapping.tenant?.name ?? preview.mapping.tenantId}</strong></div>
              <div>IVR: {preview.mapping.ivrProfile?.name ?? "—"}</div>
              <div>Hold profile: {preview.mapping.mohProfile?.name ?? "—"}</div>
              <div>Hold announce: {preview.mapping.holdAnnouncePromptRef || "—"}</div>
              <div>Repeat: {preview.mapping.holdRepeatSec}s</div>
            </div>
            <div>
              <div style={{ color: "#94a3b8", marginBottom: 4 }}>Live (AstDB)</div>
              <div>tenant: <code>{preview.live.tenant || "(unset)"}</code></div>
              <div>profile_id: <code>{preview.live.profileId || "(unset)"}</code></div>
              <div>moh_class: <code>{preview.live.mohClass || "(unset)"}</code></div>
              <div>hold_announce: <code>{preview.live.holdAnnounce || "(unset)"}</code></div>
              <div>hold_repeat: <code>{preview.live.holdRepeat || "(unset)"}</code></div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Helper components ────────────────────────────────────────────────────────

// Tiny pill that reflects routingMode: green for Connect-owned, slate for PBX.
// Kept intentionally plain — no icons or animation — to match the surrounding
// table density and avoid drawing the eye away from the Actions column.
function ModeBadge({ mode }: { mode: "pbx" | "connect" }) {
  const isConnect = mode === "connect";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 9px",
        borderRadius: 10,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.3,
        textTransform: "uppercase",
        background: isConnect ? "rgba(34,197,94,0.12)" : "rgba(100,116,139,0.15)",
        border: `1px solid ${isConnect ? "rgba(34,197,94,0.4)" : "rgba(148,163,184,0.35)"}`,
        color: isConnect ? "#86efac" : "#cbd5e1",
      }}
      title={isConnect ? "Connect has taken over this DID's routing" : "Routing still controlled by VitalPBX"}
    >
      {isConnect ? "Connect IVR" : "PBX"}
    </span>
  );
}

// Expanded row panel: side-by-side view of the stored "original PBX destination"
// snapshot (taken at takeover time) and the live VitalPBX state right now.
// Drift (red/yellow box at top) means somebody edited the PBX route outside
// of Connect while Connect "owned" it — the live state no longer matches what
// we'd restore to. The operator can refresh to re-read live state.
function TakeoverPanel({
  mapping,
  inspect,
  loading,
  onRefresh,
}: {
  mapping: DidMapping;
  inspect: InspectResponse | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const col: React.CSSProperties = {
    background: "rgba(0,0,0,0.18)",
    border: "1px solid rgba(255,255,255,0.06)",
    borderRadius: 8,
    padding: "12px 14px",
    fontSize: 12,
  };
  const label: React.CSSProperties = { color: "#94a3b8", fontSize: 11, marginBottom: 4 };
  const kv: React.CSSProperties = { margin: "2px 0", wordBreak: "break-all" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0" }}>
          Takeover details — <code style={{ fontFamily: "monospace" }}>{mapping.e164}</code>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          style={{
            background: "transparent",
            border: "1px solid rgba(255,255,255,0.15)",
            color: "#e2e8f0",
            padding: "5px 12px",
            borderRadius: 6,
            cursor: loading ? "wait" : "pointer",
            fontSize: 11,
          }}
        >{loading ? "Reading PBX…" : "Re-read live PBX"}</button>
      </div>

      {mapping.lastSwitchError && (
        <div style={{
          background: "rgba(239,68,68,0.1)",
          border: "1px solid rgba(239,68,68,0.4)",
          borderRadius: 6,
          padding: "8px 12px",
          fontSize: 12,
          color: "#fca5a5",
        }}>
          <strong>Last switch error:</strong> {mapping.lastSwitchError}
        </div>
      )}

      {inspect?.driftDetected && (
        <div style={{
          background: "rgba(250,204,21,0.08)",
          border: "1px solid rgba(250,204,21,0.4)",
          borderRadius: 6,
          padding: "8px 12px",
          fontSize: 12,
          color: "#fde68a",
        }}>
          <strong>Drift detected</strong> — live PBX destination doesn't match what Connect expects for mode
          {" "}<code>{mapping.routingMode ?? "pbx"}</code>.
          {inspect.driftReason && <span> Reason: <code>{inspect.driftReason}</code>.</span>}
          {" "}Somebody may have edited the VitalPBX inbound route outside of Connect.
        </div>
      )}

      {inspect?.pbxFetchError && (
        <div style={{
          background: "rgba(239,68,68,0.08)",
          border: "1px solid rgba(239,68,68,0.3)",
          borderRadius: 6,
          padding: "8px 12px",
          fontSize: 12,
          color: "#fca5a5",
        }}>
          Live PBX read failed: <code>{inspect.pbxFetchError}</code>. Switch actions may not succeed
          until this is resolved.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={col}>
          <div style={label}>Captured original PBX destination</div>
          {mapping.originalPbxDestination ? (
            <>
              <div style={kv}>destination_type: <code>{mapping.originalPbxDestinationType ?? "—"}</code></div>
              <div style={kv}>destination: <code>{mapping.originalPbxDestination ?? "—"}</code></div>
              {mapping.originalPbxChannelVariables && (
                <div style={kv}>
                  channel_variables: <code>{JSON.stringify(mapping.originalPbxChannelVariables)}</code>
                </div>
              )}
              {mapping.originalCapturedAt && (
                <div style={{ ...kv, color: "#94a3b8" }}>
                  Captured {new Date(mapping.originalCapturedAt).toLocaleString()}
                </div>
              )}
            </>
          ) : (
            <div style={{ color: "#94a3b8" }}>
              None — Connect hasn't taken over this DID yet. Capture happens automatically on "Take over".
            </div>
          )}
        </div>

        <div style={col}>
          <div style={label}>Live VitalPBX inbound_number</div>
          {loading && <div style={{ color: "#94a3b8" }}>Reading PBX…</div>}
          {!loading && !inspect && <div style={{ color: "#94a3b8" }}>Not loaded. Click "Re-read live PBX".</div>}
          {!loading && inspect && !inspect.pbxLive && (
            <div style={{ color: "#94a3b8" }}>
              No inbound_number entry found on VitalPBX for {mapping.e164}.
            </div>
          )}
          {!loading && inspect?.pbxLive && (
            <>
              <div style={kv}>destination_type: <code>{inspect.pbxLive.destination_type ?? "—"}</code></div>
              <div style={kv}>destination: <code>{inspect.pbxLive.destination ?? "—"}</code></div>
              {inspect.pbxLive.channel_variables && (
                <div style={kv}>
                  channel_variables: <code>{JSON.stringify(inspect.pbxLive.channel_variables)}</code>
                </div>
              )}
              {inspect.pbxLive.description && (
                <div style={{ ...kv, color: "#94a3b8" }}>
                  description: {inspect.pbxLive.description}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {(mapping.lastSwitchedAt || mapping.lastSwitchedBy) && (
        <div style={{ fontSize: 11, color: "#94a3b8" }}>
          Last switched
          {mapping.lastSwitchedAt ? ` ${new Date(mapping.lastSwitchedAt).toLocaleString()}` : ""}
          {mapping.lastSwitchedBy ? ` by ${mapping.lastSwitchedBy}` : ""}.
        </div>
      )}
    </div>
  );
}
