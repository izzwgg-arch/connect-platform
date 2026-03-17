"use client";

import { useTelephony } from "../../../../../../contexts/TelephonyContext";
import { PageHeader } from "../../../../../../components/PageHeader";
import { DetailCard } from "../../../../../../components/DetailCard";
import { StatusChip } from "../../../../../../components/StatusChip";

function ago(isoOrNull: string | null): string {
  if (!isoOrNull) return "never";
  const ms = Date.now() - new Date(isoOrNull).getTime();
  if (ms < 2_000) return "just now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}

function uptime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return [h ? `${h}h` : "", m ? `${m}m` : "", `${s}s`].filter(Boolean).join(" ");
}

export default function TelephonyStatusPage() {
  const ctx = useTelephony();
  const { health, status: wsStatus, activeCalls, extensionList, queueList, lastSnapshotAt } = ctx;

  const wsStatusTone = wsStatus === "connected" ? "success" : wsStatus === "connecting" ? "warning" : "danger";

  return (
    <div className="stack compact-stack">
      <PageHeader
        title="Telephony Status"
        subtitle="Live debug view — AMI events, ARI REST health, active calls, extensions, and queues."
      />

      {/* ── WebSocket connection ─────────────────────────────────── */}
      <DetailCard title="WebSocket to Telephony Service">
        <div className="row-wrap">
          <StatusChip tone={wsStatusTone} label={`WS: ${wsStatus}`} />
          {lastSnapshotAt && (
            <span className="muted" style={{ fontSize: 12 }}>
              Last snapshot {ago(lastSnapshotAt)}
            </span>
          )}
        </div>
        {wsStatus !== "connected" && (
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Set <code>NEXT_PUBLIC_TELEPHONY_WS_URL</code> and ensure the telephony service is
            running on port 3003.
          </p>
        )}
      </DetailCard>

      {/* ── PBX connections ──────────────────────────────────────── */}
      {health && (
        <section className="grid two" style={{ gap: 12 }}>
          <DetailCard title="AMI (Asterisk Manager Interface)">
            <div className="row-wrap">
              <StatusChip
                tone={health.ami.connected ? "success" : "danger"}
                label={health.ami.connected ? "Connected" : "Disconnected"}
              />
              <span className="muted" style={{ fontSize: 12 }}>
                Last event: {ago(health.ami.lastEventAt)}
              </span>
            </div>
            {health.ami.lastError && (
              <p className="muted" style={{ fontSize: 12, color: "var(--color-danger, red)", marginTop: 6 }}>
                Error: {health.ami.lastError}
              </p>
            )}
            <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              Primary event source. PBX host: <code>{health.pbxHost}</code>
            </p>
          </DetailCard>

          <DetailCard title="ARI REST (Asterisk REST Interface)">
            <div className="row-wrap">
              <StatusChip
                tone={health.ari.restHealthy ? "success" : "warning"}
                label={health.ari.restHealthy ? "REST Healthy" : "REST Unreachable"}
              />
              <StatusChip tone="neutral" label="WS: Not supported" />
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              Last check: {ago(health.ari.lastCheckAt)}
            </p>
            {health.ari.lastError && (
              <p className="muted" style={{ fontSize: 12, color: "var(--color-warning, orange)", marginTop: 4 }}>
                {health.ari.lastError}
              </p>
            )}
            <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              Used for call-control actions only (hangup, bridge, originate).
              <br />
              <code>res_ari_websockets.so</code> is not available on this PBX build — AMI is
              the event source.
            </p>
          </DetailCard>
        </section>
      )}

      {/* ── System health ────────────────────────────────────────── */}
      {health && (
        <DetailCard title="System Health">
          <div className="row-wrap">
            <StatusChip
              tone={health.status === "ok" ? "success" : health.status === "degraded" ? "warning" : "danger"}
              label={`Status: ${health.status.toUpperCase()}`}
            />
            <span className="muted" style={{ fontSize: 12 }}>
              Uptime: {uptime(health.uptimeSec)}
            </span>
            <span className="muted" style={{ fontSize: 12 }}>
              Active calls: {health.activeCalls}
            </span>
            <span className="muted" style={{ fontSize: 12 }}>
              Extensions: {health.activeExtensions}
            </span>
            <span className="muted" style={{ fontSize: 12 }}>
              Queues: {health.activeQueues}
            </span>
          </div>
        </DetailCard>
      )}

      {/* ── Active calls ─────────────────────────────────────────── */}
      <DetailCard title={`Active Calls (${activeCalls.length})`}>
        {activeCalls.length === 0 ? (
          <p className="muted">No active calls.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--color-border, #e5e7eb)" }}>
                <th style={th}>ID</th>
                <th style={th}>State</th>
                <th style={th}>Direction</th>
                <th style={th}>From</th>
                <th style={th}>To</th>
                <th style={th}>Extension</th>
                <th style={th}>Started</th>
              </tr>
            </thead>
            <tbody>
              {activeCalls.map((call) => (
                <tr key={call.id} style={{ borderBottom: "1px solid var(--color-border, #f3f4f6)" }}>
                  <td style={td}><code style={{ fontSize: 10 }}>{call.id.slice(0, 12)}…</code></td>
                  <td style={td}><StatusChip tone={callTone(call.state)} label={call.state} /></td>
                  <td style={td}>{call.direction}</td>
                  <td style={td}>{call.from ?? "—"}</td>
                  <td style={td}>{call.to ?? "—"}</td>
                  <td style={td}>{call.extensions.join(", ") || "—"}</td>
                  <td style={td}>{ago(call.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </DetailCard>

      {/* ── Extension states ─────────────────────────────────────── */}
      <DetailCard title={`Extension States (${extensionList.length})`}>
        {extensionList.length === 0 ? (
          <p className="muted">No extension state data yet. Requires AMI to be connected.</p>
        ) : (
          <div className="row-wrap">
            {extensionList.map((ext) => (
              <div key={ext.extension} style={extBadge}>
                <span style={{ fontFamily: "monospace", fontSize: 11 }}>{ext.extension}</span>
                <StatusChip tone={extTone(ext.status)} label={ext.status} />
              </div>
            ))}
          </div>
        )}
      </DetailCard>

      {/* ── Queue states ─────────────────────────────────────────── */}
      <DetailCard title={`Queue States (${queueList.length})`}>
        {queueList.length === 0 ? (
          <p className="muted">No queue data yet. Requires AMI to be connected.</p>
        ) : (
          <div className="stack compact-stack">
            {queueList.map((q) => (
              <div key={q.queueName} style={{ display: "flex", gap: 12, alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--color-border, #f3f4f6)" }}>
                <strong style={{ fontFamily: "monospace", fontSize: 12 }}>{q.queueName}</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  {q.callerCount} waiting · {q.memberCount} agents
                </span>
              </div>
            ))}
          </div>
        )}
      </DetailCard>

      {/* ── Architecture note ────────────────────────────────────── */}
      <DetailCard title="Architecture">
        <pre style={{ fontSize: 11, lineHeight: 1.6, whiteSpace: "pre-wrap", color: "var(--color-muted, #6b7280)" }}>
{`Event flow:
  PBX (Asterisk) ──AMI TCP:5038──▶ Telephony service ──WS /ws/telephony──▶ Dashboard

Call control:
  Dashboard / API ──▶ Telephony service ──ARI REST :8088──▶ PBX (Asterisk)

Browser / mobile calling:
  Browser/Mobile ──SIP over WSS :8089──▶ PBX (Asterisk)
  (SIP credentials issued via /voice/me/extension + /voice/me/reset-sip-password)

ARI WebSocket:
  NOT available — res_ari_websockets.so not present on this PBX build.
  AMI is the sole live-event source. ARI REST is used for control actions only.`}
        </pre>
      </DetailCard>
    </div>
  );
}

// ── Style helpers ─────────────────────────────────────────────────────────────

const th: React.CSSProperties = { textAlign: "left", padding: "4px 8px", fontWeight: 600, fontSize: 11 };
const td: React.CSSProperties = { padding: "4px 8px", verticalAlign: "middle" };
const extBadge: React.CSSProperties = { display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "6px 8px", borderRadius: 4, border: "1px solid var(--color-border, #e5e7eb)", minWidth: 70 };

function callTone(state: string): "success" | "warning" | "danger" | "info" | "neutral" {
  if (state === "up") return "success";
  if (state === "ringing" || state === "dialing") return "warning";
  if (state === "hungup") return "neutral";
  return "info";
}

function extTone(status: string): "success" | "warning" | "danger" | "info" | "neutral" {
  if (status === "idle") return "success";
  if (status === "inuse" || status === "ringing") return "warning";
  if (status === "unavailable") return "danger";
  return "info";
}
