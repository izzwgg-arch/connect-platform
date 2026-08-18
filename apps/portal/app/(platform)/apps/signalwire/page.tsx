"use client";
/**
 * SignalWire — the evaluation console for the carrier that may replace VoIP.ms.
 *
 * Owner-only test bench (Izzy, 2026-08-18: "start pivoting away from voip.ms …
 * set this up and test it … build this inside Loopcom"). Every job VoIP.ms does
 * for the platform today has a panel here that does the same job on SignalWire,
 * so each can be proven or disproven with the result on record — before
 * onboarding, chat, billing SMS or the PBX trunk are pointed anywhere new.
 *
 * Nothing on this page touches VoIP.ms, tenants, TenantSmsNumber, the worker
 * or the PBX. A number bought here lives on SignalWire and in the event log;
 * it rings nothing until the SIP panel is used to wire it.
 *
 * The API token and signing key are WRITE-ONLY (encrypted in the same store as
 * the ElevenLabs / Polly credentials); this page can only show the last four
 * characters. A generated SIP password is shown ONCE, in the response that
 * created it, and never stored by Loopcom.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "../../../../components/PageHeader";
import { useAppContext } from "../../../../hooks/useAppContext";
import { apiDelete, apiGet, apiPost, apiPut, ApiError } from "../../../../services/apiClient";

type Connection = {
  ok: boolean;
  numbersScope: boolean;
  lamlReachable: boolean;
  projectName: string | null;
  projectStatus: string | null;
  ownedNumberCount: number | null;
  subprojectCount: number | null;
  message: string | null;
  code: string | null;
};

type Status = {
  configured: boolean;
  source: "store" | "env" | "none";
  spaceUrl: string | null;
  projectId: string | null;
  tokenHint: string | null;
  signingKeySet: boolean;
  connection: Connection | null;
  webhooks: { inboundSms: string; smsStatus: string };
};

type Available = {
  number: string;
  region: string | null;
  city: string | null;
  rateCenter: string | null;
  capabilities: { voice: boolean; sms: boolean; mms: boolean; fax: boolean };
};

type Owned = {
  id: string;
  number: string;
  name: string | null;
  numberType: string | null;
  capabilities: string[];
  callHandler: string | null;
  callRequestUrl: string | null;
  callSipEndpointId: string | null;
  messageHandler: string | null;
  messageRequestUrl: string | null;
  e911AddressId: string | null;
  e911Status: string | null;
  nextBilledAt: string | null;
};

type SwEvent = { id: string; ts: string; actor: string; event: string; payload: Record<string, unknown> | null };
type SipEndpoint = { id: string; username: string | null; sendAs: string | null; callHandler: string | null; via: string };
type SipGateway = { id: string; name: string | null; uri: string | null; encryption: string | null };
type E911Address = { id: string; label: string | null; line: string };

function errText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const b = e.body as { message?: string; error?: string; detail?: unknown } | null;
    const detail = b?.detail && typeof b.detail === "object" ? ` ${JSON.stringify(b.detail).slice(0, 300)}` : "";
    return (b?.message || b?.error || e.message || fallback) + detail;
  }
  return (e as Error)?.message || fallback;
}

function origin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

function fmtTs(ts: string): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

export default function SignalWirePage() {
  const { role } = useAppContext();
  const isOwner = role === "SUPER_ADMIN";

  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // credentials
  const [spaceUrl, setSpaceUrl] = useState("");
  const [projectId, setProjectId] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [signingKey, setSigningKey] = useState("");
  const [saving, setSaving] = useState(false);

  // numbers
  const [numberType, setNumberType] = useState<"local" | "toll-free">("local");
  const [areaCode, setAreaCode] = useState("");
  const [contains, setContains] = useState("");
  const [region, setRegion] = useState("");
  const [searching, setSearching] = useState(false);
  const [found, setFound] = useState<Available[] | null>(null);
  const [searchTook, setSearchTook] = useState<number | null>(null);
  const [owned, setOwned] = useState<Owned[]>([]);
  const [ownedError, setOwnedError] = useState<string | null>(null);
  const [busyNumber, setBusyNumber] = useState<string | null>(null);

  // sms
  const [smsFrom, setSmsFrom] = useState("");
  const [smsTo, setSmsTo] = useState("");
  const [smsBody, setSmsBody] = useState("Test from Loopcom via SignalWire");
  const [smsSending, setSmsSending] = useState(false);
  const [lastSid, setLastSid] = useState<string | null>(null);
  const [lastSmsStatus, setLastSmsStatus] = useState<string | null>(null);

  // events
  const [events, setEvents] = useState<SwEvent[]>([]);

  // sip
  const [sipDomain, setSipDomain] = useState<string | null>(null);
  const [endpoints, setEndpoints] = useState<SipEndpoint[]>([]);
  const [gateways, setGateways] = useState<SipGateway[]>([]);
  const [sipError, setSipError] = useState<string | null>(null);
  const [epUsername, setEpUsername] = useState("loopcom-pbx");
  const [epSendAs, setEpSendAs] = useState("");
  const [epResult, setEpResult] = useState<{ username: string; password: string; registrar: string; via: string } | null>(null);
  const [gwName, setGwName] = useState("Loopcom PBX");
  const [gwUri, setGwUri] = useState("");
  const [routeResourceId, setRouteResourceId] = useState("");
  const [routeNumberId, setRouteNumberId] = useState("");
  const [sipBusy, setSipBusy] = useState(false);

  // e911
  const [addresses, setAddresses] = useState<E911Address[]>([]);
  const [addr, setAddr] = useState({ label: "", firstName: "", lastName: "", streetNumber: "", streetName: "", city: "", state: "NY", postalCode: "" });
  const [e911NumberId, setE911NumberId] = useState("");
  const [e911AddressId, setE911AddressId] = useState("");
  const [e911Busy, setE911Busy] = useState(false);

  // lookup
  const [lookupNumber, setLookupNumber] = useState("");
  const [lookupResult, setLookupResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await apiGet<Status>(`/admin/apps/signalwire/status?origin=${encodeURIComponent(origin())}`);
      setStatus(s);
      setLoadError(null);
    } catch (e) {
      setLoadError(errText(e, "Couldn't load the SignalWire status."));
    }
  }, []);

  const loadOwned = useCallback(async () => {
    try {
      const r = await apiGet<{ numbers: Owned[] }>("/admin/apps/signalwire/numbers");
      setOwned(r.numbers ?? []);
      setOwnedError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { setOwned([]); setOwnedError(null); return; }
      setOwnedError(errText(e, "Couldn't list the numbers."));
    }
  }, []);

  const loadEvents = useCallback(async () => {
    try {
      const r = await apiGet<{ events: SwEvent[] }>("/admin/apps/signalwire/events?limit=60");
      setEvents(r.events ?? []);
    } catch {
      /* the log is a nicety; a failure here must not blank the page */
    }
  }, []);

  const loadSip = useCallback(async () => {
    try {
      const r = await apiGet<{ sipDomain: string; endpoints: SipEndpoint[]; gateways: SipGateway[]; endpointsError: string | null; gatewaysError: string | null }>("/admin/apps/signalwire/sip");
      setSipDomain(r.sipDomain);
      setEndpoints(r.endpoints ?? []);
      setGateways(r.gateways ?? []);
      setSipError([r.endpointsError, r.gatewaysError].filter(Boolean).join(" · ") || null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return;
      setSipError(errText(e, "Couldn't read the SIP objects."));
    }
  }, []);

  const loadAddresses = useCallback(async () => {
    try {
      const r = await apiGet<{ addresses: E911Address[] }>("/admin/apps/signalwire/e911/addresses");
      setAddresses(r.addresses ?? []);
    } catch {
      /* not configured yet, or no scope — the panel says so on use */
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!status?.configured) return;
    void loadOwned(); void loadEvents(); void loadSip(); void loadAddresses();
  }, [status?.configured, loadOwned, loadEvents, loadSip, loadAddresses]);

  // The inbound-SMS proof arrives by webhook, so the event log polls while the
  // page is open — small (60 rows) and only when configured. Not while hidden.
  useEffect(() => {
    if (!status?.configured) return;
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void loadEvents(); }, 10_000);
    return () => window.clearInterval(t);
  }, [status?.configured, loadEvents]);

  function ok(text: string) { setErr(null); setMsg(text); }
  function bad(e: unknown, fallback: string) { setMsg(null); setErr(errText(e, fallback)); }

  async function saveCredentials() {
    setSaving(true);
    try {
      const r = await apiPut<{ ok: boolean; connection?: Connection; cleared?: boolean }>("/admin/apps/signalwire/credentials", { spaceUrl, projectId, apiToken, signingKey });
      setApiToken(""); setSigningKey("");
      if (r.cleared) ok("SignalWire credentials removed.");
      else if (r.connection?.ok) ok(`Saved and connected${r.connection.projectName ? ` to "${r.connection.projectName}"` : ""}.`);
      else ok(`Saved, but SignalWire did not accept them yet: ${r.connection?.message ?? "unknown"}`);
      await load();
    } catch (e) {
      bad(e, "Couldn't save the credentials.");
    } finally {
      setSaving(false);
    }
  }

  async function clearCredentials() {
    if (!window.confirm("Remove the SignalWire credentials from Loopcom? Nothing on SignalWire itself changes.")) return;
    setSaving(true);
    try {
      await apiPut("/admin/apps/signalwire/credentials", { spaceUrl: "" });
      ok("SignalWire credentials removed.");
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
      const r = await apiPost<{ numbers: Available[]; tookMs: number }>("/admin/apps/signalwire/numbers/search", {
        numberType, areaCode: areaCode || undefined, contains: contains || undefined, region: region || undefined, maxResults: 30,
      });
      setFound(r.numbers ?? []); setSearchTook(r.tookMs ?? null);
    } catch (e) {
      bad(e, "The search failed.");
    } finally {
      setSearching(false);
    }
  }

  async function buy(n: Available) {
    if (!window.confirm(`Buy ${n.number} on SignalWire? It is billed monthly to the SignalWire account, and its texting will be pointed at Loopcom's inbound webhook.`)) return;
    setBusyNumber(n.number);
    try {
      const r = await apiPost<{ ok: boolean; number: Owned; handlers: { ok: boolean; message: string | null } }>("/admin/apps/signalwire/numbers/purchase", {
        number: n.number, confirm: true, origin: origin(),
      });
      ok(`Bought ${r.number.number}. ${r.handlers.message ?? ""}`);
      setFound((prev) => (prev ?? []).filter((x) => x.number !== n.number));
      await Promise.all([loadOwned(), loadEvents()]);
    } catch (e) {
      bad(e, "The purchase failed.");
    } finally {
      setBusyNumber(null);
    }
  }

  async function pointMessaging(o: Owned) {
    setBusyNumber(o.id);
    try {
      await apiPost(`/admin/apps/signalwire/numbers/${encodeURIComponent(o.id)}/handlers`, { messaging: "loopcom", origin: origin() });
      ok(`Texts to ${o.number} now come to Loopcom.`);
      await Promise.all([loadOwned(), loadEvents()]);
    } catch (e) {
      bad(e, "Couldn't update the number.");
    } finally {
      setBusyNumber(null);
    }
  }

  async function ringEndpoint(o: Owned, endpointId: string) {
    if (!endpointId) return;
    setBusyNumber(o.id);
    try {
      await apiPost(`/admin/apps/signalwire/numbers/${encodeURIComponent(o.id)}/handlers`, { voice: "sip_endpoint", sipEndpointId: endpointId, origin: origin() });
      ok(`Calls to ${o.number} now ring that SIP endpoint.`);
      await Promise.all([loadOwned(), loadEvents()]);
    } catch (e) {
      bad(e, "Couldn't update the number.");
    } finally {
      setBusyNumber(null);
    }
  }

  async function release(o: Owned) {
    if (!window.confirm(`Release ${o.number}? It leaves the SignalWire account and may not be recoverable.`)) return;
    setBusyNumber(o.id);
    try {
      await apiDelete(`/admin/apps/signalwire/numbers/${encodeURIComponent(o.id)}?confirm=true`);
      ok(`Released ${o.number}.`);
      await Promise.all([loadOwned(), loadEvents()]);
    } catch (e) {
      bad(e, "Couldn't release the number.");
    } finally {
      setBusyNumber(null);
    }
  }

  async function sendSms() {
    setSmsSending(true); setLastSid(null); setLastSmsStatus(null);
    try {
      const r = await apiPost<{ ok: boolean; message: { sid: string; status: string; numSegments: number | null; errorMessage: string | null } }>("/admin/apps/signalwire/sms/send", {
        from: smsFrom, to: smsTo, body: smsBody, origin: origin(),
      });
      setLastSid(r.message.sid); setLastSmsStatus(r.message.status);
      ok(`Sent — SignalWire accepted it as "${r.message.status}"${r.message.numSegments ? `, ${r.message.numSegments} segment(s)` : ""}. Delivery updates arrive in the log below.`);
      await loadEvents();
    } catch (e) {
      bad(e, "The text could not be sent.");
    } finally {
      setSmsSending(false);
    }
  }

  async function checkSms() {
    if (!lastSid) return;
    try {
      const r = await apiGet<{ message: { status: string; errorCode: string | null; errorMessage: string | null } }>(`/admin/apps/signalwire/sms/${encodeURIComponent(lastSid)}`);
      setLastSmsStatus(r.message.status + (r.message.errorMessage ? ` — ${r.message.errorMessage}` : r.message.errorCode ? ` (error ${r.message.errorCode})` : ""));
    } catch (e) {
      bad(e, "Couldn't read the message back.");
    }
  }

  async function createEndpoint() {
    setSipBusy(true); setEpResult(null);
    try {
      const r = await apiPost<{ ok: boolean; endpoint: SipEndpoint; password: string; registrar: string }>("/admin/apps/signalwire/sip/endpoints", {
        username: epUsername, sendAs: epSendAs || undefined, callHandler: "passthrough",
      });
      setEpResult({ username: epUsername, password: r.password, registrar: r.registrar, via: r.endpoint.via });
      ok(`SIP endpoint "${epUsername}" created (via ${r.endpoint.via}). Copy the password now — it is not shown again.`);
      await Promise.all([loadSip(), loadEvents()]);
    } catch (e) {
      bad(e, "Couldn't create the SIP endpoint.");
    } finally {
      setSipBusy(false);
    }
  }

  async function createGateway() {
    setSipBusy(true);
    try {
      await apiPost("/admin/apps/signalwire/sip/gateways", { name: gwName, uri: gwUri });
      ok(`SIP gateway "${gwName}" created — assign a number to it below.`);
      await Promise.all([loadSip(), loadEvents()]);
    } catch (e) {
      bad(e, "Couldn't create the SIP gateway.");
    } finally {
      setSipBusy(false);
    }
  }

  async function assignRoute() {
    setSipBusy(true);
    try {
      await apiPost("/admin/apps/signalwire/sip/routes", { resourceId: routeResourceId, phoneNumberId: routeNumberId, handler: "calling" });
      ok("Number pointed at that SIP resource. Call it.");
      await Promise.all([loadOwned(), loadEvents()]);
    } catch (e) {
      bad(e, "Couldn't point the number at that resource.");
    } finally {
      setSipBusy(false);
    }
  }

  async function createAddress() {
    setE911Busy(true);
    try {
      const r = await apiPost<{ ok: boolean; address: E911Address }>("/admin/apps/signalwire/e911/addresses", addr);
      ok(`Emergency address accepted: ${r.address.line}`);
      await Promise.all([loadAddresses(), loadEvents()]);
    } catch (e) {
      bad(e, "SignalWire wouldn't accept that address.");
    } finally {
      setE911Busy(false);
    }
  }

  async function assignE911() {
    if (!window.confirm("Register this address as the E911 location for that number? This is billable and is what a dispatcher is handed.")) return;
    setE911Busy(true);
    try {
      const r = await apiPost<{ ok: boolean; number: Owned }>("/admin/apps/signalwire/e911/assign", { phoneNumberId: e911NumberId, addressId: e911AddressId, confirm: true });
      ok(`E911 on ${r.number.number}: ${r.number.e911Status ?? "requested"}.`);
      await Promise.all([loadOwned(), loadEvents()]);
    } catch (e) {
      bad(e, "Couldn't register the address on that number.");
    } finally {
      setE911Busy(false);
    }
  }

  async function doLookup() {
    setLookupResult(null);
    try {
      const r = await apiPost<{ number: string; cnam: string | null; carrier: string | null; lineType: string | null }>("/admin/apps/signalwire/lookup", { number: lookupNumber });
      setLookupResult(`${r.number}: name ${r.cnam ?? "—"}, carrier ${r.carrier ?? "—"}, line ${r.lineType ?? "—"}`);
    } catch (e) {
      bad(e, "The lookup failed.");
    }
  }

  const conn = status?.connection ?? null;
  const pill = !status ? null : !status.configured ? { cls: "", text: "not set up yet" } : conn?.ok ? { cls: "ok", text: `connected${conn.projectName ? ` · ${conn.projectName}` : ""}` } : { cls: "bad", text: "credentials not working" };
  const ownedSorted = useMemo(() => [...owned].sort((a, b) => a.number.localeCompare(b.number)), [owned]);
  const canSave = spaceUrl.trim().length > 0 && (status?.configured ? true : projectId.trim().length > 0 && apiToken.trim().length > 0) && !saving;

  if (!isOwner) {
    return (
      <div className="sw-wrap">
        <SwStyles />
        <PageHeader title="SignalWire" subtitle="This page is for the platform owner." />
      </div>
    );
  }

  return (
    <div className="sw-wrap">
      <SwStyles />
      <PageHeader
        title="SignalWire"
        subtitle="Test bench for the carrier that may replace VoIP.ms. Every job VoIP.ms does today has a panel here — prove each one on SignalWire before anything is switched over."
      />
      <div className="sw-head">{pill && <span className={`sw-pill ${pill.cls}`}>{pill.text}</span>}</div>

      {loadError && <div className="sw-note bad">{loadError}</div>}
      {err && <div className="sw-note bad">{err}</div>}
      {msg && <div className="sw-note ok">{msg}</div>}

      {/* ── Credentials ─────────────────────────────────────────── */}
      <div className="sw-card">
        <h2>SignalWire credentials</h2>
        <p className="sw-sub">
          From your SignalWire dashboard → the project → <b>API</b>. You need the <b>Space URL</b> (yourspace.signalwire.com), the <b>Project ID</b>, and an
          <b> API token</b> with the <i>Numbers</i>, <i>Messaging</i> and <i>Calling</i> scopes ticked. The <b>signing key</b> (same page) is what lets Loopcom
          trust texts SignalWire sends us — without it, inbound texts are refused. Token and signing key are stored encrypted and never shown again.
        </p>
        <label className="sw-lbl">Space URL</label>
        <input className="sw-input" autoComplete="off" name="sw-space" placeholder={status?.spaceUrl ?? "yourspace.signalwire.com"} value={spaceUrl} onChange={(e) => setSpaceUrl(e.target.value)} />
        <label className="sw-lbl">Project ID</label>
        <input className="sw-input" autoComplete="off" name="sw-project" placeholder={status?.projectId ?? "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"} value={projectId} onChange={(e) => setProjectId(e.target.value)} />
        <label className="sw-lbl">API token</label>
        <input className="sw-input" type="password" autoComplete="new-password" name="sw-token" placeholder={status?.configured ? `Saved (…${status.tokenHint?.slice(-4)}) — paste a new one to replace it` : "PT…"} value={apiToken} onChange={(e) => setApiToken(e.target.value)} />
        <label className="sw-lbl">Signing key (for inbound texts)</label>
        <input className="sw-input" type="password" autoComplete="new-password" name="sw-signing" placeholder={status?.signingKeySet ? "Saved — paste a new one to replace it" : "PSK… (optional until you test inbound texts)"} value={signingKey} onChange={(e) => setSigningKey(e.target.value)} />
        <div className="sw-row" style={{ marginTop: 14 }}>
          <button className="sw-btn primary" disabled={!canSave} onClick={saveCredentials}>{saving ? "Saving…" : "Save & test connection"}</button>
          {status?.configured && <button className="sw-btn" disabled={saving} onClick={clearCredentials}>Remove</button>}
        </div>
        {status?.configured && (
          <p className="sw-sub" style={{ marginTop: 14, marginBottom: 0 }}>
            Saved: <b>{status.spaceUrl}</b>, project <b>{status.projectId}</b>, token ending <b>{status.tokenHint}</b>, signing key <b>{status.signingKeySet ? "set" : "not set"}</b>
            {status.source === "env" && " (from this server's environment, not typed here)"}.
          </p>
        )}
        {conn && (
          <div className={`sw-note ${conn.ok ? "ok" : "bad"}`} style={{ marginTop: 12, marginBottom: 0 }}>
            {conn.ok
              ? <>Connected. Numbers API <b>working</b>; messaging API <b>{conn.lamlReachable ? "working" : "refused"}</b>{conn.projectStatus ? <>; project status <b>{conn.projectStatus}</b></> : null}{conn.subprojectCount != null ? <>; <b>{conn.subprojectCount}</b> subproject(s)</> : null}.{conn.message ? <> {conn.message}</> : null}</>
              : <>{conn.message ?? "SignalWire refused the credentials."}</>}
          </div>
        )}
      </div>

      {status?.configured && (
        <>
          {/* ── Webhooks ───────────────────────────────────────────── */}
          <div className="sw-card">
            <h2>Where SignalWire reaches Loopcom</h2>
            <p className="sw-sub">Numbers bought from this page get these set automatically. For a number set up in the SignalWire dashboard, paste them there under the number's Messaging settings.</p>
            <label className="sw-lbl">Inbound text webhook (POST)</label>
            <code className="sw-code">{status.webhooks.inboundSms}</code>
            <label className="sw-lbl">Delivery status callback (POST)</label>
            <code className="sw-code">{status.webhooks.smsStatus}</code>
          </div>

          {/* ── Numbers ────────────────────────────────────────────── */}
          <div className="sw-card">
            <h2>Numbers <span className="sw-count">{owned.length} on the account</span></h2>
            <p className="sw-sub">Search what SignalWire has, buy one, and it appears below. Buying is real and billed monthly.</p>
            <div className="sw-filters">
              <select className="sw-input sw-narrow" value={numberType} onChange={(e) => setNumberType(e.target.value as "local" | "toll-free")}>
                <option value="local">Local</option>
                <option value="toll-free">Toll-free</option>
              </select>
              <input className="sw-input sw-narrow" placeholder="Area code (845)" value={areaCode} onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, "").slice(0, 3))} />
              <input className="sw-input sw-narrow" placeholder="Contains digits" value={contains} onChange={(e) => setContains(e.target.value.replace(/\D/g, "").slice(0, 7))} />
              <input className="sw-input sw-narrow" placeholder="State (NY)" value={region} onChange={(e) => setRegion(e.target.value.toUpperCase().slice(0, 2))} />
              <button className="sw-btn primary" disabled={searching} onClick={search}>{searching ? "Searching…" : "Search"}</button>
            </div>
            {found && (
              <p className="sw-sub">
                {found.length === 0
                  ? `SignalWire has nothing for ${numberType}${areaCode ? ` in ${areaCode}` : ""}${contains ? ` containing ${contains}` : ""}${region ? ` in ${region}` : ""}. Try a different area code.`
                  : `${found.length} available${searchTook != null ? ` (${(searchTook / 1000).toFixed(1)}s)` : ""}.`}
              </p>
            )}
            {found && found.length > 0 && (
              <div className="sw-table-wrap">
                <table className="sw-table">
                  <thead><tr><th>Number</th><th>Where</th><th>Can do</th><th></th></tr></thead>
                  <tbody>
                    {found.map((n) => (
                      <tr key={n.number}>
                        <td><b>{n.number}</b></td>
                        <td>{[n.city, n.region].filter(Boolean).join(", ") || n.rateCenter || "—"}</td>
                        <td>{["voice", "sms", "mms", "fax"].filter((k) => (n.capabilities as Record<string, boolean>)[k]).join(" · ") || "—"}</td>
                        <td><button className="sw-btn small" disabled={busyNumber === n.number} onClick={() => buy(n)}>{busyNumber === n.number ? "Buying…" : "Buy"}</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <h3 className="sw-h3">On the account</h3>
            {ownedError && <div className="sw-note bad">{ownedError}</div>}
            {ownedSorted.length === 0 && !ownedError && <p className="sw-sub">No numbers yet. Buy one above.</p>}
            {ownedSorted.length > 0 && (
              <div className="sw-table-wrap">
                <table className="sw-table">
                  <thead><tr><th>Number</th><th>Texts go to</th><th>Calls go to</th><th>E911</th><th></th></tr></thead>
                  <tbody>
                    {ownedSorted.map((o) => {
                      const textsToLoopcom = (o.messageRequestUrl || "").includes("/webhooks/signalwire/sms");
                      return (
                        <tr key={o.id}>
                          <td><b>{o.number}</b><div className="sw-dim">{o.numberType ?? ""}{o.capabilities.length ? ` · ${o.capabilities.join(", ")}` : ""}</div></td>
                          <td>{textsToLoopcom ? <span className="sw-tag ok">Loopcom</span> : <span className="sw-dim">{o.messageHandler ?? "nothing"}</span>}
                            {!textsToLoopcom && <div><button className="sw-btn small" disabled={busyNumber === o.id} onClick={() => pointMessaging(o)}>Point at Loopcom</button></div>}
                          </td>
                          <td>
                            <span className="sw-dim">{o.callHandler ? `${o.callHandler}${o.callSipEndpointId ? ` (${o.callSipEndpointId.slice(0, 8)}…)` : ""}` : "nothing"}</span>
                            {endpoints.length > 0 && (
                              <div>
                                <select className="sw-input sw-mini" defaultValue="" onChange={(e) => { if (e.target.value) void ringEndpoint(o, e.target.value); e.target.value = ""; }}>
                                  <option value="">Ring a SIP endpoint…</option>
                                  {endpoints.map((ep) => <option key={ep.id} value={ep.id}>{ep.username ?? ep.id}</option>)}
                                </select>
                              </div>
                            )}
                          </td>
                          <td>{o.e911Status ? <span className={`sw-tag ${o.e911Status === "active" ? "ok" : ""}`}>{o.e911Status}</span> : <span className="sw-dim">none</span>}</td>
                          <td><button className="sw-btn small danger" disabled={busyNumber === o.id} onClick={() => release(o)}>Release</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── SMS ────────────────────────────────────────────────── */}
          <div className="sw-card">
            <h2>Send a text</h2>
            <p className="sw-sub">
              From a number on the account, to a real phone. ⛔ SignalWire requires 10DLC registration for texting from a local US number — an unregistered
              number may be accepted here and then not delivered; the status callback below tells you which. A trial account can only text verified numbers.
            </p>
            <div className="sw-filters">
              <select className="sw-input sw-narrow" value={smsFrom} onChange={(e) => setSmsFrom(e.target.value)}>
                <option value="">From…</option>
                {ownedSorted.map((o) => <option key={o.id} value={o.number}>{o.number}</option>)}
              </select>
              <input className="sw-input sw-narrow" placeholder="To (845…)" value={smsTo} onChange={(e) => setSmsTo(e.target.value)} />
              <input className="sw-input" placeholder="Message" value={smsBody} onChange={(e) => setSmsBody(e.target.value)} />
              <button className="sw-btn primary" disabled={smsSending || !smsFrom || !smsTo || !smsBody.trim()} onClick={sendSms}>{smsSending ? "Sending…" : "Send"}</button>
            </div>
            {lastSid && (
              <p className="sw-sub" style={{ marginBottom: 0 }}>
                Last message <code>{lastSid}</code> — status <b>{lastSmsStatus ?? "?"}</b>. <button className="sw-btn small" onClick={checkSms}>Check now</button>
              </p>
            )}
          </div>

          {/* ── SIP ────────────────────────────────────────────────── */}
          <div className="sw-card">
            <h2>Voice to the phone system (SIP)</h2>
            <p className="sw-sub">
              Two ways to get calls between SignalWire and the PBX. <b>A SIP endpoint</b> is a login the PBX registers with (like the VoIP.ms subaccount today) —
              outbound calls go through it, and a number can be told to ring it. <b>A SIP gateway</b> is SignalWire pushing inbound calls straight to the PBX's
              address, no registration. Registrar for endpoints: <code>{sipDomain ?? "…"}</code>, port 5060 (UDP/TCP) or 5061 (TLS).
            </p>
            {sipError && <div className="sw-note bad">{sipError}</div>}

            <h3 className="sw-h3">Create a SIP endpoint (the PBX registers with this)</h3>
            <div className="sw-filters">
              <input className="sw-input sw-narrow" placeholder="Username" value={epUsername} onChange={(e) => setEpUsername(e.target.value)} />
              <select className="sw-input sw-narrow" value={epSendAs} onChange={(e) => setEpSendAs(e.target.value)}>
                <option value="">Send as (caller ID)…</option>
                {ownedSorted.map((o) => <option key={o.id} value={o.number}>{o.number}</option>)}
              </select>
              <button className="sw-btn primary" disabled={sipBusy || epUsername.trim().length < 3} onClick={createEndpoint}>{sipBusy ? "Working…" : "Create endpoint"}</button>
            </div>
            {epResult && (
              <div className="sw-note ok" style={{ marginTop: 10 }}>
                <b>Copy this now — the password is not shown again.</b>
                <div className="sw-kv"><span>Registrar</span><code>{epResult.registrar}</code></div>
                <div className="sw-kv"><span>Username</span><code>{epResult.username}</code></div>
                <div className="sw-kv"><span>Password</span><code>{epResult.password}</code></div>
                <div className="sw-kv"><span>Made via</span><code>{epResult.via}</code></div>
                <p className="sw-sub" style={{ marginTop: 8, marginBottom: 0 }}>
                  On the PBX this becomes a PJSIP trunk exactly like the VoIP.ms one: host = registrar, username/password above, from-domain = registrar, register = yes,
                  codecs ulaw/alaw/g722. Dial out as <code>sip:+1NXXNXXXXXX@{epResult.registrar}</code>. Caller ID must be a number on this account.
                </p>
              </div>
            )}
            {endpoints.length > 0 && (
              <ul className="sw-list">
                {endpoints.map((ep) => <li key={ep.id}><b>{ep.username ?? ep.id}</b> — send-as {ep.sendAs ?? "random account number"}, {ep.callHandler ?? "default"} <span className="sw-dim">({ep.via})</span> <code className="sw-dim">{ep.id}</code></li>)}
              </ul>
            )}

            <h3 className="sw-h3">Create a SIP gateway (SignalWire pushes inbound calls to the PBX)</h3>
            <div className="sw-filters">
              <input className="sw-input sw-narrow" placeholder="Name" value={gwName} onChange={(e) => setGwName(e.target.value)} />
              <input className="sw-input" placeholder="user@pbx-host[:port] — e.g. signalwire@m.connectcomunications.com" value={gwUri} onChange={(e) => setGwUri(e.target.value)} />
              <button className="sw-btn primary" disabled={sipBusy || !gwUri.trim() || !gwName.trim()} onClick={createGateway}>{sipBusy ? "Working…" : "Create gateway"}</button>
            </div>
            {gateways.length > 0 && (
              <ul className="sw-list">
                {gateways.map((g) => <li key={g.id}><b>{g.name ?? g.id}</b> → <code>{g.uri}</code> ({g.encryption ?? "?"} encryption) <code className="sw-dim">{g.id}</code></li>)}
              </ul>
            )}

            <h3 className="sw-h3">Point a number at a gateway or endpoint</h3>
            <div className="sw-filters">
              <select className="sw-input sw-narrow" value={routeNumberId} onChange={(e) => setRouteNumberId(e.target.value)}>
                <option value="">Number…</option>
                {ownedSorted.map((o) => <option key={o.id} value={o.id}>{o.number}</option>)}
              </select>
              <select className="sw-input" value={routeResourceId} onChange={(e) => setRouteResourceId(e.target.value)}>
                <option value="">Ring…</option>
                {gateways.map((g) => <option key={g.id} value={g.id}>gateway {g.name ?? g.id} → {g.uri}</option>)}
                {endpoints.map((ep) => <option key={ep.id} value={ep.id}>endpoint {ep.username ?? ep.id}</option>)}
              </select>
              <button className="sw-btn primary" disabled={sipBusy || !routeNumberId || !routeResourceId} onClick={assignRoute}>{sipBusy ? "Working…" : "Point it"}</button>
            </div>
          </div>

          {/* ── E911 ───────────────────────────────────────────────── */}
          <div className="sw-card">
            <h2>E911</h2>
            <p className="sw-sub">Same shape as VoIP.ms: validate an address, then register it on a number. SignalWire corrects the town to the emergency district's name (Monsey → Spring Valley) the same way. Test with 933, never 911.</p>
            <div className="sw-grid">
              <input className="sw-input" placeholder="Label (Matamim office)" value={addr.label} onChange={(e) => setAddr({ ...addr, label: e.target.value.slice(0, 32) })} />
              <input className="sw-input" placeholder="First name" value={addr.firstName} onChange={(e) => setAddr({ ...addr, firstName: e.target.value })} />
              <input className="sw-input" placeholder="Last name" value={addr.lastName} onChange={(e) => setAddr({ ...addr, lastName: e.target.value })} />
              <input className="sw-input" placeholder="Street number (15)" value={addr.streetNumber} onChange={(e) => setAddr({ ...addr, streetNumber: e.target.value })} />
              <input className="sw-input" placeholder="Street name (Van Buren Dr)" value={addr.streetName} onChange={(e) => setAddr({ ...addr, streetName: e.target.value })} />
              <input className="sw-input" placeholder="City" value={addr.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} />
              <input className="sw-input" placeholder="State (NY)" value={addr.state} onChange={(e) => setAddr({ ...addr, state: e.target.value.toUpperCase().slice(0, 2) })} />
              <input className="sw-input" placeholder="ZIP" value={addr.postalCode} onChange={(e) => setAddr({ ...addr, postalCode: e.target.value })} />
            </div>
            <div className="sw-row" style={{ marginTop: 10 }}>
              <button className="sw-btn primary" disabled={e911Busy || !addr.label || !addr.streetNumber || !addr.streetName || !addr.city || !addr.postalCode} onClick={createAddress}>{e911Busy ? "Working…" : "Validate & save address"}</button>
            </div>
            {addresses.length > 0 && (
              <>
                <h3 className="sw-h3">Register on a number</h3>
                <div className="sw-filters">
                  <select className="sw-input sw-narrow" value={e911NumberId} onChange={(e) => setE911NumberId(e.target.value)}>
                    <option value="">Number…</option>
                    {ownedSorted.map((o) => <option key={o.id} value={o.id}>{o.number}</option>)}
                  </select>
                  <select className="sw-input" value={e911AddressId} onChange={(e) => setE911AddressId(e.target.value)}>
                    <option value="">Address…</option>
                    {addresses.map((a) => <option key={a.id} value={a.id}>{a.label ?? a.id} — {a.line}</option>)}
                  </select>
                  <button className="sw-btn primary" disabled={e911Busy || !e911NumberId || !e911AddressId} onClick={assignE911}>{e911Busy ? "Working…" : "Register E911"}</button>
                </div>
              </>
            )}
          </div>

          {/* ── Lookup ─────────────────────────────────────────────── */}
          <div className="sw-card">
            <h2>Caller name lookup</h2>
            <p className="sw-sub">Inbound CNAM + carrier for any number (billable per lookup, a fraction of a cent).</p>
            <div className="sw-filters">
              <input className="sw-input sw-narrow" placeholder="Number" value={lookupNumber} onChange={(e) => setLookupNumber(e.target.value)} />
              <button className="sw-btn" disabled={!lookupNumber.trim()} onClick={doLookup}>Look up</button>
            </div>
            {lookupResult && <p className="sw-sub" style={{ marginBottom: 0 }}>{lookupResult}</p>}
          </div>

          {/* ── Events ─────────────────────────────────────────────── */}
          <div className="sw-card">
            <h2>What happened <span className="sw-count">{events.length}</span></h2>
            <p className="sw-sub">The record of this evaluation: everything done from this page and everything SignalWire sent us. Refreshes every 10 seconds while open — an inbound text should show up here within seconds of arriving.</p>
            {events.length === 0 && <p className="sw-sub">Nothing yet.</p>}
            {events.length > 0 && (
              <div className="sw-table-wrap">
                <table className="sw-table">
                  <thead><tr><th>When</th><th>Event</th><th>Detail</th></tr></thead>
                  <tbody>
                    {events.map((ev) => (
                      <tr key={ev.id}>
                        <td className="sw-dim" style={{ whiteSpace: "nowrap" }}>{fmtTs(ev.ts)}</td>
                        <td><span className={`sw-tag ${ev.event === "inbound_sms" ? "ok" : /fail|refused/.test(ev.event) ? "bad" : ""}`}>{ev.event}</span></td>
                        <td><code className="sw-payload">{summarizeEvent(ev)}</code></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Comparison ─────────────────────────────────────────── */}
          <div className="sw-card">
            <h2>How it compares to VoIP.ms — what is known so far</h2>
            <ul className="sw-list">
              <li><b>Numbers:</b> search, buy, list, release and per-number routing all have a real API (this page uses it). Toll-free too. Prices are not published on their public pricing page — read them off the first purchase.</li>
              <li><b>Voice to the PBX:</b> registered SIP endpoints (like the VoIP.ms subaccount), or SignalWire pushing straight to the PBX (SIP gateway) — no registration. IP-authenticated trunking exists but only through a small call-handler script, not as a plain carrier trunk. Caller ID must be a number on the account (or verified) — <b>arbitrary caller ID is not allowed</b>. US list price about 0.66¢/min in, 0.8¢/min out.</li>
              <li><b>Texting:</b> send/receive/status all API-driven. ⛔ <b>10DLC brand + campaign registration is mandatory</b> for texting from local US numbers ($4 brand, campaign fee charged 3 months up front, 3–5 business days) — VoIP.ms does not enforce this. Toll-free texting needs a separate verification form (1–2 weeks). This is the biggest operational difference.</li>
              <li><b>E911:</b> full API (address validation with corrections, then register per number). $100 fee for a 911 call from an unregistered number.</li>
              <li><b>Number porting:</b> ⛔ dashboard only, no API — the port watchdog automation would have to be rebuilt around their portal or support tickets.</li>
              <li><b>Sub-accounts:</b> one project per customer is possible (subprojects) with numbers isolated per project, but they share one balance — no per-customer billing records API found.</li>
              <li><b>Outbound caller name (CNAM):</b> support ticket only, ≤15 characters, not on toll-free.</li>
              <li><b>Trial mode:</b> until a card is added and $5 funded, texts only reach verified numbers, one number can be bought, and SIP endpoints can register but not call out.</li>
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

function summarizeEvent(ev: SwEvent): string {
  const p = ev.payload ?? {};
  const pick = (keys: string[]) => keys.filter((k) => p[k] !== undefined && p[k] !== null && p[k] !== "").map((k) => `${k}=${typeof p[k] === "object" ? JSON.stringify(p[k]) : String(p[k])}`).join("  ");
  switch (ev.event) {
    case "inbound_sms": return pick(["from", "to", "body", "numMedia"]);
    case "sms_status": return pick(["sid", "status", "to", "errorCode"]);
    case "sms_sent": return pick(["from", "to", "sid", "status", "segments"]);
    case "webhook_refused": return pick(["kind", "reason", "from", "to"]);
    default: return pick(Object.keys(p).filter((k) => k !== "by")).slice(0, 400);
  }
}

function SwStyles() {
  return (
    <style jsx global>{`
      .sw-wrap{--pnl:#fff;--pnl2:#f6f9fc;--ln:rgba(19,32,48,.13);--tx:#132030;--dim:#5d6f84;--faint:#8496a8;
        --ac:#1f74d0;--ac-soft:rgba(31,116,208,.09);--ok:#1a9d5c;--bad:#c9414c;
        max-width:1040px;margin:0 auto;padding:8px 4px 60px;color:var(--tx);
        font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
      :root[data-theme="dark"] .sw-wrap{--pnl:#16212e;--pnl2:#1c2937;--ln:#2a3a4c;--tx:#e4ecf4;--dim:#8ba0b6;--faint:#64798f;
        --ac:#3ba0f2;--ac-soft:rgba(59,160,242,.14);--ok:#3ec37e;--bad:#e2606a}
      .sw-wrap *{box-sizing:border-box}
      .sw-head{display:flex;justify-content:flex-end;margin:0 0 14px}
      .sw-pill{font-size:11.5px;font-weight:680;padding:5px 12px;border-radius:999px;border:1px solid var(--ln);color:var(--dim);white-space:nowrap}
      .sw-pill.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,transparent);background:color-mix(in srgb,var(--ok) 12%,transparent)}
      .sw-pill.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,transparent);background:color-mix(in srgb,var(--bad) 12%,transparent)}
      .sw-card{background:var(--pnl);border:1px solid var(--ln);border-radius:16px;padding:20px;margin-bottom:16px}
      .sw-card h2{font-size:16px;font-weight:680;margin:0 0 4px;display:flex;align-items:center;gap:9px}
      .sw-h3{font-size:13.5px;font-weight:680;margin:18px 0 8px;color:var(--tx)}
      .sw-count{font-size:12px;font-weight:650;color:var(--ac);background:var(--ac-soft);border-radius:999px;padding:3px 9px}
      .sw-sub{color:var(--dim);font-size:13.5px;margin:0 0 14px;line-height:1.6;max-width:80ch}
      .sw-sub code,.sw-code,.sw-kv code{font-size:12.5px;background:var(--pnl2);border:1px solid var(--ln);border-radius:5px;padding:1px 5px;color:var(--tx)}
      .sw-code{display:block;padding:8px 10px;word-break:break-all;margin-bottom:6px}
      .sw-lbl{display:block;font-size:12px;font-weight:660;color:var(--dim);margin:14px 0 6px}
      .sw-row{display:flex;gap:10px;flex-wrap:wrap}
      .sw-input{flex:1;min-width:200px;width:100%;font:inherit;font-size:14px;padding:10px 12px;border-radius:10px;
        border:1px solid var(--ln);background:var(--pnl2);color:var(--tx)}
      .sw-input:focus{outline:none;border-color:var(--ac);box-shadow:0 0 0 3px var(--ac-soft)}
      .sw-narrow{flex:0 0 auto;min-width:150px;width:auto}
      .sw-mini{font-size:12px;padding:5px 8px;min-width:150px;width:auto;margin-top:4px}
      .sw-filters{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;align-items:center}
      .sw-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
      .sw-btn{font:inherit;font-size:13.5px;font-weight:640;padding:10px 16px;border-radius:10px;cursor:pointer;
        border:1px solid var(--ln);background:var(--pnl2);color:var(--tx)}
      .sw-btn.primary{background:var(--ac);border-color:var(--ac);color:#fff}
      .sw-btn.danger{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,transparent)}
      .sw-btn.small{font-size:12px;padding:6px 12px}
      .sw-btn:disabled{opacity:.5;cursor:not-allowed}
      .sw-note{padding:11px 14px;border-radius:11px;font-size:13.5px;margin-bottom:14px;border:1px solid var(--ln);color:var(--dim)}
      .sw-note.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 34%,transparent);background:color-mix(in srgb,var(--ok) 10%,transparent)}
      .sw-note.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 34%,transparent);background:color-mix(in srgb,var(--bad) 10%,transparent)}
      .sw-note b{color:inherit}
      .sw-kv{display:flex;gap:10px;align-items:center;margin-top:6px;font-size:13px}
      .sw-kv span{min-width:80px;color:var(--dim)}
      .sw-table-wrap{overflow-x:auto;margin-bottom:8px}
      .sw-table{width:100%;border-collapse:collapse;font-size:13px}
      .sw-table th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim);padding:8px 10px;border-bottom:1px solid var(--ln)}
      .sw-table td{padding:9px 10px;border-bottom:1px solid var(--ln);vertical-align:top}
      .sw-dim{color:var(--dim);font-size:12px}
      .sw-tag{font-size:11px;font-weight:680;border-radius:999px;padding:2px 8px;border:1px solid var(--ln);color:var(--dim)}
      .sw-tag.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,transparent);background:color-mix(in srgb,var(--ok) 12%,transparent)}
      .sw-tag.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,transparent);background:color-mix(in srgb,var(--bad) 12%,transparent)}
      .sw-payload{font-size:12px;white-space:pre-wrap;word-break:break-word;background:transparent;border:0;padding:0;color:var(--tx)}
      .sw-list{margin:8px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:8px;font-size:13.5px;color:var(--dim);line-height:1.6}
      .sw-list b{color:var(--tx)}
    `}</style>
  );
}
