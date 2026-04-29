"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Copy, QrCode, RefreshCw, Smartphone, X } from "lucide-react";
import { apiPost, getPortalApiBaseUrl } from "../services/apiClient";

const REFRESH_BEFORE_EXPIRY_MS = 15_000;

type OpenArgs = {
  connectExtensionId: string;
  memberName: string;
  extensionNumber: string;
  tenantName: string;
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
      : "") || getPortalApiBaseUrl();
  return JSON.stringify({
    type: "MOBILE_PROVISIONING",
    token,
    apiBaseUrl: apiBase,
  });
}

function friendlyError(code?: string, message?: string): string {
  if (code === "TENANT_CONTEXT_REQUIRED" || message?.includes("TENANT_CONTEXT_REQUIRED")) {
    return "Select a specific workspace (not “All workspaces”) to generate pairing codes.";
  }
  if (code === "EXTENSION_NOT_ASSIGNED" || message?.includes("EXTENSION_NOT_ASSIGNED")) {
    return "This extension has no assigned user, so it cannot be paired.";
  }
  if (code === "PBX_NOT_LINKED" || message?.includes("PBX_NOT_LINKED")) {
    return "No PBX is linked to this tenant.";
  }
  if (code === "SIP_CREDENTIAL_NOT_SET" || message?.includes("SIP_CREDENTIAL_NOT_SET")) {
    return "SIP credentials are not set for this extension. Set them in PBX → Extensions.";
  }
  if (code === "WEBRTC_DISABLED" || message?.includes("WEBRTC_DISABLED")) {
    return "WebRTC is not enabled for this extension or tenant.";
  }
  if (code === "EXTENSION_SUSPENDED" || message?.includes("EXTENSION_SUSPENDED")) {
    return "This extension is suspended.";
  }
  if (code === "EXTENSION_NOT_PAIRABLE" || message?.includes("EXTENSION_NOT_PAIRABLE")) {
    return "This extension cannot be used for mobile pairing.";
  }
  if (code === "RATE_LIMITED" || message?.includes("RATE_LIMITED")) {
    return "Too many requests. Please wait a moment and try again.";
  }
  if (code === "extension_not_found" || message?.includes("extension_not_found")) {
    return "Extension not found for this workspace.";
  }
  return message || "Could not generate pairing code. Try again.";
}

export function AdminExtensionPairingQrModal(props: {
  open: boolean;
  target: OpenArgs | null;
  onClose: () => void;
}) {
  const { open, target, onClose } = props;
  const [state, setState] = useState<TokenState>({ phase: "idle" });
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimer.current !== null) {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
  }, []);

  const fetchToken = useCallback(async () => {
    if (!target?.connectExtensionId) return;
    setState({ phase: "loading" });
    try {
      const res = await apiPost<{
        token: string;
        expiresAt: string;
        extension?: { displayName?: string; extensionNumber?: string };
        tenant?: { name?: string };
      }>(`/admin/extensions/${encodeURIComponent(target.connectExtensionId)}/pairing-qr`);
      const expiresAt = new Date(res.expiresAt);
      setState({
        phase: "ready",
        token: res.token,
        expiresAt,
        qrValue: buildQrValue(res.token),
      });
      const msUntilRefresh = Math.max(0, expiresAt.getTime() - Date.now() - REFRESH_BEFORE_EXPIRY_MS);
      refreshTimer.current = setTimeout(fetchToken, msUntilRefresh);
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : "";
      const code = raw.replace(
        /^.*?(TENANT_CONTEXT_REQUIRED|EXTENSION_NOT_ASSIGNED|PBX_NOT_LINKED|SIP_CREDENTIAL_NOT_SET|WEBRTC_DISABLED|EXTENSION_SUSPENDED|EXTENSION_NOT_PAIRABLE|RATE_LIMITED|extension_not_found).*$/,
        "$1",
      );
      setState({ phase: "error", message: friendlyError(code, raw), code });
    }
  }, [target?.connectExtensionId]);

  useEffect(() => {
    if (!open || !target) {
      clearRefreshTimer();
      setState({ phase: "idle" });
      return;
    }
    fetchToken();
    return () => clearRefreshTimer();
  }, [open, target, fetchToken, clearRefreshTimer]);

  const handleCopyPayload = useCallback(async () => {
    if (state.phase !== "ready") return;
    try {
      await navigator.clipboard.writeText(state.qrValue);
    } catch {
      /* ignore */
    }
  }, [state]);

  if (!open || !target) return null;

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="admin-pair-qr-title"
    >
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 420, padding: "28px 28px 24px" }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 36,
                height: 36,
                borderRadius: 10,
                background: "var(--accent-dim, rgba(99,102,241,0.12))",
                color: "var(--accent)",
              }}
            >
              <Smartphone size={18} />
            </span>
            <div>
              <div id="admin-pair-qr-title" style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em" }}>
                Pair mobile app
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                {target.memberName} · Ext {target.extensionNumber}
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                {target.tenantName}
              </div>
            </div>
          </div>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close" style={{ marginLeft: 8, flexShrink: 0 }}>
            <X size={16} />
          </button>
        </div>

        <p className="muted" style={{ fontSize: 12, lineHeight: 1.55, margin: "14px 0 8px" }}>
          Open the Connect mobile app and scan this QR code to pair this extension.
        </p>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: 220,
            padding: "12px 0 8px",
          }}
        >
          {state.phase === "loading" && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, color: "var(--text-2)" }}>
              <RefreshCw size={28} style={{ animation: "spin 1s linear infinite", opacity: 0.6 }} />
              <span style={{ fontSize: 13 }}>Generating secure code…</span>
            </div>
          )}

          {state.phase === "ready" && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
              <div
                style={{
                  padding: 12,
                  borderRadius: 12,
                  background: "#fff",
                  boxShadow: "0 0 0 1px var(--border)",
                }}
              >
                <QRCodeSVG value={state.qrValue} size={200} level="M" />
              </div>
              <ExpiryBar expiresAt={state.expiresAt} />
            </div>
          )}

          {state.phase === "error" && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, textAlign: "center", padding: "0 8px" }}>
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 12,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "rgba(239,68,68,0.1)",
                  color: "var(--console-danger, #ef4444)",
                }}
              >
                <QrCode size={22} />
              </div>
              <div style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.55 }}>{state.message}</div>
              <button className="btn" type="button" onClick={fetchToken} style={{ fontSize: 12, padding: "6px 16px" }}>
                Try again
              </button>
            </div>
          )}
        </div>

        {state.phase === "ready" ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginTop: 8 }}>
            <button className="btn ghost" type="button" style={{ fontSize: 12 }} onClick={handleCopyPayload}>
              <Copy size={14} style={{ marginRight: 6 }} />
              Copy pairing payload
            </button>
            <button className="btn ghost" type="button" style={{ fontSize: 12 }} onClick={() => { clearRefreshTimer(); fetchToken(); }}>
              <RefreshCw size={14} style={{ marginRight: 6 }} />
              New code
            </button>
            <button className="btn" type="button" style={{ fontSize: 12 }} onClick={onClose}>
              Close
            </button>
          </div>
        ) : null}

        {state.phase === "ready" ? (
          <p className="muted" style={{ fontSize: 11, textAlign: "center", lineHeight: 1.5, marginTop: 12 }}>
            Code expires automatically. Do not share it. Each scan consumes one code.
          </p>
        ) : null}
      </div>
    </div>
  );
}

const TOKEN_TTL_MS = 120_000;

function ExpiryBar({ expiresAt }: { expiresAt: Date }) {
  const [secsLeft, setSecsLeft] = useState(() => Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)));

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
      <div
        style={{
          width: 120,
          height: 4,
          borderRadius: 4,
          background: "var(--border)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            borderRadius: 4,
            background: isLow ? "var(--console-danger, #ef4444)" : isMid ? "#f59e0b" : "var(--console-success, #10b981)",
            transition: "width 1s linear, background 0.4s",
          }}
        />
      </div>
      <span className="muted">{secsLeft}s</span>
    </div>
  );
}
