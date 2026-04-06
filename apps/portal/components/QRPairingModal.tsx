"use client";

import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { QrCode, X, RefreshCw, Smartphone } from "lucide-react";
import { apiGet, apiPost } from "../services/apiClient";

// Server-side token TTL is 120 s; we refresh 15 s early to avoid expiry races.
const TOKEN_TTL_MS = 120_000;
const REFRESH_BEFORE_EXPIRY_MS = 15_000;

type ExtInfo = {
  extensionNumber: string;
  displayName: string;
  webrtcEnabled: boolean;
  hasSipPassword: boolean;
};

type TokenState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; token: string; expiresAt: Date; qrValue: string }
  | { phase: "error"; message: string; code?: string };

function buildQrValue(token: string): string {
  const apiBase =
    (typeof window !== "undefined"
      ? process.env.NEXT_PUBLIC_API_URL ?? ""
      : "") || "https://app.connectcomunications.com/api";
  return JSON.stringify({
    type: "MOBILE_PROVISIONING",
    token,
    apiBaseUrl: apiBase,
  });
}

function friendlyError(code?: string, message?: string): string {
  if (code === "EXTENSION_NOT_ASSIGNED" || message?.includes("EXTENSION_NOT_ASSIGNED"))
    return "No extension is assigned to your account. Ask your administrator to assign one via PBX → Extensions.";
  if (code === "PBX_NOT_LINKED" || message?.includes("PBX_NOT_LINKED"))
    return "No PBX is linked to this tenant. Contact your administrator.";
  if (code === "SIP_CREDENTIAL_NOT_SET" || message?.includes("SIP_CREDENTIAL_NOT_SET"))
    return "SIP password is not set for your extension. Ask your administrator to set it via PBX → Extensions.";
  if (code === "WEBRTC_DISABLED" || message?.includes("WEBRTC_DISABLED"))
    return "WebRTC is not enabled for your tenant. Ask your administrator to enable it.";
  if (code === "RATE_LIMITED" || message?.includes("RATE_LIMITED"))
    return "Too many requests. Please wait a moment and try again.";
  return message || "Could not generate provisioning code. Try again.";
}

export function QRPairingModal() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<TokenState>({ phase: "idle" });
  const [ext, setExt] = useState<ExtInfo | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearRefreshTimer() {
    if (refreshTimer.current !== null) {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
  }

  async function fetchToken() {
    setState({ phase: "loading" });
    try {
      const res = await apiPost<{ token: string; expiresAt: string }>(
        "/voice/mobile-provisioning/token"
      );
      const expiresAt = new Date(res.expiresAt);
      setState({
        phase: "ready",
        token: res.token,
        expiresAt,
        qrValue: buildQrValue(res.token),
      });
      const msUntilRefresh = Math.max(
        0,
        expiresAt.getTime() - Date.now() - REFRESH_BEFORE_EXPIRY_MS
      );
      refreshTimer.current = setTimeout(fetchToken, msUntilRefresh);
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : "";
      const code = raw.replace(/^.*?(EXTENSION_NOT_ASSIGNED|PBX_NOT_LINKED|SIP_CREDENTIAL_NOT_SET|WEBRTC_DISABLED|RATE_LIMITED).*$/, "$1");
      setState({ phase: "error", message: friendlyError(code, raw), code });
    }
  }

  async function fetchExt() {
    try {
      const data = await apiGet<ExtInfo>("/voice/me/extension");
      setExt(data);
    } catch {
      setExt(null);
    }
  }

  function handleOpen() {
    setOpen(true);
    fetchExt();
    fetchToken();
  }

  function handleClose() {
    setOpen(false);
    clearRefreshTimer();
    setState({ phase: "idle" });
  }

  useEffect(() => () => clearRefreshTimer(), []);

  return (
    <>
      <button
        className="icon-btn"
        onClick={handleOpen}
        title="Provision Mobile (Scan QR)"
        aria-label="Provision Mobile (Scan QR)"
      >
        <QrCode size={16} />
      </button>

      {open && (
        <div
          className="modal-backdrop"
          onClick={handleClose}
          role="dialog"
          aria-modal="true"
          aria-label="Mobile provisioning QR code"
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 400, padding: "28px 28px 24px" }}
          >
            {/* ── Header ── */}
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 36, height: 36, borderRadius: 10,
                  background: "var(--accent-dim, rgba(99,102,241,0.12))",
                  color: "var(--accent)",
                }}>
                  <Smartphone size={18} />
                </span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em" }}>
                    Scan to connect your phone
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                    Open the Connect mobile app and scan to link your extension
                  </div>
                </div>
              </div>
              <button
                className="icon-btn"
                onClick={handleClose}
                aria-label="Close"
                style={{ marginLeft: 8, flexShrink: 0 }}
              >
                <X size={16} />
              </button>
            </div>

            {/* ── Extension info strip ── */}
            {ext && (
              <div style={{
                display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
                background: "var(--surface-2, var(--panel-2))", borderRadius: 9,
                margin: "16px 0 4px", fontSize: 13,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    Ext {ext.extensionNumber}
                    {ext.displayName ? ` · ${ext.displayName}` : ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  {ext.webrtcEnabled
                    ? <span style={{ fontSize: 11, padding: "2px 7px", borderRadius: 5, background: "rgba(16,185,129,0.12)", color: "var(--console-success, #10b981)" }}>WebRTC ✓</span>
                    : <span style={{ fontSize: 11, padding: "2px 7px", borderRadius: 5, background: "rgba(239,68,68,0.12)", color: "var(--console-danger, #ef4444)" }}>WebRTC off</span>}
                  {ext.hasSipPassword
                    ? <span style={{ fontSize: 11, padding: "2px 7px", borderRadius: 5, background: "rgba(16,185,129,0.12)", color: "var(--console-success, #10b981)" }}>SIP ✓</span>
                    : <span style={{ fontSize: 11, padding: "2px 7px", borderRadius: 5, background: "rgba(239,68,68,0.12)", color: "var(--console-danger, #ef4444)" }}>No SIP pwd</span>}
                </div>
              </div>
            )}

            {/* ── QR area ── */}
            <div style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              justifyContent: "center", minHeight: 240, padding: "16px 0 8px",
            }}>
              {state.phase === "loading" && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, color: "var(--text-2)" }}>
                  <RefreshCw size={28} style={{ animation: "spin 1s linear infinite", opacity: 0.6 }} />
                  <span style={{ fontSize: 13 }}>Generating secure code…</span>
                </div>
              )}

              {state.phase === "ready" && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                  <div style={{
                    padding: 12, borderRadius: 12,
                    background: "#fff",
                    boxShadow: "0 0 0 1px var(--border)",
                  }}>
                    <QRCodeSVG
                      value={state.qrValue}
                      size={200}
                      level="M"
                    />
                  </div>
                  <ExpiryCountdown expiresAt={state.expiresAt} />
                </div>
              )}

              {state.phase === "error" && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, textAlign: "center", padding: "0 8px" }}>
                  <div style={{
                    width: 48, height: 48, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center",
                    background: "rgba(239,68,68,0.1)", color: "var(--console-danger, #ef4444)",
                  }}>
                    <QrCode size={22} />
                  </div>
                  <div style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.55 }}>
                    {state.message}
                  </div>
                  <button className="btn" onClick={fetchToken} style={{ fontSize: 12, padding: "6px 16px" }}>
                    Try again
                  </button>
                </div>
              )}
            </div>

            {/* ── Footer instructions ── */}
            {state.phase === "ready" && (
              <p className="muted" style={{ fontSize: 12, textAlign: "center", lineHeight: 1.6, marginTop: 4 }}>
                Code expires automatically and refreshes. Do not share it.
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function ExpiryCountdown({ expiresAt }: { expiresAt: Date }) {
  const [secsLeft, setSecsLeft] = useState(() =>
    Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))
  );

  useEffect(() => {
    const iv = setInterval(() => {
      setSecsLeft(Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(iv);
  }, [expiresAt]);

  const pct = Math.round((secsLeft / (TOKEN_TTL_MS / 1000)) * 100);
  const isLow = secsLeft <= 20;
  const isMid = secsLeft <= 45;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
      <div style={{
        width: 120, height: 4, borderRadius: 4,
        background: "var(--border)",
        overflow: "hidden",
      }}>
        <div style={{
          height: "100%",
          width: `${pct}%`,
          borderRadius: 4,
          background: isLow
            ? "var(--console-danger, #ef4444)"
            : isMid
            ? "#f59e0b"
            : "var(--console-success, #10b981)",
          transition: "width 1s linear, background 0.4s",
        }} />
      </div>
      <span className="muted">
        {secsLeft}s
      </span>
    </div>
  );
}
