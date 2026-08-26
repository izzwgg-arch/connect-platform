"use client";

import { useCallback, useEffect, useState } from "react";
import { ConnectSelect } from "../../../../components/ConnectSelect";
import { apiGet, apiPost, apiPut, ApiError } from "../../../../services/apiClient";

type TenantRow = { id: string; name: string; crmMode: string };
type KeyStatus = { provider: string; configured: boolean; hint: string | null; label: string | null; updatedAt: string | null };
type Settings = {
  autoSubmitEnabled: boolean;
  autoSubmitMaxCorrectionPct: number;
  autoSubmitMinWeeks: number;
  deliveryIngestEnabled: boolean;
  deliveryStoreRef: string;
  payIvrEnabled: boolean;
} | null;

const PROVIDER_LABELS: Record<string, string> = {
  POS_TRACKING: "Tracking system (POS)",
  SOLA: "Sola payments",
  OPENAI: "Voice agent (OpenAI)",
};

function errText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const body: any = e.body;
    return body?.message || body?.error || e.message || fallback;
  }
  return fallback;
}

export function IntegrationsInner() {
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [tenantId, setTenantId] = useState<string>("");
  const [keys, setKeys] = useState<KeyStatus[]>([]);
  const [settings, setSettings] = useState<Settings>(null);
  const [mode, setMode] = useState<string>("classic");
  const [addProvider, setAddProvider] = useState<string>("POS_TRACKING");
  const [addKey, setAddKey] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiGet<{ tenants: TenantRow[] }>("/admin/integrations/tenants")
      .then((res) => setTenants(res.tenants ?? []))
      .catch((e) => setErr(errText(e, "Tenants could not be loaded.")));
  }, []);

  const loadTenant = useCallback(async (id: string) => {
    if (!id) return;
    try {
      const res = await apiGet<any>(`/admin/integrations/keys?tenantId=${encodeURIComponent(id)}`);
      setKeys(res.keys ?? []);
      setSettings(res.settings ?? null);
      setMode(res.tenant?.crmMode ?? "classic");
      setErr(null);
    } catch (e) {
      setErr(errText(e, "That company could not be loaded."));
    }
  }, []);

  useEffect(() => {
    if (tenantId) void loadTenant(tenantId);
  }, [tenantId, loadTenant]);

  const saveMode = useCallback(
    async (next: string) => {
      setBusy(true);
      try {
        await apiPut("/admin/integrations/crm-mode", { tenantId, mode: next });
        setMode(next);
        setMsg(`CRM mode is now ${next}.`);
        setErr(null);
      } catch (e) {
        setErr(errText(e, "The mode could not be changed."));
      } finally {
        setBusy(false);
      }
    },
    [tenantId],
  );

  const saveKey = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiPost<{ ok: boolean; hint: string }>("/admin/integrations/keys", {
        tenantId,
        provider: addProvider,
        apiKey: addKey.trim(),
      });
      setMsg(`Key saved (${res.hint}).`);
      setAddKey("");
      setErr(null);
      void loadTenant(tenantId);
    } catch (e) {
      setErr(errText(e, "The key could not be saved."));
    } finally {
      setBusy(false);
    }
  }, [tenantId, addProvider, addKey, loadTenant]);

  const removeKey = useCallback(
    async (provider: string) => {
      setBusy(true);
      try {
        await apiPost("/admin/integrations/keys/remove", { tenantId, provider });
        setMsg("Key removed.");
        setErr(null);
      } catch (e) {
        setErr(errText(e, "The key could not be removed."));
      } finally {
        setBusy(false);
        void loadTenant(tenantId);
      }
    },
    [tenantId, loadTenant],
  );

  const testKey = useCallback(
    async (provider: string) => {
      setBusy(true);
      try {
        const res = await apiPost<any>("/admin/integrations/keys/test", { tenantId, provider });
        setMsg(res.verdict === "key_works" ? "Their system accepted the key." : res.message || res.verdict);
        setErr(null);
      } catch (e) {
        setErr(errText(e, "The key could not be tested."));
      } finally {
        setBusy(false);
      }
    },
    [tenantId],
  );

  const saveSettings = useCallback(
    async (changes: Partial<NonNullable<Settings>>) => {
      setBusy(true);
      try {
        const res = await apiPut<any>("/admin/integrations/supermarket-settings", { tenantId, ...changes });
        setSettings(res.settings ?? null);
        setMsg("Saved.");
        setErr(null);
      } catch (e) {
        setErr(errText(e, "The settings could not be saved."));
      } finally {
        setBusy(false);
      }
    },
    [tenantId],
  );

  const tenantName = tenants.find((t) => t.id === tenantId)?.name ?? "";

  return (
    <div className="sm-root sm-app">
      <div className="sm-content" style={{ minHeight: "auto", maxWidth: "62rem" }}>
        <div className="sm-pagehead">
          <h3>{tenantName || "Integrations"}</h3>
          <span className="sm-crumb">Admin / Integrations</span>
          <span className="sm-spacer" />
          <div style={{ minWidth: "16rem" }}>
            <ConnectSelect
              value={tenantId}
              onChange={(v: string) => setTenantId(v)}
              options={[{ value: "", label: "Pick a company…" }, ...tenants.map((t) => ({ value: t.id, label: t.name }))]}
              size="sm"
            />
          </div>
        </div>

        {msg ? <p className="sm-mut" role="status">{msg}</p> : null}
        {err ? <p className="sm-mut" role="alert">{err}</p> : null}

        {tenantId ? (
          <div className="sm-set">
            <div className="sm-card">
              <div className="sm-card-h">CRM mode</div>
              <div className="sm-card-b">
                <ConnectSelect
                  value={mode}
                  onChange={(v: string) => void saveMode(v)}
                  options={[
                    { value: "classic", label: "Classic" },
                    { value: "supermarket", label: "Supermarket" },
                  ]}
                />
                <p className="sm-mut">
                  Decides which screens this company's reps see — Orders, Customers, Specials. Companies on{" "}
                  <b style={{ color: "var(--text)" }}>Classic</b> are untouched.
                </p>
              </div>
            </div>

            <div className="sm-card">
              <div className="sm-card-h">Integration keys</div>
              <div className="sm-card-b">
                {keys.map((k) => (
                  <div className="sm-krow" key={k.provider}>
                    <b>{PROVIDER_LABELS[k.provider] ?? k.provider}</b>
                    <span className="sm-k">{k.configured ? `••••••••••${(k.hint ?? "").replace("…", "")}` : "not set"}</span>
                    {k.configured ? <span className="sm-pill sm-done"><i />Active</span> : <span className="sm-pill sm-warn"><i />Missing</span>}
                    {k.configured ? (
                      <button type="button" className="sm-btn sm-quiet" disabled={busy} onClick={() => void testKey(k.provider)}>Test</button>
                    ) : (
                      <span />
                    )}
                  </div>
                ))}
                <div className="sm-actions" style={{ justifyContent: "flex-start", marginTop: ".8rem", gap: ".5rem", flexWrap: "wrap" }}>
                  <div style={{ minWidth: "13rem" }}>
                    <ConnectSelect
                      value={addProvider}
                      onChange={(v: string) => setAddProvider(v)}
                      options={Object.entries(PROVIDER_LABELS).map(([value, label]) => ({ value, label }))}
                      size="sm"
                    />
                  </div>
                  <div className="sm-fieldbox" style={{ flex: 1, minWidth: "16rem" }}>
                    <input
                      value={addKey}
                      onChange={(e) => setAddKey(e.target.value)}
                      placeholder="Paste the key"
                      aria-label="Paste the key"
                      autoComplete="off"
                      style={{ flex: 1, background: "transparent", border: 0, outline: "none", color: "inherit", font: "inherit" }}
                    />
                  </div>
                  <button type="button" className="sm-btn sm-ghost" disabled={busy || addKey.trim().length < 8} onClick={() => void saveKey()}>
                    ＋ Add a key
                  </button>
                </div>
                <p className="sm-mut">Keys are stored encrypted and shown masked. Each key belongs to one company and powers only that company's features.</p>
              </div>
            </div>

            <div className="sm-card" style={{ gridColumn: "1 / -1" }}>
              <div className="sm-card-h">Supermarket switches</div>
              <div className="sm-card-b">
                <div className="sm-krow" style={{ gridTemplateColumns: "1.4fr 1fr auto auto" }}>
                  <b>Pay-by-phone line</b>
                  <span className="sm-k">the payment IVR answers for this company</span>
                  <span>{settings?.payIvrEnabled ? <span className="sm-pill sm-done"><i />On</span> : <span className="sm-pill sm-warn"><i />Off</span>}</span>
                  <button type="button" className="sm-btn sm-quiet" disabled={busy} onClick={() => void saveSettings({ payIvrEnabled: !settings?.payIvrEnabled })}>
                    {settings?.payIvrEnabled ? "Turn off" : "Turn on"}
                  </button>
                </div>
                <div className="sm-krow" style={{ gridTemplateColumns: "1.4fr 1fr auto auto" }}>
                  <b>Delivery tracker tie-in</b>
                  <span className="sm-k">approved Delivery orders flow into the tracker</span>
                  <span>{settings?.deliveryIngestEnabled ? <span className="sm-pill sm-done"><i />On</span> : <span className="sm-pill sm-warn"><i />Off</span>}</span>
                  <button type="button" className="sm-btn sm-quiet" disabled={busy} onClick={() => void saveSettings({ deliveryIngestEnabled: !settings?.deliveryIngestEnabled })}>
                    {settings?.deliveryIngestEnabled ? "Turn off" : "Turn on"}
                  </button>
                </div>
                <div className="sm-krow" style={{ gridTemplateColumns: "1.4fr 1fr auto auto" }}>
                  <b>Auto-submit (Phase 7)</b>
                  <span className="sm-k">
                    only fires under {settings?.autoSubmitMaxCorrectionPct ?? 5}% corrections for {settings?.autoSubmitMinWeeks ?? 2} weeks
                  </span>
                  <span>{settings?.autoSubmitEnabled ? <span className="sm-pill sm-done"><i />Armed</span> : <span className="sm-pill sm-warn"><i />Off</span>}</span>
                  <button type="button" className="sm-btn sm-quiet" disabled={busy} onClick={() => void saveSettings({ autoSubmitEnabled: !settings?.autoSubmitEnabled })}>
                    {settings?.autoSubmitEnabled ? "Disarm" : "Arm"}
                  </button>
                </div>
                <p className="sm-mut">
                  Every switch is OFF by default. Arming auto-submit alone does nothing — the correction numbers have to earn it first
                  (the written threshold), and the gauge lives on the Orders screen.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <p className="sm-mut">Pick a company to see its mode, keys and switches.</p>
        )}
      </div>
    </div>
  );
}
