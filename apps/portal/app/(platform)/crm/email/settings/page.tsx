"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "../../../../../components/PageHeader";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { apiGet, apiPost, apiDelete } from "../../../../../services/apiClient";

type EmailConnection = {
  connected: boolean;
  provider: string | null;
  emailAddress: string | null;
  displayName: string | null;
  replyTrackingEnabled: boolean;
  bodyCacheMode: "METADATA_ONLY" | "METADATA_WITH_CACHE_30D" | "FULL_RETENTION";
  status: string;
  lastSyncAt?: string | null;
  scopes?: string[];
};

export default function CrmEmailSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [conn, setConn] = useState<EmailConnection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const featureEnabled = useMemo(() => (process.env.NEXT_PUBLIC_CRM_EMAIL_PHASE1_ENABLED || "false").toLowerCase() === "true", []);
  const justConnected = useMemo(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("connected") === "1";
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await apiGet<EmailConnection>("/crm/email/connection");
      setConn(res);
    } catch (e: any) {
      setError(e?.message || "Failed to load connection");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleConnect = async () => {
    setBusy(true); setError(null);
    try {
      const res = await apiPost<{ url: string }>("/crm/email/oauth/start", { bodyCacheMode: "METADATA_ONLY" });
      if (res?.url) {
        window.location.href = res.url;
      }
    } catch (e: any) {
      setError(e?.message || "Failed to start OAuth");
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm("Disconnect your Google account?")) return;
    setBusy(true); setError(null);
    try {
      await apiDelete<{ ok: boolean }>("/crm/email/connection");
      await load();
    } catch (e: any) {
      setError(e?.message || "Failed to disconnect");
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    setBusy(true); setError(null);
    try {
      await apiPost<{ ok: boolean }>("/crm/email/connection/test");
      alert("Test email queued. Check your inbox.");
    } catch (e: any) {
      setError(e?.message || "Failed to queue test email");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack compact-stack">
      <PageHeader title="CRM Email Settings" subtitle="Connect your Google account to send CRM emails as yourself." />

      {!featureEnabled && (
        <section className="panel" style={{ padding: "1.25rem" }}>
          <p style={{ margin: 0, fontSize: "0.875rem", color: "var(--text-dim)" }}>
            CRM Email Phase 1 is not enabled for this environment.
          </p>
        </section>
      )}

      {justConnected && (
        <section className="panel" style={{ padding: "1.25rem", borderLeft: "4px solid var(--accent)" }}>
          <div style={{ fontSize: "0.875rem" }}>Connected successfully.</div>
        </section>
      )}

      <section className="panel" style={{ padding: "1.5rem" }}>
        {loading && <LoadingSkeleton rows={3} />}
        {error && (
          <p style={{ color: "#ef4444", fontSize: "0.875rem", margin: 0 }}>{error}</p>
        )}

        {!loading && conn && (
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 600 }}>Connection</div>
                <div style={{ fontSize: "0.875rem", color: "var(--text-dim)" }}>
                  {conn.connected ? (
                    <>
                      Connected as <strong>{conn.displayName || conn.emailAddress}</strong>
                    </>
                  ) : (
                    <>Not connected</>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                {!conn.connected && (
                  <button className="btn btn-primary" onClick={handleConnect} disabled={busy || !featureEnabled}>
                    Connect Google
                  </button>
                )}
                {conn.connected && (
                  <>
                    <button className="btn btn-secondary" onClick={handleTest} disabled={busy}>Send test</button>
                    <button className="btn btn-ghost" onClick={handleDisconnect} disabled={busy}>Disconnect</button>
                  </>
                )}
              </div>
            </div>

            <div style={{ borderTop: "1px solid var(--border)", paddingTop: "1rem" }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Email Privacy Mode</div>
              <div style={{ fontSize: "0.875rem", color: "var(--text-dim)" }}>
                Metadata + live Gmail fetch (recommended). Connect CRM is not a full inbox archive. It stores CRM-linked email metadata and summaries by default.
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
