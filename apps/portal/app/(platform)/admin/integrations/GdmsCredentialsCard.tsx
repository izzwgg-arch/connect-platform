"use client";

/**
 * Admin → Integrations → Grandstream device cloud (GDMS). Platform-wide, not per company:
 * one Loopcom GDMS account drives every Grandstream the Desk Phone Wizard sets up.
 *
 * ⛔ Write-only. The api hands back masked hints, never a value, and the inputs are
 * cleared the moment a save lands. Verify and Look up are read-only at GDMS.
 */

import { useCallback, useEffect, useState } from "react";
import { ConnectSelect } from "../../../../components/ConnectSelect";
import { apiGet, apiPost, ApiError } from "../../../../services/apiClient";

type Described = {
  configured: boolean;
  source: "store" | "env" | "none";
  region: "us" | "eu" | null;
  apiIdHint: string | null;
  usernameHint: string | null;
  secretHint: string | null;
};

const BASE = "/admin/desk-phones/gdms-credentials";
const INPUT_STYLE = { flex: 1, background: "transparent", border: 0, outline: "none", color: "inherit", font: "inherit" } as const;

function errText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const body: any = e.body;
    return body?.message || body?.error || e.message || fallback;
  }
  return fallback;
}

export function GdmsCredentialsCard() {
  const [described, setDescribed] = useState<Described | null>(null);
  const [region, setRegion] = useState<"us" | "eu">("us");
  const [apiId, setApiId] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [mac, setMac] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ credentials: Described }>(BASE);
      setDescribed(res.credentials ?? null);
      if (res.credentials?.region) setRegion(res.credentials.region);
    } catch (e) {
      setErr(errText(e, "The GDMS status could not be loaded."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(async (work: () => Promise<string>, fallback: string) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg(await work());
      setErr(null);
    } catch (e) {
      setErr(errText(e, fallback));
    } finally {
      setBusy(false);
    }
  }, []);

  const save = () =>
    run(async () => {
      try {
        const res = await apiPost<{ credentials: Described }>(BASE, { region, apiId, secretKey, username, password });
        setDescribed(res.credentials ?? null);
        return "GDMS credentials saved. Press Verify to prove they work.";
      } finally {
        // Never keep a secret in the page longer than the request.
        setSecretKey("");
        setPassword("");
      }
    }, "The credentials could not be saved.");

  const clear = () =>
    run(async () => {
      const res = await apiPost<{ credentials: Described }>(BASE, { clear: true });
      setDescribed(res.credentials ?? null);
      return "GDMS credentials cleared.";
    }, "The credentials could not be cleared.");

  const verify = () =>
    run(async () => {
      const res = await apiPost<{ organizations: number }>(`${BASE}/verify`, {});
      return `GDMS accepted the credentials (${res.organizations} organization${res.organizations === 1 ? "" : "s"}). Nothing was changed.`;
    }, "GDMS did not accept the credentials.");

  const lookup = () =>
    run(async () => {
      const res = await apiPost<any>(`${BASE}/lookup`, { mac });
      if (!res.found) return "GDMS does not have this device. Nothing was changed.";
      const d = res.device ?? {};
      const bits = [d.model, d.online === true ? "online" : d.online === false ? "offline" : null, d.firmware ? `firmware ${d.firmware}` : null, d.serialTail ? `serial ${d.serialTail}` : null];
      return `GDMS has it: ${bits.filter(Boolean).join(" · ") || "no details"}. Nothing was changed.`;
    }, "The lookup failed.");

  const canSave = apiId.trim().length >= 4 && secretKey.trim().length >= 8 && username.trim().length > 0 && password.length > 0;

  return (
    <div className="sm-card" style={{ marginBottom: "1rem" }}>
      <div className="sm-card-h">Grandstream device cloud (GDMS)</div>
      <div className="sm-card-b">
        <div className="sm-krow">
          <b>Account</b>
          <span className="sm-k">
            {described?.configured
              ? `${described.region === "eu" ? "Europe" : "United States"} · API ID …${described.apiIdHint ?? ""} · ${described.usernameHint ?? ""}${described.source === "env" ? " · from server settings" : ""}`
              : "not set"}
          </span>
          {described?.configured ? <span className="sm-pill sm-done"><i />Saved</span> : <span className="sm-pill sm-warn"><i />Missing</span>}
          {described?.configured ? (
            <button type="button" className="sm-btn sm-quiet" disabled={busy} onClick={() => void verify()}>Verify</button>
          ) : (
            <span />
          )}
        </div>

        <div className="sm-actions" style={{ justifyContent: "flex-start", marginTop: ".8rem", gap: ".5rem", flexWrap: "wrap" }}>
          <div style={{ minWidth: "11rem" }}>
            <ConnectSelect
              value={region}
              onChange={(v: string) => setRegion(v === "eu" ? "eu" : "us")}
              options={[
                { value: "us", label: "United States" },
                { value: "eu", label: "Europe" },
              ]}
              size="sm"
            />
          </div>
          <div className="sm-fieldbox" style={{ flex: 1, minWidth: "12rem" }}>
            <input value={apiId} onChange={(e) => setApiId(e.target.value)} placeholder="API ID" aria-label="GDMS API ID" autoComplete="off" style={INPUT_STYLE} />
          </div>
          <div className="sm-fieldbox" style={{ flex: 1, minWidth: "12rem" }}>
            <input type="password" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} placeholder="Secret Key" aria-label="GDMS Secret Key" autoComplete="new-password" style={INPUT_STYLE} />
          </div>
        </div>
        <div className="sm-actions" style={{ justifyContent: "flex-start", marginTop: ".5rem", gap: ".5rem", flexWrap: "wrap" }}>
          <div className="sm-fieldbox" style={{ flex: 1, minWidth: "12rem" }}>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="GDMS username" aria-label="GDMS username" autoComplete="off" style={INPUT_STYLE} />
          </div>
          <div className="sm-fieldbox" style={{ flex: 1, minWidth: "12rem" }}>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="GDMS password" aria-label="GDMS password" autoComplete="new-password" style={INPUT_STYLE} />
          </div>
          <button type="button" className="sm-btn sm-ghost" disabled={busy || !canSave} onClick={() => void save()}>Save</button>
          {described?.source === "store" ? (
            <button type="button" className="sm-btn sm-quiet" disabled={busy} onClick={() => void clear()}>Clear</button>
          ) : null}
        </div>

        {described?.configured ? (
          <div className="sm-actions" style={{ justifyContent: "flex-start", marginTop: ".8rem", gap: ".5rem", flexWrap: "wrap" }}>
            <div className="sm-fieldbox" style={{ flex: 1, minWidth: "14rem" }}>
              <input value={mac} onChange={(e) => setMac(e.target.value)} placeholder="Device MAC, e.g. C0:74:AD:8C:60:5F" aria-label="Device MAC address" autoComplete="off" style={INPUT_STYLE} />
            </div>
            <button type="button" className="sm-btn sm-quiet" disabled={busy || mac.trim().length < 12} onClick={() => void lookup()}>Look up</button>
          </div>
        ) : null}

        {msg ? <p className="sm-mut" role="status">{msg}</p> : null}
        {err ? <p className="sm-mut" role="alert">{err}</p> : null}
        <p className="sm-mut">
          One Loopcom account for every company. Stored encrypted, shown masked, never shown again after saving. Verify and Look up
          only read from GDMS — they never add, restart or reset a phone.
        </p>
      </div>
    </div>
  );
}
