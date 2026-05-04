"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ArrowLeftRight, Phone, PhoneIncoming, PhoneOutgoing, Pause } from "lucide-react";
import type { LiveCall } from "../../types/liveCall";

type Props = {
  calls: LiveCall[];
  isLive: boolean;
};

function callStateLabel(state: string): string {
  const s = (state || "").toLowerCase();
  if (s === "ringing" || s === "dialing") return "Ringing";
  if (s === "up") return "Connected";
  if (s === "held") return "On hold";
  if (s === "hungup") return "Ended";
  return state || "—";
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function dirIconFor(direction: string) {
  if (direction === "inbound" || direction === "incoming") return <PhoneIncoming size={14} aria-hidden />;
  if (direction === "outbound" || direction === "outgoing") return <PhoneOutgoing size={14} aria-hidden />;
  return <ArrowLeftRight size={14} aria-hidden />;
}

function dirLabel(direction: string): string {
  if (direction === "inbound" || direction === "incoming") return "Incoming";
  if (direction === "outbound" || direction === "outgoing") return "Outgoing";
  if (direction === "internal") return "Internal";
  return "Call";
}

function dirClass(direction: string): string {
  if (direction === "inbound" || direction === "incoming") return "incoming";
  if (direction === "outbound" || direction === "outgoing") return "outgoing";
  if (direction === "internal") return "internal";
  return "unknown";
}

function counterpartyLabel(call: LiveCall): string {
  if (call.fromName && (call.direction === "inbound" || call.direction === "incoming")) return call.fromName;
  if (call.direction === "outbound" || call.direction === "outgoing") return call.to || call.connectedLine || "—";
  return call.from || call.connectedLine || "—";
}

function handlerLabel(call: LiveCall): string {
  if (call.extensions && call.extensions.length > 0) return `Ext ${call.extensions.join(", ")}`;
  if (call.queueId) return `Queue ${call.queueId}`;
  if (call.trunk) return `Trunk ${call.trunk}`;
  return "—";
}

export function ActiveCallsPanel({ calls, isLive }: Props) {
  // 1-second tick to update live durations
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const liveDurationSec = (call: LiveCall): number => {
    const startedMs = new Date(call.startedAt).getTime();
    if (!Number.isFinite(startedMs)) return call.durationSec ?? 0;
    return Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
  };

  const sorted = [...calls].sort((a, b) => {
    // Ringing first, then connected, then held — within group, longest call first.
    const order: Record<string, number> = { ringing: 0, dialing: 0, up: 1, held: 2, hungup: 3, unknown: 4 };
    const sa = order[(a.state || "unknown").toLowerCase()] ?? 4;
    const sb = order[(b.state || "unknown").toLowerCase()] ?? 4;
    if (sa !== sb) return sa - sb;
    return liveDurationSec(b) - liveDurationSec(a);
  });

  return (
    <section className="dash-v2-section dash-v2-active" aria-label="Active calls">
      <div className="dash-v2-card dash-v2-active-card">
        <div className="dash-v2-card-head">
          <div className="dash-v2-card-head-title">
            <span className="dash-v2-active-icon" aria-hidden>
              <Phone size={16} />
            </span>
            <h2>Active Calls</h2>
            <span className="dash-v2-active-count">{calls.length}</span>
          </div>
          <span className={`dash-v2-active-status ${isLive ? "ok" : "warn"}`}>
            <span aria-hidden /> {isLive ? "Live" : "Reconnecting"}
          </span>
        </div>

        {calls.length === 0 ? (
          <div className="dash-v2-active-empty">
            <Phone size={20} aria-hidden />
            <p>No active calls right now</p>
            <span>Live calls will appear here as they happen.</span>
          </div>
        ) : (
          <ul className="dash-v2-active-list" role="list">
            {sorted.map((call) => {
              const dur = liveDurationSec(call);
              const state = (call.state || "unknown").toLowerCase();
              return (
                <li key={call.id} className={`dash-v2-active-row state-${state} dir-${dirClass(call.direction)}`}>
                  <div className="dash-v2-active-row-dir" aria-label={dirLabel(call.direction)}>
                    {dirIconFor(call.direction)}
                  </div>
                  <div className="dash-v2-active-row-main">
                    <span className="dash-v2-active-row-name">{counterpartyLabel(call)}</span>
                    <span className="dash-v2-active-row-meta">
                      <span className={`dash-v2-active-pill dir-${dirClass(call.direction)}`}>{dirLabel(call.direction)}</span>
                      <span className="dash-v2-active-row-handler">{handlerLabel(call)}</span>
                    </span>
                  </div>
                  <div className="dash-v2-active-row-state">
                    {state === "held" ? <Pause size={12} aria-hidden /> : null}
                    <span>{callStateLabel(call.state)}</span>
                  </div>
                  <div className="dash-v2-active-row-duration" aria-label="Duration">
                    {formatDuration(dur)}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
