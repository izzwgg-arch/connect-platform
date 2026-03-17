"use client";

import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { apiPost } from "../services/apiClient";
import { ScopedActionButton } from "./ScopedActionButton";

// Token TTL on the server is 120s. We refresh 15s early to avoid a race where
// the mobile app scans just before expiry and the server rejects it.
const TOKEN_TTL_MS = 120_000;
const REFRESH_BEFORE_EXPIRY_MS = 15_000;

type TokenState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; token: string; expiresAt: Date; qrValue: string }
  | { phase: "error"; message: string };

function buildQrValue(token: string): string {
  // Payload format consumed by apps/mobile/src/screens/QrProvisionScreen.tsx
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

export function QRPairingModal() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<TokenState>({ phase: "idle" });
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
      // Schedule auto-refresh
      const msUntilRefresh = Math.max(
        0,
        expiresAt.getTime() - Date.now() - REFRESH_BEFORE_EXPIRY_MS
      );
      refreshTimer.current = setTimeout(fetchToken, msUntilRefresh);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to generate QR code";
      setState({ phase: "error", message: msg });
    }
  }

  function handleOpen() {
    setOpen(true);
    fetchToken();
  }

  function handleClose() {
    setOpen(false);
    clearRefreshTimer();
    setState({ phase: "idle" });
  }

  // Clean up timer on unmount
  useEffect(() => {
    return () => clearRefreshTimer();
  }, []);

  return (
    <>
      <ScopedActionButton className="btn" onClick={handleOpen}>
        Pair Mobile App
      </ScopedActionButton>

      {open && (
        <div className="modal-backdrop" onClick={handleClose}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 360 }}
          >
            <h3 style={{ marginBottom: 12 }}>Pair Mobile App</h3>

            {state.phase === "loading" && (
              <div className="qr-box" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 200 }}>
                <span className="muted">Generating QR code…</span>
              </div>
            )}

            {state.phase === "ready" && (
              <>
                <div className="qr-box" style={{ display: "flex", justifyContent: "center", padding: "16px 0" }}>
                  <QRCodeSVG
                    value={state.qrValue}
                    size={200}
                    level="M"
                    includeMargin
                  />
                </div>
                <ExpiryCountdown expiresAt={state.expiresAt} />
              </>
            )}

            {state.phase === "error" && (
              <div className="qr-box" style={{ minHeight: 120, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
                <span className="chip chip-danger">Error</span>
                <span className="muted" style={{ textAlign: "center", fontSize: 13 }}>{state.message}</span>
                <button className="btn" onClick={fetchToken}>Retry</button>
              </div>
            )}

            <p className="muted" style={{ margin: "12px 0 16px", fontSize: 13, textAlign: "center" }}>
              Open the ConnectComms mobile app and scan this code to pair your
              extension. The code expires after 2 minutes.
            </p>
            <button className="btn" onClick={handleClose} style={{ width: "100%" }}>
              Close
            </button>
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
  const tone = secsLeft <= 20 ? "danger" : secsLeft <= 45 ? "warning" : "success";

  return (
    <p
      className="muted"
      style={{ textAlign: "center", fontSize: 12, marginTop: 8 }}
    >
      Code valid for{" "}
      <span className={`chip chip-${tone}`} style={{ fontSize: 11 }}>
        {secsLeft}s
      </span>{" "}
      ({pct}%)
    </p>
  );
}
