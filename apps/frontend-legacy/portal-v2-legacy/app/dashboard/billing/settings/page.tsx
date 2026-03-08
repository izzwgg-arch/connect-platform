"use client";

import { useEffect, useMemo, useState } from "react";
import { canManageBilling, readRoleFromToken } from "../../../../lib/roles";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

type SolaConfigResponse = {
  configured: boolean;
  config: null | {
    isEnabled: boolean;
    apiBaseUrl: string;
    mode: "sandbox" | "prod";
    simulate: boolean;
    authMode: "xkey_body" | "authorization_header";
    authHeaderName: string | null;
    pathOverrides?: Record<string, string | undefined>;
    masked: {
      apiKey: string | null;
      apiSecret: string | null;
      webhookSecret: string | null;
    };
    status: {
      lastTestAt: string | null;
      lastTestResult: string | null;
      lastTestErrorCode: string | null;
    };
    meta: {
      updatedAt: string;
      updatedByUserId: string;
    };
  };
};

export default function BillingSolaSettingsPage() {
  const [role, setRole] = useState("");
  const token = useMemo(() => (typeof window === "undefined" ? "" : localStorage.getItem("token") || ""), []);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [updatingState, setUpdatingState] = useState(false);

  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [configured, setConfigured] = useState(false);
  const [isEnabled, setIsEnabled] = useState(false);
  const [lastTestResult, setLastTestResult] = useState<string | null>(null);
  const [lastTestAt, setLastTestAt] = useState<string | null>(null);
  const [lastTestErrorCode, setLastTestErrorCode] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [updatedByUserId, setUpdatedByUserId] = useState<string | null>(null);

  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [mode, setMode] = useState<"sandbox" | "prod">("sandbox");
  const [simulate, setSimulate] = useState(true);
  const [authMode, setAuthMode] = useState<"xkey_body" | "authorization_header">("xkey_body");
  const [authHeaderName, setAuthHeaderName] = useState("authorization");

  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");

  const [customerPath, setCustomerPath] = useState("");
  const [subscriptionPath, setSubscriptionPath] = useState("");
  const [transactionPath, setTransactionPath] = useState("");
  const [hostedSessionPath, setHostedSessionPath] = useState("");
  const [chargePath, setChargePath] = useState("");
  const [cancelPath, setCancelPath] = useState("");

  const [maskedApiKey, setMaskedApiKey] = useState<string | null>(null);
  const [maskedApiSecret, setMaskedApiSecret] = useState<string | null>(null);
  const [maskedWebhookSecret, setMaskedWebhookSecret] = useState<string | null>(null);

  async function loadConfig() {
    if (!token) return;
    setLoading(true);
    setError("");
    setMessage("");

    const res = await fetch(`${apiBase}/billing/sola/config`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const json = (await res.json().catch(() => null)) as SolaConfigResponse | null;
    if (!res.ok || !json) {
      setError("Failed to load SOLA settings");
      setLoading(false);
      return;
    }

    setConfigured(!!json.configured);
    if (json.config) {
      setApiBaseUrl(json.config.apiBaseUrl || "");
      setMode(json.config.mode || "sandbox");
      setSimulate(!!json.config.simulate);
      setAuthMode(json.config.authMode || "xkey_body");
      setAuthHeaderName(json.config.authHeaderName || "authorization");
      setCustomerPath(json.config.pathOverrides?.customerPath || "");
      setSubscriptionPath(json.config.pathOverrides?.subscriptionPath || "");
      setTransactionPath(json.config.pathOverrides?.transactionPath || "");
      setHostedSessionPath(json.config.pathOverrides?.hostedSessionPath || "");
      setChargePath(json.config.pathOverrides?.chargePath || "");
      setCancelPath(json.config.pathOverrides?.cancelPath || "");

      setIsEnabled(!!json.config.isEnabled);
      setLastTestResult(json.config.status?.lastTestResult || null);
      setLastTestAt(json.config.status?.lastTestAt || null);
      setLastTestErrorCode(json.config.status?.lastTestErrorCode || null);
      setUpdatedAt(json.config.meta?.updatedAt || null);
      setUpdatedByUserId(json.config.meta?.updatedByUserId || null);

      setMaskedApiKey(json.config.masked?.apiKey || null);
      setMaskedApiSecret(json.config.masked?.apiSecret || null);
      setMaskedWebhookSecret(json.config.masked?.webhookSecret || null);
    } else {
      setIsEnabled(false);
      setLastTestResult(null);
      setLastTestAt(null);
      setLastTestErrorCode(null);
      setUpdatedAt(null);
      setUpdatedByUserId(null);
      setMaskedApiKey(null);
      setMaskedApiSecret(null);
      setMaskedWebhookSecret(null);
    }

    setApiKey("");
    setApiSecret("");
    setWebhookSecret("");
    setLoading(false);
  }

  useEffect(() => {
    setRole(readRoleFromToken());
    loadConfig().catch(() => setError("Failed to load SOLA settings"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (role && !canManageBilling(role)) {
    return <div className="card"><h1>Billing SOLA Settings</h1><p>Access denied.</p></div>;
  }

  async function saveConfig() {
    if (!token) return;
    if (!apiBaseUrl.trim()) {
      setError("API base URL is required.");
      return;
    }
    if (mode === "prod" && simulate) {
      setError("Simulate must be disabled in production mode.");
      return;
    }
    setSaving(true);
    setError("");
    setMessage("");

    const payload = {
      apiBaseUrl: apiBaseUrl.trim(),
      mode,
      simulate,
      authMode,
      authHeaderName: authMode === "authorization_header" ? authHeaderName.trim() || "authorization" : null,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(apiSecret.trim() ? { apiSecret: apiSecret.trim() } : {}),
      ...(webhookSecret.trim() ? { webhookSecret: webhookSecret.trim() } : {}),
      pathOverrides: {
        ...(customerPath.trim() ? { customerPath: customerPath.trim() } : {}),
        ...(subscriptionPath.trim() ? { subscriptionPath: subscriptionPath.trim() } : {}),
        ...(transactionPath.trim() ? { transactionPath: transactionPath.trim() } : {}),
        ...(hostedSessionPath.trim() ? { hostedSessionPath: hostedSessionPath.trim() } : {}),
        ...(chargePath.trim() ? { chargePath: chargePath.trim() } : {}),
        ...(cancelPath.trim() ? { cancelPath: cancelPath.trim() } : {})
      }
    };

    const res = await fetch(`${apiBase}/billing/sola/config`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(String(out?.message || out?.error || "Failed to save settings"));
      setSaving(false);
      return;
    }

    setMessage("SOLA settings saved. Re-test and re-enable before live billing.");
    setSaving(false);
    await loadConfig();
  }

  async function testConnection() {
    if (!token) return;
    setTesting(true);
    setError("");
    setMessage("");

    const res = await fetch(`${apiBase}/billing/sola/config/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });
    const out = await res.json().catch(() => ({}));

    if (!res.ok) {
      setError(`Test failed: ${String(out?.code || out?.error || "SOLA_VALIDATION_FAILED")}`);
      setTesting(false);
      await loadConfig();
      return;
    }

    setMessage(out?.simulated ? "Test successful (simulated)." : "Test successful.");
    setTesting(false);
    await loadConfig();
  }

  async function setEnabledState(nextEnabled: boolean) {
    if (!token) return;
    setUpdatingState(true);
    setError("");
    setMessage("");

    const path = nextEnabled ? "/billing/sola/config/enable" : "/billing/sola/config/disable";
    const res = await fetch(`${apiBase}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(String(out?.message || out?.error || "Unable to update state"));
      setUpdatingState(false);
      return;
    }

    setMessage(nextEnabled ? "SOLA billing enabled." : "SOLA billing disabled.");
    setUpdatingState(false);
    await loadConfig();
  }

  return (
    <div className="card">
      <h1>Billing Settings</h1>
      <p>Configure tenant SOLA/Cardknox credentials used by hosted checkout and subscription billing flows.</p>
      <p className="status-chip pending" style={{ borderRadius: 2 }}>Secrets are encrypted at rest and never shown in full after save.</p>

      {loading ? <p className="status-chip pending" style={{ borderRadius: 2 }}>Loading...</p> : null}
      {message ? <p className="status-chip live" style={{ borderRadius: 2 }}>{message}</p> : null}
      {error ? <p className="status-chip failed" style={{ borderRadius: 2 }}>{error}</p> : null}

      <h3>Status</h3>
      <p>
        Configured: <strong>{configured ? "Yes" : "No"}</strong> | Enabled: <strong>{isEnabled ? "Yes" : "No"}</strong> | Last test: <strong>{lastTestResult || "Not run"}</strong>
      </p>
      {lastTestAt ? <p>Last test at: <strong>{new Date(lastTestAt).toLocaleString()}</strong></p> : null}
      {lastTestErrorCode ? <p>Last test error: <strong>{lastTestErrorCode}</strong></p> : null}
      {updatedAt ? <p>Last updated: <strong>{new Date(updatedAt).toLocaleString()}</strong> by <strong>{updatedByUserId || "unknown"}</strong></p> : null}

      <h3>Connection</h3>
      <label>API Base URL</label>
      <input value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} placeholder="https://api.solapayments.com" style={{ width: "100%" }} />

      <div style={{ marginTop: 8 }}>
        <label>Mode </label>
        <select value={mode} onChange={(e) => setMode(e.target.value === "prod" ? "prod" : "sandbox") }>
          <option value="sandbox">sandbox</option>
          <option value="prod">prod</option>
        </select>
      </div>

      <div>
        <label><input type="checkbox" checked={simulate} onChange={(e) => setSimulate(e.target.checked)} /> Simulate API calls</label>
      </div>

      <div style={{ marginTop: 8 }}>
        <label>Auth mode </label>
        <select value={authMode} onChange={(e) => setAuthMode(e.target.value === "authorization_header" ? "authorization_header" : "xkey_body") }>
          <option value="xkey_body">xkey_body</option>
          <option value="authorization_header">authorization_header</option>
        </select>
      </div>

      {authMode === "authorization_header" ? (
        <>
          <label style={{ marginTop: 8 }}>Auth header name</label>
          <input value={authHeaderName} onChange={(e) => setAuthHeaderName(e.target.value)} placeholder="authorization" style={{ width: "100%" }} />
        </>
      ) : null}

      <h3 style={{ marginTop: 14 }}>Secrets</h3>
      <p>Leave secret fields empty to keep currently stored values.</p>
      <label>API Key {maskedApiKey ? `(saved: ${maskedApiKey})` : ""}</label>
      <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Enter API key" style={{ width: "100%" }} />

      <label style={{ marginTop: 8 }}>API Secret {maskedApiSecret ? "(saved)" : ""}</label>
      <input type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} placeholder="Enter API secret" style={{ width: "100%" }} />

      <label style={{ marginTop: 8 }}>Webhook Secret {maskedWebhookSecret ? "(saved)" : ""}</label>
      <input type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder="Enter webhook secret" style={{ width: "100%" }} />

      <details style={{ marginTop: 14 }}>
        <summary>Advanced path overrides</summary>
        <label>customerPath</label>
        <input value={customerPath} onChange={(e) => setCustomerPath(e.target.value)} placeholder="/customers" style={{ width: "100%" }} />
        <label style={{ marginTop: 8 }}>subscriptionPath</label>
        <input value={subscriptionPath} onChange={(e) => setSubscriptionPath(e.target.value)} placeholder="/subscriptions" style={{ width: "100%" }} />
        <label style={{ marginTop: 8 }}>transactionPath</label>
        <input value={transactionPath} onChange={(e) => setTransactionPath(e.target.value)} placeholder="/transactions" style={{ width: "100%" }} />
        <label style={{ marginTop: 8 }}>hostedSessionPath</label>
        <input value={hostedSessionPath} onChange={(e) => setHostedSessionPath(e.target.value)} placeholder="/hosted-checkout/sessions" style={{ width: "100%" }} />
        <label style={{ marginTop: 8 }}>chargePath</label>
        <input value={chargePath} onChange={(e) => setChargePath(e.target.value)} placeholder="/subscriptions/charge" style={{ width: "100%" }} />
        <label style={{ marginTop: 8 }}>cancelPath</label>
        <input value={cancelPath} onChange={(e) => setCancelPath(e.target.value)} placeholder="/subscriptions/cancel" style={{ width: "100%" }} />
      </details>

      <div style={{ marginTop: 14 }}>
        <button onClick={() => saveConfig().catch(() => setError("Failed to save settings"))} disabled={saving || testing || updatingState || loading}>
          {saving ? "Saving..." : "Save"}
        </button>
        {" "}
        <button onClick={() => testConnection().catch(() => setError("Failed to test connection"))} disabled={testing || saving || updatingState || loading || !configured}>
          {testing ? "Testing..." : "Test Connection"}
        </button>
        {" "}
        <button onClick={() => setEnabledState(!isEnabled).catch(() => setError("Failed to update enable state"))} disabled={updatingState || testing || saving || loading || !configured}>
          {updatingState ? "Updating..." : isEnabled ? "Disable" : "Enable"}
        </button>
      </div>
    </div>
  );
}
