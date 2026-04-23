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

import { useCallback, useEffect, useMemo, useState } from "react";
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
              <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600, color: "#cbd5e1" }}>DID</th>
              <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600, color: "#cbd5e1" }}>Tenant</th>
              <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600, color: "#cbd5e1" }}>IVR Profile</th>
              <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600, color: "#cbd5e1" }}>Hold Profile</th>
              <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600, color: "#cbd5e1" }}>Status</th>
              <th style={{ textAlign: "right", padding: "10px 14px", fontWeight: 600, color: "#cbd5e1" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} style={{ padding: 18, textAlign: "center", color: "#94a3b8" }}>Loading…</td></tr>
            )}
            {!loading && mappings.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 18, textAlign: "center", color: "#94a3b8" }}>
                No DID mappings yet. {canManage ? "Add one above to get started." : "Ask an admin to add one."}
              </td></tr>
            )}
            {mappings.map((m) => (
              <tr key={m.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                <td style={{ padding: "10px 14px", fontFamily: "monospace" }}>{m.e164}</td>
                <td style={{ padding: "10px 14px" }}>{m.tenant?.name ?? m.tenantId}</td>
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
                    {canPublish && (
                      <button
                        onClick={() => publish(m.id)}
                        style={buttonPrimary}
                        disabled={busy === m.id}
                      >{busy === m.id ? "…" : "Publish"}</button>
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
            ))}
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
