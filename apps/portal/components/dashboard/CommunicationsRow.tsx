"use client";

import Link from "next/link";
import { MessageSquare, Voicemail, ArrowRight, Play } from "lucide-react";

type VoicemailItem = {
  id: string;
  callerName: string | null;
  callerNumber: string | null;
  durationSec: number;
  receivedAt: string;
  read: boolean;
};

type MessageItem = {
  threadId: string;
  preview: string;
  counterpartyLabel: string;
  createdAt: string;
  unread: boolean;
};

export type CommunicationsData = {
  voicemails: { unread: number; recent: VoicemailItem[] };
  messages: { unread: number; recent: MessageItem[] };
};

type Props = {
  data: CommunicationsData | null;
  loading: boolean;
};

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d`;
  return new Date(iso).toLocaleDateString();
}

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function CommunicationsRow({ data, loading }: Props) {
  const vmCount = data?.voicemails.unread ?? 0;
  const msgCount = data?.messages.unread ?? 0;
  const vmRecent = data?.voicemails.recent ?? [];
  const msgRecent = data?.messages.recent ?? [];

  return (
    <section className="dash-v2-section dash-v2-comm-row" aria-label="Communications">
      <header className="dash-v2-section-head">
        <h2>Communications</h2>
      </header>
      <div className="dash-v2-comm-grid">
        {/* Voicemails */}
        <div className="dash-v2-card dash-v2-comm-card">
          <div className="dash-v2-card-head">
            <div className="dash-v2-card-head-title">
              <span className="dash-v2-comm-icon vm" aria-hidden><Voicemail size={16} /></span>
              <h3>Voicemails</h3>
            </div>
            <span className="dash-v2-comm-count">{loading && !data ? "…" : vmCount}</span>
          </div>
          <p className="dash-v2-comm-sub">{vmCount === 0 ? "No new voicemails" : `${vmCount} unread voicemail${vmCount === 1 ? "" : "s"}`}</p>
          {vmRecent.length === 0 ? (
            <div className="dash-v2-comm-empty">No recent voicemails.</div>
          ) : (
            <ul className="dash-v2-comm-list" role="list">
              {vmRecent.map((vm) => (
                <li key={vm.id} className={`dash-v2-comm-item ${!vm.read ? "is-unread" : ""}`}>
                  <Link href="/voicemail" className="dash-v2-comm-item-link">
                    <span className="dash-v2-comm-item-avatar" aria-hidden>
                      <Play size={11} />
                    </span>
                    <span className="dash-v2-comm-item-body">
                      <span className="dash-v2-comm-item-title">{vm.callerName || vm.callerNumber || "Unknown"}</span>
                      <span className="dash-v2-comm-item-meta">{vm.callerName && vm.callerNumber ? vm.callerNumber : ""}{" · "}{fmtDuration(vm.durationSec)}</span>
                    </span>
                    <span className="dash-v2-comm-item-time">{relativeTime(vm.receivedAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Link href="/voicemail" className="dash-v2-comm-cta">
            Open voicemail <ArrowRight size={14} aria-hidden />
          </Link>
        </div>

        {/* Messages */}
        <div className="dash-v2-card dash-v2-comm-card">
          <div className="dash-v2-card-head">
            <div className="dash-v2-card-head-title">
              <span className="dash-v2-comm-icon msg" aria-hidden><MessageSquare size={16} /></span>
              <h3>Unread Messages</h3>
            </div>
            <span className="dash-v2-comm-count">{loading && !data ? "…" : msgCount}</span>
          </div>
          <p className="dash-v2-comm-sub">{msgCount === 0 ? "You're all caught up" : `${msgCount} unread message${msgCount === 1 ? "" : "s"}`}</p>
          {msgRecent.length === 0 ? (
            <div className="dash-v2-comm-empty">No conversations yet.</div>
          ) : (
            <ul className="dash-v2-comm-list" role="list">
              {msgRecent.map((m) => (
                <li key={m.threadId} className={`dash-v2-comm-item ${m.unread ? "is-unread" : ""}`}>
                  <Link href={`/chat?thread=${encodeURIComponent(m.threadId)}`} className="dash-v2-comm-item-link">
                    <span className="dash-v2-comm-item-avatar msg" aria-hidden>
                      <MessageSquare size={11} />
                    </span>
                    <span className="dash-v2-comm-item-body">
                      <span className="dash-v2-comm-item-title">{m.counterpartyLabel || "Conversation"}</span>
                      <span className="dash-v2-comm-item-meta">{m.preview || "(no content)"}</span>
                    </span>
                    <span className="dash-v2-comm-item-time">{relativeTime(m.createdAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Link href="/chat" className="dash-v2-comm-cta">
            Open messages <ArrowRight size={14} aria-hidden />
          </Link>
        </div>
      </div>
    </section>
  );
}
