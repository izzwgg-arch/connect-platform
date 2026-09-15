"use client";
/**
 * Telnyx — the third carrier on the evaluation bench (Izzy, 2026-09-15:
 * "create a new page inside Loopcom called Telnyx and wire the whole API in,
 * so if we want to, I can switch between SignalWire, [VoIP.ms], and Telnyx").
 *
 * Owner-only test bench, built to the same contract as /apps/signalwire.
 * Why Telnyx is on the bench at all: SignalWire signs outbound calls at
 * STIR/SHAKEN attestation C until their vetting grants better (seen live
 * 2026-08-18 — "carriers are filtering it"), while Telnyx's documented rule is
 * attestation A automatically for any number on the account, purchased or
 * ported. The Detail-records panel here reads back the attestation each real
 * call got, so the claim can be PROVEN per call rather than trusted.
 *
 * Nothing on this page touches VoIP.ms, tenants, TenantSmsNumber, the worker
 * or the PBX. A number bought here lives on Telnyx and in the event log; it
 * rings nothing until it is pointed at a SIP connection whose trunk a person
 * has built on the PBX.
 *
 * The API key is WRITE-ONLY (encrypted in the same store as the SignalWire /
 * ElevenLabs / Polly credentials); this page can only show a masked hint.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ConnectSelect } from "../../../../components/ConnectSelect";
import { PageHeader } from "../../../../components/PageHeader";
import { useAppContext } from "../../../../hooks/useAppContext";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, ApiError } from "../../../../services/apiClient";

type Connection = {
  ok: boolean;
  balance: string | null;
  currency: string | null;
  ownedNumberCount: number | null;
  message: string | null;
  code: string | null;
};

type Status = {
  configured: boolean;
  source: "store" | "env" | "none";
  keyHint: string | null;
  publicKeySet: boolean;
  connection: Connection | null;
};

type Available = {
  number: string;
  region: string | null;
  locality: string | null;
  numberType: string | null;
  upfrontCost: string | null;
  monthlyCost: string | null;
  features: string[];
};

type Owned = {
  id: string;
  number: string;
  status: string | null;
  connectionId: string | null;
  connectionName: string | null;
  emergencyEnabled: boolean;
  emergencyAddressId: string | null;
  cnamListingEnabled: boolean;
  cnamListingDetails: string | null;
  tags: string[];
  customerReference: string | null;
  createdAt: string | null;
};

type SipConnection = { id: string; name: string | null; active: boolean; recordType: string | null };
type OutboundProfile = { id: string; name: string | null; enabled: boolean; dailySpendLimit: string | null; dailySpendLimitEnabled: boolean; allowedDestinations: string[] };
type Portability = { number: string; portable: boolean | null; fastPortable: boolean | null; carrier: string | null; reason: string | null };
type DetailRecord = { recordType: string | null; startedAt: string | null; from: string | null; to: string | null; direction: string | null; durationSec: number | null; stirShaken: string | null; cost: string | null };
type TxEvent = { id: string; ts: string; actor: string; event: string; payload: Record<string, unknown> | null };

function errText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const b = e.body as { message?: string; error?: string; detail?: unknown } | null;
    const detail = b?.detail && typeof b.detail === "object" ? ` ${JSON.stringify(b.detail).slice(0, 300)}` : "";
    return (b?.message || b?.error || e.message || fallback) + detail;
  }
  return (e as Error)?.message || fallback;
}

function fmtTs(ts: string): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

export default function TelnyxPage() {
  const { role } = useAppContext();
  const isOwner = role === "SUPER_ADMIN";

  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // credentials
  const [apiKey, setApiKey] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [saving, setSaving] = useState(false);

  // numbers
  const [numberType, setNumberType] = useState<"local" | "toll_free">("local");
  const [areaCode, setAreaCode] = useState("");
  const [contains, setContains] = useState("");
  const [state, setState] = useState("");
  const [searching, setSearching] = useState(false);
  const [found, setFound] = useState<Available[] | null>(null);
  const [searchTook, setSearchTook] = useState<number | null>(null);
  const [owned, setOwned] = useState<Owned[]>([]);
  const [ownedError, setOwnedError] = useState<string | null>(null);
  const [busyNumber, setBusyNumber] = useState<string | null>(null);
  const [cnamDrafts, setCnamDrafts] = useState<Record<string, string>>({});

  // sip
  const [connections, setConnections] = useState<SipConnection[]>([]);
  const [profiles, setProfiles] = useState<OutboundProfile[]>([]);
  const [sipError, setSipError] = useState<string | null>(null);

  // porting
  const [portNumbers, setPortNumbers] = useState("");
  const [portChecking, setPortChecking] = useState(false);
  const [portResults, setPortResults] = useState<Portability[] | null>(null);

  // sms
  const [smsFrom, setSmsFrom] = useState("");
  const [smsTo, setSmsTo] = useState("");
  const [smsBody, setSmsBody] = useState("Test from Loopcom via Telnyx");
  const [smsSending, setSmsSending] = useState(false);

  // records + events
  const [records, setRecords] = useState<DetailRecord[]>([]);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [events, setEvents] = useState<TxEvent[]>([]);

  const ok = (m: string) => { setMsg(m); setErr(null); };
  const bad = (e: unknown, fallback: string) => { setErr(errText(e, fallback)); setMsg(null); };

  const load = useCallback(async () => {
    try {
      setStatus(await apiGet<Status>("/admin/apps/telnyx/status"));
      setLoadError(null);
    } catch (e) {
      setLoadError(errText(e, "Couldn't load the Telnyx status."));
    }
  }, []);

  const loadOwned = useCallback(async () => {
    try {
      const r = await apiGet<{ numbers: Owned[] }>("/admin/apps/telnyx/numbers");
      setOwned(r.numbers ?? []);
      setOwnedError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { setOwned([]); setOwnedError(null); return; }
      setOwnedError(errText(e, "Couldn't list the account's numbers."));
    }
  }, []);

  const loadSip = useCallback(async () => {
    try {
      const r = await apiGet<{ connections: { ok: boolean; value?: SipConnection[]; error?: string }; profiles: { ok: boolean; value?: OutboundProfile[]; error?: string } }>("/admin/apps/telnyx/sip");
      setConnections(r.connections.ok ? r.connections.value ?? [] : []);
      setProfiles(r.profiles.ok ? r.profiles.value ?? [] : []);
      setSipError([!r.connections.ok && r.connections.error, !r.profiles.ok && r.profiles.error].filter(Boolean).join(" · ") || null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return;
      setSipError(errText(e, "Couldn't list the SIP objects."));
    }
  }, []);

  const loadRecords = useCallback(async () => {
    try {
      const r = await apiGet<{ records: DetailRecord[] }>("/admin/apps/telnyx/detail-records?limit=20");
      setRecords(r.records ?? []);
      setRecordsError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return;
      setRecordsError(errText(e, "Couldn't read the call records."));
    }
  }, []);

  const loadEvents = useCallback(async () => {
    try {
      const r = await apiGet<{ events: TxEvent[] }>("/admin/apps/telnyx/events?limit=50");
      setEvents(r.events ?? []);
    } catch {
      // The event log is a convenience; its failure must not blank the page.
    }
  }, []);

  useEffect(() => {
    if (!isOwner) return;
    void load();
    void loadOwned();
    void loadSip();
    void loadRecords();
    void loadEvents();
  }, [isOwner, load, loadOwned, loadSip, loadRecords, loadEvents]);

  async function saveCredentials() {
    setSaving(true);
    try {
      const r = await apiPut<{ ok: boolean; connection?: Connection }>("/admin/apps/telnyx/credentials", {
        apiKey: apiKey.trim(), publicKey: publicKey.trim() || undefined,
      });
      setApiKey(""); setPublicKey("");
      ok(r.connection?.ok ? `Saved — connected, balance ${r.connection.balance ?? "?"} ${r.connection.currency ?? ""}.` : "Saved, but Telnyx refused the key — check it.");
      await Promise.all([load(), loadOwned(), loadSip(), loadEvents()]);
    } catch (e) {
      bad(e, "Couldn't save the credentials.");
    } finally {
      setSaving(false);
    }
  }

  async function clearCredentials() {
    if (!window.confirm("Remove the Telnyx credentials from Loopcom? Nothing on Telnyx itself changes.")) return;
    setSaving(true);
    try {
      await apiPut("/admin/apps/telnyx/credentials", { apiKey: "" });
      ok("Telnyx credentials removed.");
      await load();
    } catch (e) {
      bad(e, "Couldn't remove the credentials.");
    } finally {
      setSaving(false);
    }
  }

  async function search() {
    setSearching(true); setFound(null); setSearchTook(null);
    try {
      const q = new URLSearchParams();
      q.set("numberType", numberType);
      if (areaCode) q.set("areaCode", areaCode);
      if (contains) q.set("contains", contains);
      if (state) q.set("state", state);
      const r = await apiGet<{ results: Available[]; tookMs: number }>(`/admin/apps/telnyx/numbers/search?${q.toString()}`);
      setFound(r.results ?? []); setSearchTook(r.tookMs ?? null);
    } catch (e) {
      bad(e, "The search failed.");
    } finally {
      setSearching(false);
    }
  }

  async function buy(n: Available) {
    const conn = connections.find((c) => c.name === "Loopcom-Primary-SIP") ?? connections[0] ?? null;
    if (!window.confirm(`Buy ${n.number} on Telnyx? It is billed monthly to the Telnyx account${conn ? ` and will be attached to the "${conn.name}" SIP connection` : ""}.`)) return;
    setBusyNumber(n.number);
    try {
      const r = await apiPost<{ ok: boolean; orderId: string | null; status: string | null }>("/admin/apps/telnyx/numbers/order", {
        number: n.number, connectionId: conn?.id ?? undefined,
      });
      ok(`Ordered ${n.number}${r.status ? ` — order status "${r.status}"` : ""}. It appears below once Telnyx activates it.`);
      setFound((prev) => (prev ?? []).filter((x) => x.number !== n.number));
      await Promise.all([loadOwned(), loadEvents()]);
    } catch (e) {
      bad(e, "The purchase did not complete. If Telnyx timed out it MAY still have gone through — refresh before retrying.");
    } finally {
      setBusyNumber(null);
    }
  }

  async function attach(o: Owned, connectionId: string) {
    if (!connectionId) return;
    setBusyNumber(o.id);
    try {
      await apiPatch(`/admin/apps/telnyx/numbers/${encodeURIComponent(o.id)}`, { connectionId });
      ok(`Calls to ${o.number} now route to that SIP connection.`);
      await Promise.all([loadOwned(), loadEvents()]);
    } catch (e) {
      bad(e, "Couldn't attach the number.");
    } finally {
      setBusyNumber(null);
    }
  }

  async function saveCnam(o: Owned) {
    const details = (cnamDrafts[o.id] ?? o.cnamListingDetails ?? "").trim();
    if (!/^[A-Za-z0-9 ]{1,15}$/.test(details)) {
      bad(null, "The caller name must be 1–15 letters, digits or spaces (the CNAM limit).");
      return;
    }
    setBusyNumber(o.id);
    try {
      await apiPut(`/admin/apps/telnyx/numbers/${encodeURIComponent(o.id)}/cnam`, { enabled: true, details });
      ok(`Caller name for ${o.number} set to "${details.toUpperCase()}" — carriers take 12–72h to pick it up.`);
      await Promise.all([loadOwned(), loadEvents()]);
    } catch (e) {
      bad(e, "Couldn't set the caller name.");
    } finally {
      setBusyNumber(null);
    }
  }

  async function release(o: Owned) {
    if (!window.confirm(`Release ${o.number}? It leaves the Telnyx account and may not be recoverable.`)) return;
    setBusyNumber(o.id);
    try {
      await apiDelete(`/admin/apps/telnyx/numbers/${encodeURIComponent(o.id)}`);
      ok(`Released ${o.number}.`);
      await Promise.all([loadOwned(), loadEvents()]);
    } catch (e) {
      bad(e, "Couldn't release the number.");
    } finally {
      setBusyNumber(null);
    }
  }

  async function checkPortability() {
    setPortChecking(true); setPortResults(null);
    try {
      const numbers = portNumbers.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
      const r = await apiPost<{ results: Portability[] }>("/admin/apps/telnyx/portability-check", { numbers });
      setPortResults(r.results ?? []);
    } catch (e) {
      bad(e, "The portability check failed.");
    } finally {
      setPortChecking(false);
    }
  }

  async function sendSms() {
    setSmsSending(true);
    try {
      const r = await apiPost<{ ok: boolean; id: string | null }>("/admin/apps/telnyx/sms/send", { from: smsFrom, to: smsTo, body: smsBody });
      ok(`Sent — Telnyx accepted it${r.id ? ` (message ${r.id})` : ""}. An unregistered local number failing to deliver is 10DLC, not a bug.`);
      await loadEvents();
    } catch (e) {
      bad(e, "The text could not be sent.");
    } finally {
      setSmsSending(false);
    }
  }

  const conn = status?.connection ?? null;
  const pill = !status ? null : !status.configured ? { cls: "", text: "not set up yet" } : conn?.ok ? { cls: "ok", text: `connected · ${conn.balance ?? "?"} ${conn.currency ?? ""}` } : { cls: "bad", text: "credentials not working" };
  const ownedSorted = useMemo(() => [...owned].sort((a, b) => a.number.localeCompare(b.number)), [owned]);
  const canSave = apiKey.trim().length > 0 && !saving;

  if (!isOwner) {
    return (
      <div className="tx-wrap">
        <TxStyles />
        <PageHeader title="Telnyx" subtitle="This page is for the platform owner." />
      </div>
    );
  }

  return (
    <div className="tx-wrap">
      <TxStyles />
      <PageHeader
        title="Telnyx"
        subtitle="Test bench for the third carrier, beside SignalWire and VoIP.ms. Telnyx's documented rule: any number on the account — bought or ported — gets STIR/SHAKEN attestation A automatically, and every call's attestation shows in the records below."
      />
      <div className="tx-head">{pill && <span className={`tx-pill ${pill.cls}`}>{pill.text}</span>}</div>

      {loadError && <div className="tx-note bad">{loadError}</div>}
      {err && <div className="tx-note bad">{err}</div>}
      {msg && <div className="tx-note ok">{msg}</div>}

      {/* ── Credentials ─────────────────────────────────────────── */}
      <div className="tx-card">
        <h2>Telnyx credentials</h2>
        <p className="tx-sub">
          From the Telnyx portal → <b>API Keys</b>. You need one <b>API v2 key</b> (starts with <code>KEY</code>). The <b>public key</b> (the portal's
          Public Key page) is only for verifying webhooks Telnyx sends us — optional until a webhook door exists. Both are stored encrypted; the API key is never shown again.
        </p>
        <label className="tx-lbl">API key</label>
        <input className="tx-input" type="password" autoComplete="new-password" name="tx-key" placeholder={status?.configured ? `Saved (${status.keyHint}) — paste a new one to replace it` : "KEY…"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        <label className="tx-lbl">Public key (webhook verification, optional)</label>
        <input className="tx-input" type="password" autoComplete="new-password" name="tx-public" placeholder={status?.publicKeySet ? "Saved — paste a new one to replace it" : "base64 Ed25519 key (optional)"} value={publicKey} onChange={(e) => setPublicKey(e.target.value)} />
        <div className="tx-row" style={{ marginTop: 14 }}>
          <button className="tx-btn primary" disabled={!canSave} onClick={saveCredentials}>{saving ? "Saving…" : "Save & test connection"}</button>
          {status?.configured && <button className="tx-btn" disabled={saving} onClick={clearCredentials}>Remove</button>}
        </div>
        {status?.configured && (
          <p className="tx-sub" style={{ marginTop: 14, marginBottom: 0 }}>
            Saved: key <b>{status.keyHint}</b>, public key <b>{status.publicKeySet ? "set" : "not set"}</b>
            {status.source === "env" && " (from this server's environment, not typed here)"}.
          </p>
        )}
        {conn && (
          <div className={`tx-note ${conn.ok ? "ok" : "bad"}`} style={{ marginTop: 12, marginBottom: 0 }}>
            {conn.ok
              ? <>Connected. Balance <b>{conn.balance ?? "?"} {conn.currency ?? ""}</b>{conn.ownedNumberCount != null ? <>; <b>{conn.ownedNumberCount}</b> number(s) on the account</> : null}.</>
              : <>{conn.message ?? "Telnyx refused the credentials."}</>}
          </div>
        )}
      </div>

      {status?.configured && (
        <>
          {/* ── Numbers ────────────────────────────────────────────── */}
          <div className="tx-card">
            <h2>Numbers <span className="tx-count">{owned.length} on the account</span></h2>
            <p className="tx-sub">Search what Telnyx has, buy one, and it appears below already attached to the Loopcom SIP connection. Buying is real and billed monthly. A number on this account is what earns attestation A on its calls.</p>
            <div className="tx-filters">
              <ConnectSelect
                style={{ flex: "0 0 auto", minWidth: 150 }}
                value={numberType}
                onChange={(v) => setNumberType(v as "local" | "toll_free")}
                options={[
                  { value: "local", label: "Local" },
                  { value: "toll_free", label: "Toll-free" },
                ]}
              />
              <input className="tx-input tx-narrow" placeholder="Area code (845)" value={areaCode} onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, "").slice(0, 3))} />
              <input className="tx-input tx-narrow" placeholder="Contains digits" value={contains} onChange={(e) => setContains(e.target.value.replace(/\D/g, "").slice(0, 7))} />
              <input className="tx-input tx-narrow" placeholder="State (NY)" value={state} onChange={(e) => setState(e.target.value.toUpperCase().slice(0, 2))} />
              <button className="tx-btn primary" disabled={searching} onClick={search}>{searching ? "Searching…" : "Search"}</button>
            </div>
            {found && (
              <p className="tx-sub">
                {found.length === 0
                  ? `Telnyx has nothing for ${numberType}${areaCode ? ` in ${areaCode}` : ""}${contains ? ` containing ${contains}` : ""}${state ? ` in ${state}` : ""}. Try a different area code.`
                  : `${found.length} available${searchTook != null ? ` (${(searchTook / 1000).toFixed(1)}s)` : ""}.`}
              </p>
            )}
            {found && found.length > 0 && (
              <div className="tx-table-wrap">
                <table className="tx-table">
                  <thead><tr><th>Number</th><th>Where</th><th>Can do</th><th>Cost</th><th></th></tr></thead>
                  <tbody>
                    {found.map((n) => (
                      <tr key={n.number}>
                        <td><b>{n.number}</b></td>
                        <td>{[n.locality, n.region].filter(Boolean).join(", ") || "—"}</td>
                        <td>{n.features.join(" · ") || "—"}</td>
                        <td className="tx-dim">{n.monthlyCost ? `$${n.monthlyCost}/mo` : "—"}</td>
                        <td><button className="tx-btn small" disabled={busyNumber === n.number} onClick={() => buy(n)}>{busyNumber === n.number ? "Buying…" : "Buy"}</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <h3 className="tx-h3">On the account</h3>
            {ownedError && <div className="tx-note bad">{ownedError}</div>}
            {ownedSorted.length === 0 && !ownedError && <p className="tx-sub">No numbers yet. Buy one above — the account must be upgraded past Trial (address + card + verified phone in the Telnyx portal) before Telnyx sells one.</p>}
            {ownedSorted.length > 0 && (
              <div className="tx-table-wrap">
                <table className="tx-table">
                  <thead><tr><th>Number</th><th>Routes to</th><th>Caller name (CNAM)</th><th>911</th><th></th></tr></thead>
                  <tbody>
                    {ownedSorted.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <b>{o.number}</b>
                          <div className="tx-dim">{o.status ?? ""}{o.customerReference ? ` · ${o.customerReference}` : ""}{o.tags.length ? ` · ${o.tags.join(", ")}` : ""}</div>
                        </td>
                        <td>
                          {o.connectionName ?? <span className="tx-dim">nothing — attach it</span>}
                          {connections.length > 0 && (
                            <div style={{ marginTop: 4 }}>
                              <ConnectSelect
                                style={{ minWidth: 170 }}
                                value=""
                                placeholder="Attach to…"
                                onChange={(v) => { if (v) void attach(o, v); }}
                                options={connections.map((c) => ({ value: c.id, label: c.name ?? c.id }))}
                              />
                            </div>
                          )}
                        </td>
                        <td>
                          <input
                            className="tx-input tx-mini"
                            placeholder={o.cnamListingDetails ?? "e.g. ABC PLUMBING"}
                            value={cnamDrafts[o.id] ?? ""}
                            maxLength={15}
                            onChange={(e) => setCnamDrafts((p) => ({ ...p, [o.id]: e.target.value }))}
                          />
                          <button className="tx-btn small" style={{ marginLeft: 6 }} disabled={busyNumber === o.id || !(cnamDrafts[o.id] ?? "").trim()} onClick={() => saveCnam(o)}>Set</button>
                          {o.cnamListingEnabled && <div className="tx-dim">listed: {o.cnamListingDetails ?? "?"}</div>}
                        </td>
                        <td>{o.emergencyEnabled ? <span className="tx-tag ok">registered</span> : <span className="tx-tag">none</span>}</td>
                        <td><button className="tx-btn small danger" disabled={busyNumber === o.id} onClick={() => release(o)}>Release</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── SIP objects ───────────────────────────────────────── */}
          <div className="tx-card">
            <h2>SIP connections & outbound profiles</h2>
            <p className="tx-sub">
              Read from the Telnyx account. Connections (and their passwords) are created in the Telnyx portal, where the secrets stay — Loopcom only
              attaches numbers to them. <b>Loopcom-Primary-SIP</b> + <b>Loopcom-Primary-Outbound</b> are the pair built for the PBX trunk.
            </p>
            {sipError && <div className="tx-note bad">{sipError}</div>}
            <div className="tx-grid">
              <div>
                <h3 className="tx-h3">Connections</h3>
                {connections.length === 0 && <p className="tx-sub">None visible.</p>}
                {connections.map((c) => (
                  <div className="tx-kv" key={c.id}>
                    <span className={`tx-tag ${c.active ? "ok" : ""}`}>{c.active ? "active" : "off"}</span>
                    <b>{c.name ?? c.id}</b>
                    <span className="tx-dim">{c.recordType ?? ""}</span>
                  </div>
                ))}
              </div>
              <div>
                <h3 className="tx-h3">Outbound profiles</h3>
                {profiles.length === 0 && <p className="tx-sub">None visible.</p>}
                {profiles.map((p) => (
                  <div className="tx-kv" key={p.id}>
                    <span className={`tx-tag ${p.enabled ? "ok" : ""}`}>{p.enabled ? "enabled" : "off"}</span>
                    <b>{p.name ?? p.id}</b>
                    <span className="tx-dim">
                      {p.allowedDestinations.length ? p.allowedDestinations.join(", ") : "all destinations"}
                      {p.dailySpendLimitEnabled && p.dailySpendLimit ? ` · $${p.dailySpendLimit}/day cap` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ── Portability ───────────────────────────────────────── */}
          <div className="tx-card">
            <h2>Can a number port to Telnyx?</h2>
            <p className="tx-sub">Free check, no side effects — paste any numbers (a customer's, ours on VoIP.ms) to see whether Telnyx can take them and whether FastPort applies. Checking is not porting; nothing moves.</p>
            <div className="tx-row">
              <input className="tx-input" placeholder="845-555-1212, 845-555-1313…" value={portNumbers} onChange={(e) => setPortNumbers(e.target.value)} />
              <button className="tx-btn primary" disabled={portChecking || !portNumbers.trim()} onClick={checkPortability}>{portChecking ? "Checking…" : "Check"}</button>
            </div>
            {portResults && (
              <div className="tx-table-wrap" style={{ marginTop: 10 }}>
                <table className="tx-table">
                  <thead><tr><th>Number</th><th>Portable</th><th>FastPort</th><th>Current carrier</th><th>Why not</th></tr></thead>
                  <tbody>
                    {portResults.map((r) => (
                      <tr key={r.number}>
                        <td><b>{r.number}</b></td>
                        <td>{r.portable == null ? "—" : r.portable ? <span className="tx-tag ok">yes</span> : <span className="tx-tag bad">no</span>}</td>
                        <td>{r.fastPortable == null ? "—" : r.fastPortable ? <span className="tx-tag ok">yes</span> : <span className="tx-tag">no</span>}</td>
                        <td>{r.carrier ?? "—"}</td>
                        <td className="tx-dim">{r.reason ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── SMS ───────────────────────────────────────────────── */}
          <div className="tx-card">
            <h2>Send a test text</h2>
            <p className="tx-sub">From a Telnyx number on this account. ⛔ A local US number refuses to deliver until a 10DLC campaign covers it — that refusal is the carrier rule working, not a bug.</p>
            <div className="tx-row">
              <input className="tx-input tx-narrow" placeholder="From (Telnyx number)" value={smsFrom} onChange={(e) => setSmsFrom(e.target.value)} />
              <input className="tx-input tx-narrow" placeholder="To" value={smsTo} onChange={(e) => setSmsTo(e.target.value)} />
              <input className="tx-input" placeholder="Message" value={smsBody} onChange={(e) => setSmsBody(e.target.value)} />
              <button className="tx-btn primary" disabled={smsSending || !smsFrom || !smsTo || !smsBody.trim()} onClick={sendSms}>{smsSending ? "Sending…" : "Send"}</button>
            </div>
          </div>

          {/* ── Detail records ────────────────────────────────────── */}
          <div className="tx-card">
            <h2>Call records — the attestation proof <button className="tx-btn small" style={{ marginLeft: 8 }} onClick={() => void loadRecords()}>Refresh</button></h2>
            <p className="tx-sub">Telnyx stamps every outbound US call's STIR/SHAKEN level into its record. This is where "our calls sign A" stops being a claim and becomes a per-call fact.</p>
            {recordsError && <div className="tx-note bad">{recordsError}</div>}
            {records.length === 0 && !recordsError && <p className="tx-sub">No calls yet.</p>}
            {records.length > 0 && (
              <div className="tx-table-wrap">
                <table className="tx-table">
                  <thead><tr><th>When</th><th>From → To</th><th>Dir</th><th>Secs</th><th>STIR/SHAKEN</th><th>Cost</th></tr></thead>
                  <tbody>
                    {records.map((r, i) => (
                      <tr key={i}>
                        <td className="tx-dim">{r.startedAt ? fmtTs(r.startedAt) : "—"}</td>
                        <td>{r.from ?? "?"} → {r.to ?? "?"}</td>
                        <td>{r.direction ?? "—"}</td>
                        <td>{r.durationSec ?? "—"}</td>
                        <td>{r.stirShaken ? <span className={`tx-tag ${String(r.stirShaken).toUpperCase() === "A" ? "ok" : ""}`}>{r.stirShaken}</span> : "—"}</td>
                        <td className="tx-dim">{r.cost ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Events ────────────────────────────────────────────── */}
          <div className="tx-card">
            <h2>Events <button className="tx-btn small" style={{ marginLeft: 8 }} onClick={() => void loadEvents()}>Refresh</button></h2>
            <p className="tx-sub">Every action taken on this page, on record. The api restarts often; this log is the durable memory of the evaluation.</p>
            {events.length === 0 && <p className="tx-sub">Nothing yet.</p>}
            {events.length > 0 && (
              <div className="tx-table-wrap">
                <table className="tx-table">
                  <thead><tr><th>When</th><th>What</th><th>Detail</th></tr></thead>
                  <tbody>
                    {events.map((e) => (
                      <tr key={e.id}>
                        <td className="tx-dim" style={{ whiteSpace: "nowrap" }}>{fmtTs(e.ts)}</td>
                        <td><b>{e.event}</b></td>
                        <td><pre className="tx-payload">{e.payload ? JSON.stringify(e.payload) : ""}</pre></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function TxStyles() {
  return (
    <style jsx global>{`
      .tx-wrap{--pnl:#fff;--pnl2:#f6f9fc;--ln:rgba(19,32,48,.13);--tx:#132030;--dim:#5d6f84;--faint:#8496a8;
        --ac:#1f74d0;--ac-soft:rgba(31,116,208,.09);--ok:#1a9d5c;--bad:#c9414c;
        max-width:1040px;margin:0 auto;padding:8px 4px 60px;color:var(--tx);
        font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
      :root[data-theme="dark"] .tx-wrap{--pnl:#16212e;--pnl2:#1c2937;--ln:#2a3a4c;--tx:#e4ecf4;--dim:#8ba0b6;--faint:#64798f;
        --ac:#3ba0f2;--ac-soft:rgba(59,160,242,.14);--ok:#3ec37e;--bad:#e2606a}
      .tx-wrap *{box-sizing:border-box}
      .tx-head{display:flex;justify-content:flex-end;margin:0 0 14px}
      .tx-pill{font-size:11.5px;font-weight:680;padding:5px 12px;border-radius:999px;border:1px solid var(--ln);color:var(--dim);white-space:nowrap}
      .tx-pill.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,transparent);background:color-mix(in srgb,var(--ok) 12%,transparent)}
      .tx-pill.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,transparent);background:color-mix(in srgb,var(--bad) 12%,transparent)}
      .tx-card{background:var(--pnl);border:1px solid var(--ln);border-radius:16px;padding:20px;margin-bottom:16px}
      .tx-card h2{font-size:16px;font-weight:680;margin:0 0 4px;display:flex;align-items:center;gap:9px}
      .tx-h3{font-size:13.5px;font-weight:680;margin:18px 0 8px;color:var(--tx)}
      .tx-count{font-size:12px;font-weight:650;color:var(--ac);background:var(--ac-soft);border-radius:999px;padding:3px 9px}
      .tx-sub{color:var(--dim);font-size:13.5px;margin:0 0 14px;line-height:1.6;max-width:80ch}
      .tx-sub code,.tx-code,.tx-kv code{font-size:12.5px;background:var(--pnl2);border:1px solid var(--ln);border-radius:5px;padding:1px 5px;color:var(--tx)}
      .tx-code{display:block;padding:8px 10px;word-break:break-all;margin-bottom:6px}
      .tx-lbl{display:block;font-size:12px;font-weight:660;color:var(--dim);margin:14px 0 6px}
      .tx-row{display:flex;gap:10px;flex-wrap:wrap}
      .tx-input{flex:1;min-width:200px;width:100%;font:inherit;font-size:14px;padding:10px 12px;border-radius:10px;
        border:1px solid var(--ln);background:var(--pnl2);color:var(--tx)}
      .tx-input:focus{outline:none;border-color:var(--ac);box-shadow:0 0 0 3px var(--ac-soft)}
      .tx-narrow{flex:0 0 auto;min-width:150px;width:auto}
      .tx-mini{font-size:12px;padding:5px 8px;min-width:150px;width:auto;margin-top:4px}
      .tx-filters{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;align-items:center}
      .tx-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
      .tx-btn{font:inherit;font-size:13.5px;font-weight:640;padding:10px 16px;border-radius:10px;cursor:pointer;
        border:1px solid var(--ln);background:var(--pnl2);color:var(--tx)}
      .tx-btn.primary{background:var(--ac);border-color:var(--ac);color:#fff}
      .tx-btn.danger{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,transparent)}
      .tx-btn.small{font-size:12px;padding:6px 12px}
      .tx-btn:disabled{opacity:.5;cursor:not-allowed}
      .tx-note{padding:11px 14px;border-radius:11px;font-size:13.5px;margin-bottom:14px;border:1px solid var(--ln);color:var(--dim)}
      .tx-note.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 34%,transparent);background:color-mix(in srgb,var(--ok) 10%,transparent)}
      .tx-note.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 34%,transparent);background:color-mix(in srgb,var(--bad) 10%,transparent)}
      .tx-note b{color:inherit}
      .tx-kv{display:flex;gap:10px;align-items:center;margin-top:6px;font-size:13px}
      .tx-table-wrap{overflow-x:auto;margin-bottom:8px}
      .tx-table{width:100%;border-collapse:collapse;font-size:13px}
      .tx-table th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim);padding:8px 10px;border-bottom:1px solid var(--ln)}
      .tx-table td{padding:9px 10px;border-bottom:1px solid var(--ln);vertical-align:top}
      .tx-dim{color:var(--dim);font-size:12px}
      .tx-tag{font-size:11px;font-weight:680;border-radius:999px;padding:2px 8px;border:1px solid var(--ln);color:var(--dim)}
      .tx-tag.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,transparent);background:color-mix(in srgb,var(--ok) 12%,transparent)}
      .tx-tag.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,transparent);background:color-mix(in srgb,var(--bad) 12%,transparent)}
      .tx-payload{font-size:12px;white-space:pre-wrap;word-break:break-word;background:transparent;border:0;padding:0;color:var(--tx);margin:0}
    `}</style>
  );
}
