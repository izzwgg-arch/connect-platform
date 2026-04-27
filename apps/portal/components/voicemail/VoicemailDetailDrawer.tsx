"use client";

import { Check, Copy, MoreHorizontal, Phone, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WaveformPlayer } from "./WaveformPlayer";
import { callerKind, fmtDuration, fmtListTime } from "./formatting";
import { downloadHrefForVoicemail } from "./mediaBase";
import type { VoicemailFolder, VoicemailRow } from "./types";

type Props = {
  vm: VoicemailRow;
  open: boolean;
  autoPlayAudio: boolean;
  showTenant: boolean;
  notes: string;
  onNotesChange: (text: string) => void;
  onClose: () => void;
  onCall: (num: string) => void;
  onMessage: (num: string) => void;
  onCopyNumber: (num: string) => void;
  onDelete: (id: string) => void;
  onToggleListened: (id: string, listened: boolean) => Promise<void>;
  onSetFolder: (id: string, folder: VoicemailFolder) => Promise<void>;
  deleting: boolean;
  /** mobile / tablet overlay */
  layout: "side" | "overlay";
};

function statusBadge(folder: VoicemailFolder, listened: boolean): { label: string; tone: string } {
  if (folder === "urgent") return { label: "Urgent", tone: "urgent" };
  if (folder === "old") return { label: "Old", tone: "old" };
  if (!listened) return { label: "New", tone: "new" };
  return { label: "Inbox", tone: "played" };
}

export function VoicemailDetailDrawer({
  vm,
  open,
  autoPlayAudio,
  showTenant,
  notes,
  onNotesChange,
  onClose,
  onCall,
  onMessage,
  onCopyNumber,
  onDelete,
  onToggleListened,
  onSetFolder,
  deleting,
  layout,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const badge = useMemo(() => statusBadge(vm.folder, vm.listened), [vm.folder, vm.listened]);
  const kind = callerKind(vm);

  useEffect(() => {
    if (!menuOpen) return;
    function close(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const copyTranscript = useCallback(() => {
    const t = vm.transcription?.trim();
    if (t) void navigator.clipboard.writeText(t);
  }, [vm.transcription]);

  if (!open) return null;

  const panel = (
    <aside
      style={{
        width: layout === "side" ? 400 : "100%",
        maxWidth: layout === "side" ? 440 : "100%",
        height: "100%",
        background: "var(--panel)",
        borderLeft: layout === "side" ? "1px solid var(--border)" : undefined,
        display: "flex",
        flexDirection: "column",
        boxShadow: layout === "overlay" ? "var(--shadow)" : undefined,
        zIndex: 40,
        animation: "vmDrawerIn 0.22s ease-out",
      }}
    >
      <style>{`
        @keyframes vmDrawerIn {
          from { opacity: 0; transform: translateX(12px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>

      <div
        style={{
          padding: "16px 18px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.25 }}>
            {vm.callerName || vm.callerId}
          </div>
          <div style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 4 }}>
            {vm.callerName ? vm.callerId : null}
            {vm.callerName ? " · " : ""}
            Ext {vm.extension}
            {showTenant && vm.tenantName ? ` · ${vm.tenantName}` : ""}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 650,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                padding: "4px 10px",
                borderRadius: 99,
                background:
                  badge.tone === "urgent"
                    ? "rgba(234,96,104,0.15)"
                    : badge.tone === "new"
                      ? "rgba(34,168,255,0.15)"
                      : badge.tone === "old"
                        ? "rgba(142,160,178,0.12)"
                        : "rgba(142,160,178,0.1)",
                color:
                  badge.tone === "urgent"
                    ? "var(--danger)"
                    : badge.tone === "new"
                      ? "var(--accent)"
                      : "var(--text-dim)",
                border: "1px solid var(--border)",
              }}
            >
              {badge.label}
            </span>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "4px 10px",
                borderRadius: 99,
                background: "var(--panel-2)",
                border: "1px solid var(--border)",
                color: "var(--text-dim)",
              }}
            >
              {kind === "internal" ? "Internal" : "External"}
            </span>
          </div>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" style={{ width: 38, height: 38 }}>
          <X size={20} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 20 }}>
        <section>
          <div style={{ fontSize: 11, fontWeight: 650, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
            Playback
          </div>
          <div
            style={{
              padding: 14,
              borderRadius: 16,
              border: "1px solid var(--border)",
              background: "var(--panel-2)",
              boxShadow: "0 4px 20px rgba(0,0,0,0.06)",
            }}
          >
            <WaveformPlayer vm={vm} autoPlay={autoPlayAudio} density="comfortable" />
          </div>
        </section>

        <section>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 650, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Transcript
            </div>
            {vm.transcription?.trim() ? (
              <button type="button" className="btn ghost" style={{ fontSize: 12 }} onClick={copyTranscript}>
                <Copy size={14} style={{ marginRight: 6, verticalAlign: "middle" }} />
                Copy
              </button>
            ) : null}
          </div>
          <div
            style={{
              maxHeight: 200,
              overflowY: "auto",
              padding: "14px 16px",
              borderRadius: 14,
              border: "1px solid var(--border)",
              background: "var(--bg-soft)",
              fontSize: 14,
              lineHeight: 1.65,
              color: "var(--text)",
            }}
          >
            {vm.transcription?.trim() ? (
              vm.transcription
            ) : (
              <span style={{ color: "var(--text-dim)", fontStyle: "italic" }}>No transcript for this message yet.</span>
            )}
          </div>
        </section>

        <section>
          <div style={{ fontSize: 11, fontWeight: 650, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
            Details
          </div>
          <dl style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 14px", fontSize: 13 }}>
            <div>
              <dt style={{ color: "var(--text-dim)", fontSize: 11 }}>Received</dt>
              <dd style={{ margin: "4px 0 0" }}>{fmtListTime(vm.receivedAt)}</dd>
            </div>
            <div>
              <dt style={{ color: "var(--text-dim)", fontSize: 11 }}>Duration</dt>
              <dd style={{ margin: "4px 0 0" }}>{fmtDuration(vm.durationSec)}</dd>
            </div>
            <div>
              <dt style={{ color: "var(--text-dim)", fontSize: 11 }}>Extension</dt>
              <dd style={{ margin: "4px 0 0" }}>{vm.extension}</dd>
            </div>
            <div>
              <dt style={{ color: "var(--text-dim)", fontSize: 11 }}>Message ref</dt>
              <dd style={{ margin: "4px 0 0", wordBreak: "break-all", fontSize: 12 }}>{vm.pbxMessageId ?? vm.id}</dd>
            </div>
          </dl>
        </section>

        <section>
          <div style={{ fontSize: 11, fontWeight: 650, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
            Notes
          </div>
          <textarea
            className="input"
            rows={4}
            placeholder="Private notes (stored on this device only)…"
            value={notes}
            onChange={(e) => onNotesChange(e.target.value)}
            style={{ width: "100%", resize: "vertical", fontSize: 13, lineHeight: 1.5 }}
          />
        </section>

        <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 650, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Actions
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button type="button" className="btn primary" style={{ display: "inline-flex", alignItems: "center", gap: 8 }} onClick={() => onCall(vm.callerId)}>
              <Phone size={16} />
              Call back
            </button>
            <button type="button" className="btn ghost" onClick={() => onMessage(vm.callerId)}>
              Message
            </button>
            <button type="button" className="btn ghost" onClick={() => onCopyNumber(vm.callerId)}>
              <Copy size={14} style={{ marginRight: 6 }} />
              Copy number
            </button>
            <a className="btn ghost" href={downloadHrefForVoicemail(vm.id)} download style={{ display: "inline-flex", alignItems: "center" }}>
              Download
            </a>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <button type="button" className="btn ghost" onClick={() => onToggleListened(vm.id, !vm.listened)}>
              <Check size={16} style={{ marginRight: 6 }} />
              Mark {vm.listened ? "unread" : "read"}
            </button>
            {vm.folder !== "urgent" ? (
              <button type="button" className="btn ghost" style={{ color: "var(--danger)" }} onClick={() => onSetFolder(vm.id, "urgent")}>
                Mark urgent
              </button>
            ) : (
              <button type="button" className="btn ghost" onClick={() => onSetFolder(vm.id, "inbox")}>
                Move to inbox
              </button>
            )}
            <button type="button" className="btn ghost" style={{ color: "var(--danger)" }} disabled={deleting} onClick={() => onDelete(vm.id)}>
              <Trash2 size={16} style={{ marginRight: 6 }} />
              Delete
            </button>

            <div style={{ position: "relative", marginLeft: "auto" }} ref={menuRef}>
              <button type="button" className="icon-btn" aria-label="More" onClick={() => setMenuOpen((v) => !v)}>
                <MoreHorizontal size={20} />
              </button>
              {menuOpen ? (
                <div
                  style={{
                    position: "absolute",
                    right: 0,
                    bottom: "100%",
                    marginBottom: 6,
                    minWidth: 200,
                    padding: 6,
                    borderRadius: 12,
                    border: "1px solid var(--border)",
                    background: "var(--panel)",
                    boxShadow: "var(--shadow)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                  }}
                >
                  <button type="button" className="btn ghost" style={{ justifyContent: "flex-start", fontSize: 13 }} onClick={() => { onSetFolder(vm.id, "old"); setMenuOpen(false); }}>
                    Move to old
                  </button>
                  <button type="button" className="btn ghost" style={{ justifyContent: "flex-start", fontSize: 13 }} onClick={() => { onSetFolder(vm.id, "inbox"); setMenuOpen(false); }}>
                    Move to inbox
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </section>
      </div>
    </aside>
  );

  if (layout === "overlay") {
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 35,
          display: "flex",
          justifyContent: "flex-end",
          background: "rgba(0,0,0,0.45)",
        }}
        onClick={onClose}
      >
        <div onClick={(e) => e.stopPropagation()} style={{ height: "100%", width: "min(100%, 420px)" }}>
          {panel}
        </div>
      </div>
    );
  }

  return panel;
}
