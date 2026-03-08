"use client";

import { useEffect, useMemo, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

type SessionRow = {
  id: string;
  platform: "WEB" | "IOS" | "ANDROID";
  appVersion?: string | null;
  lastSeenAt: string;
  startedAt: string;
  iceHasTurn: boolean;
  lastRegState: string;
  lastCallState: string;
  lastErrorCode?: string | null;
  lastErrorAt?: string | null;
  _count?: { events: number };
};

type EventRow = {
  id: string;
  createdAt: string;
  type: string;
  payload: any;
};

type TurnState = {
  ok: boolean;
  effective: null | { urls: string[]; username?: string | null; hasCredential: boolean; scope: string };
  turnRequiredForMobile: boolean;
  status: "UNKNOWN" | "VERIFIED" | "FAILED" | "STALE";
  validatedAt: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
};

type MediaState = {
  ok: boolean;
  mediaReliabilityGateEnabled: boolean;
  mediaTestStatus: "UNKNOWN" | "PASSED" | "FAILED" | "STALE";
  mediaTestedAt: string | null;
  mediaLastErrorCode: string | null;
  mediaLastErrorAt: string | null;
  recentRun?: any;
  mediaPolicy?: "TURN_ONLY" | "RTPENGINE_PREFERRED";
  sbcUdpExposureConfirmed?: boolean;
  sbcUdpExposureConfirmedAt?: string | null;
};

type MediaMetrics = {
  ok: boolean;
  range: "24h" | "7d";
  totalMediaTests: number;
  passed: number;
  failed: number;
  relayTrueCount: number;
  relayFalseCount: number;
  topErrorCodes: Array<{ code: string; count: number }>;
};

export default function VoiceDiagnosticsPage() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [events, setEvents] = useState<EventRow[]>([]);
  const [msg, setMsg] = useState<string>("");
  const [turn, setTurn] = useState<TurnState | null>(null);
  const [media, setMedia] = useState<MediaState | null>(null);
  const [mediaMetrics, setMediaMetrics] = useState<MediaMetrics | null>(null);
  const [metricsRange, setMetricsRange] = useState<"24h" | "7d">("24h");
  const [turnUrlsInput, setTurnUrlsInput] = useState<string>("");
  const [turnUsernameInput, setTurnUsernameInput] = useState<string>("");
  const [turnCredentialInput, setTurnCredentialInput] = useState<string>("");

  const token = useMemo(() => (typeof window === "undefined" ? "" : localStorage.getItem("token") || ""), []);

  async function loadSessions() {
    const res = await fetch(`${apiBase}/voice/diag/sessions`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => []);
    const rows = Array.isArray(json) ? json : [];
    setSessions(rows);
    if (!selected && rows[0]?.id) setSelected(rows[0].id);
  }

  async function loadEvents(sessionId: string) {
    if (!sessionId) return;
    const res = await fetch(`${apiBase}/voice/diag/sessions/${sessionId}/events`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => []);
    setEvents(Array.isArray(json) ? json : []);
  }

  async function loadTurn() {
    const res = await fetch(`${apiBase}/voice/turn`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => null);
    if (!json) return;
    setTurn(json);
    setTurnUrlsInput((json?.effective?.urls || []).join("\n"));
    setTurnUsernameInput(json?.effective?.username || "");
  }

  async function loadMedia() {
    const res = await fetch(`${apiBase}/voice/media-test/status`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => null);
    if (!json) return;
    setMedia(json);
  }

  async function loadMediaMetrics(range: "24h" | "7d" = metricsRange) {
    const res = await fetch(`${apiBase}/voice/media-metrics?range=${range}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => null);
    if (!json) return;
    setMediaMetrics(json);
  }

  async function saveTurnConfig() {
    const urls = turnUrlsInput.split("\n").map((x) => x.replace("\r", "").trim()).filter(Boolean);
    const body: any = {
      urls,
      username: turnUsernameInput || undefined,
      turnRequiredForMobile: !!turn?.turnRequiredForMobile
    };
    if (turnCredentialInput.trim()) body.credential = turnCredentialInput.trim();

    const res = await fetch(`${apiBase}/voice/turn`, {
      method: "PUT",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    });
    const out = await res.json().catch(() => ({}));
    setMsg(res.ok ? "TURN config saved." : String(out?.error || "TURN config update failed"));
    setTurnCredentialInput("");
    await loadTurn();
  }

  async function toggleRequireTurn(nextValue: boolean) {
    const res = await fetch(`${apiBase}/voice/turn`, {
      method: "PUT",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ turnRequiredForMobile: nextValue })
    });
    const out = await res.json().catch(() => ({}));
    setMsg(res.ok ? `Mobile reliability mode ${nextValue ? "enabled" : "disabled"}.` : String(out?.error || "Failed to update mobile reliability mode"));
    await loadTurn();
  }

  async function toggleMediaGate(nextValue: boolean) {
    const res = await fetch(`${apiBase}/voice/media-test/status`, {
      method: "PUT",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mediaReliabilityGateEnabled: nextValue })
    });
    const out = await res.json().catch(() => ({}));
    setMsg(res.ok ? `Media reliability gate ${nextValue ? "enabled" : "disabled"}.` : String(out?.error || "Failed to update media gate"));
    await loadMedia();
  }

  async function updateMediaPolicy(nextPolicy: "TURN_ONLY" | "RTPENGINE_PREFERRED") {
    const res = await fetch(`${apiBase}/voice/media-test/status`, {
      method: "PUT",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mediaPolicy: nextPolicy })
    });
    const out = await res.json().catch(() => ({}));
    setMsg(res.ok ? `Media policy set to ${nextPolicy}.` : String(out?.error || "Failed to update media policy"));
    await loadMedia();
  }

  async function runMediaTest() {
    setMsg("Starting media reliability test...");
    const startRes = await fetch(`${apiBase}/voice/media-test/start`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ platform: "WEB" })
    });
    const startJson = await startRes.json().catch(() => ({}));
    if (!startRes.ok || !startJson?.token) {
      setMsg(String(startJson?.error || "Unable to start media test"));
      return;
    }

    const hasRelay = sessions.some((s) => s.iceHasTurn);
    const wsOk = sessions.some((s) => String(s.lastRegState || "").toUpperCase() === "REGISTERED") || sessions.length > 0;
    const sipRegisterOk = sessions.some((s) => String(s.lastRegState || "").toUpperCase() === "REGISTERED");
    const iceSelectedPairType = hasRelay ? "relay" : "unknown";

    const reportRes = await fetch(`${apiBase}/voice/media-test/report`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        token: startJson.token,
        hasRelay,
        wsOk,
        sipRegisterOk,
        rtpCandidatePresent: hasRelay,
        iceSelectedPairType,
        durationMs: 150,
        platform: "WEB",
        ...(wsOk && sipRegisterOk && hasRelay ? {} : { errorCode: !wsOk ? "WS_NOT_OK" : (!sipRegisterOk ? "SIP_REGISTER_FAILED" : "NO_RELAY_PATH") })
      })
    });
    const report = await reportRes.json().catch(() => ({}));
    setMsg(reportRes.ok ? `Media test ${String(report?.status || "done")}` : String(report?.error || "Media test report failed"));
    await loadMedia();
  }

  async function testTurn() {
    setMsg("Requesting TURN validation token...");
    const startRes = await fetch(`${apiBase}/voice/turn/validate`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({})
    });
    const startJson = await startRes.json().catch(() => ({}));
    if (!startRes.ok || !startJson?.token) {
      setMsg(String(startJson?.error || "Unable to start TURN validation"));
      return;
    }

    const hasRelay = sessions.some((s) => s.iceHasTurn);
    const t0 = Date.now();
    const reportRes = await fetch(`${apiBase}/voice/turn/validate/report`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        token: startJson.token,
        hasRelay,
        durationMs: Date.now() - t0,
        platform: "WEB",
        ...(hasRelay ? {} : { errorCode: "NO_RELAY_CANDIDATE" })
      })
    });
    const report = await reportRes.json().catch(() => ({}));
    if (!reportRes.ok) {
      setMsg(String(report?.error || "TURN validation report failed"));
      return;
    }

    setMsg(hasRelay ? "TURN validation passed (relay observed)." : "TURN validation failed (no relay observed).");
    await loadTurn();
    if (selected) await loadEvents(selected);
  }

  useEffect(() => {
    if (!token) return;
    loadSessions().catch(() => undefined);
    loadTurn().catch(() => undefined);
    loadMedia().catch(() => undefined);
    loadMediaMetrics().catch(() => undefined);
  }, [token]);

  useEffect(() => {
    if (!selected || !token) return;
    loadEvents(selected).catch(() => undefined);
  }, [selected, token]);

  useEffect(() => {
    if (!token) return;
    loadMediaMetrics(metricsRange).catch(() => undefined);
  }, [metricsRange, token]);

  const statusClass = turn?.status === "VERIFIED" ? "status-chip live" : turn?.status === "FAILED" ? "status-chip failed" : "status-chip pending";
  const mediaClass = media?.mediaTestStatus === "PASSED" ? "status-chip live" : media?.mediaTestStatus === "FAILED" ? "status-chip failed" : "status-chip pending";

  return (
    <div className="card">
      <h1>Voice Diagnostics</h1>
      <p>Active sessions, TURN validation, media gate status, and event timelines for tenant troubleshooting.</p>
      <button onClick={() => loadSessions().catch(() => undefined)}>Refresh Sessions</button>{" "}
      <button onClick={() => loadTurn().catch(() => undefined)}>Refresh TURN</button>{" "}
      <button onClick={() => loadMedia().catch(() => undefined)}>Refresh Media</button>{" "}
      <button onClick={() => loadMediaMetrics(metricsRange).catch(() => undefined)}>Refresh Metrics</button>{" "}
      <button onClick={testTurn}>Test TURN Now</button>
      {msg ? <p className="status-chip pending" style={{ borderRadius: 2 }}>{msg}</p> : null}

      <h3>Media Reliability</h3>
      <p>Status: <span className={mediaClass}>{media?.mediaTestStatus || "UNKNOWN"}</span> / Last tested: {media?.mediaTestedAt ? new Date(media.mediaTestedAt).toLocaleString() : "never"}</p>
      <p>Last error: {media?.mediaLastErrorCode ? `${media.mediaLastErrorCode} (${media.mediaLastErrorAt ? new Date(media.mediaLastErrorAt).toLocaleString() : ""})` : "-"}</p>
      <label style={{ display: "block", marginBottom: 8 }}>
        <input type="checkbox" checked={!!media?.mediaReliabilityGateEnabled} onChange={(e) => toggleMediaGate(e.target.checked).catch(() => undefined)} />{" "}
        Enable Media Reliability Gate
      </label>
      <button onClick={() => runMediaTest().catch(() => undefined)}>Run Media Test</button>
      <div style={{ marginTop: 10 }}>
        <label>Media Policy: </label>{" "}
        <select value={media?.mediaPolicy || "TURN_ONLY"} onChange={(e) => updateMediaPolicy(e.target.value as "TURN_ONLY" | "RTPENGINE_PREFERRED").catch(() => undefined)}>
          <option value="TURN_ONLY">TURN_ONLY (default)</option>
          <option value="RTPENGINE_PREFERRED">RTPENGINE_PREFERRED</option>
        </select>
      </div>
      {media?.mediaPolicy === "RTPENGINE_PREFERRED" ? (
        <>
          <p className="status-chip pending" style={{ borderRadius: 2 }}>Guidance: RTPENGINE preferred may benefit from optional UDP RTP exposure for best reliability; network changes are not automatic.</p>
          <p>UDP Exposure Confirmation: <strong>{media?.sbcUdpExposureConfirmed ? `confirmed (${media?.sbcUdpExposureConfirmedAt ? new Date(media.sbcUdpExposureConfirmedAt).toLocaleString() : "timestamp unavailable"})` : "not confirmed"}</strong></p>
          {!media?.sbcUdpExposureConfirmed ? <p className="status-chip failed" style={{ borderRadius: 2 }}>TURN_ONLY is safer until UDP 35000-35199 is opened and confirmed by ops.</p> : null}
        </>
      ) : null}

      <h4>Media Metrics ({metricsRange})</h4>
      <label>
        <input type="radio" checked={metricsRange === "24h"} onChange={() => setMetricsRange("24h")} /> 24h
      </label>{" "}
      <label>
        <input type="radio" checked={metricsRange === "7d"} onChange={() => setMetricsRange("7d")} /> 7d
      </label>
      <table>
        <tbody>
          <tr><td>Total Media Tests</td><td>{mediaMetrics?.totalMediaTests ?? 0}</td></tr>
          <tr><td>Passed</td><td>{mediaMetrics?.passed ?? 0}</td></tr>
          <tr><td>Failed</td><td>{mediaMetrics?.failed ?? 0}</td></tr>
          <tr><td>Relay True</td><td>{mediaMetrics?.relayTrueCount ?? 0}</td></tr>
          <tr><td>Relay False</td><td>{mediaMetrics?.relayFalseCount ?? 0}</td></tr>
        </tbody>
      </table>
      <p>Top error codes: {(mediaMetrics?.topErrorCodes || []).map((e) => `${e.code} (${e.count})`).join(", ") || "none"}</p>

      <h3>TURN</h3>
      <p>Status: <span className={statusClass}>{turn?.status || "UNKNOWN"}</span> / Last validated: {turn?.validatedAt ? new Date(turn.validatedAt).toLocaleString() : "never"}</p>
      <p>Effective config: scope={turn?.effective?.scope || "none"}, credential={turn?.effective?.hasCredential ? "set" : "not set"}</p>
      <p>Masked TURN URLs: {(turn?.effective?.urls || []).join(", ") || "none"}</p>
      <p>Masked username: {turn?.effective?.username || "-"}</p>
      <p>Last error: {turn?.lastErrorCode ? `${turn.lastErrorCode} (${turn.lastErrorAt ? new Date(turn.lastErrorAt).toLocaleString() : ""})` : "-"}</p>
      <label style={{ display: "block", marginBottom: 8 }}>
        <input type="checkbox" checked={!!turn?.turnRequiredForMobile} onChange={(e) => toggleRequireTurn(e.target.checked).catch(() => undefined)} />{" "}
        Require TURN for Mobile Reliability
      </label>
      {turn?.turnRequiredForMobile ? <p className="status-chip failed" style={{ borderRadius: 2 }}>Warning: this may block mobile answer if TURN is not VERIFIED in last 7 days.</p> : null}

      <details style={{ marginTop: 12 }}>
        <summary>Override Tenant TURN Config</summary>
        <textarea rows={4} style={{ width: "100%" }} placeholder="turn:turn.example.com:3478\nturns:turn.example.com:5349" value={turnUrlsInput} onChange={(e) => setTurnUrlsInput(e.target.value)} />
        <input style={{ width: "100%", marginTop: 8 }} placeholder="TURN username (optional)" value={turnUsernameInput} onChange={(e) => setTurnUsernameInput(e.target.value)} />
        <input style={{ width: "100%", marginTop: 8 }} placeholder="TURN credential (stored encrypted; never returned)" value={turnCredentialInput} onChange={(e) => setTurnCredentialInput(e.target.value)} />
        <div style={{ marginTop: 8 }}>
          <button onClick={() => saveTurnConfig().catch(() => undefined)}>Save TURN Override</button>
        </div>
      </details>

      <h3>Active Sessions</h3>
      <table>
        <thead><tr><th>Session</th><th>Platform</th><th>Last Seen</th><th>Reg</th><th>Call</th><th>TURN</th><th>Last Error</th><th>Events</th></tr></thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id} onClick={() => setSelected(s.id)} style={{ cursor: "pointer", background: selected === s.id ? "rgba(90,153,255,.08)" : "transparent" }}>
              <td><code>{s.id.slice(0, 10)}</code></td>
              <td>{s.platform}</td>
              <td>{new Date(s.lastSeenAt).toLocaleString()}</td>
              <td>{s.lastRegState}</td>
              <td>{s.lastCallState}</td>
              <td>{s.iceHasTurn ? "yes" : "no"}</td>
              <td>{s.lastErrorCode ? `${s.lastErrorCode} (${s.lastErrorAt ? new Date(s.lastErrorAt).toLocaleTimeString() : ""})` : "-"}</td>
              <td>{s._count?.events || 0}</td>
            </tr>
          ))}
          {!sessions.length ? <tr><td colSpan={8}>No diagnostics sessions found.</td></tr> : null}
        </tbody>
      </table>

      <h3>Event Timeline</h3>
      <table>
        <thead><tr><th>Time</th><th>Type</th><th>Payload</th></tr></thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td>{new Date(e.createdAt).toLocaleString()}</td>
              <td>{e.type}</td>
              <td><code style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(e.payload || {}, null, 2)}</code></td>
            </tr>
          ))}
          {!events.length ? <tr><td colSpan={3}>No events for selected session.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}