"use client";

import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { apiPost } from "../services/apiClient";
import { ScopedActionButton } from "./ScopedActionButton";

const NEXT_PUBLIC_API_URL =
  typeof window !== "undefined"
    ? (process.env.NEXT_PUBLIC_API_URL || window.location.origin + "/api")
    : "";

type TokenResponse = { token: string; expiresAt: string };

export function QRPairingModal() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ScopedActionButton className="btn" onClick={() => setOpen(true)}>Pair Mobile App</ScopedActionButton>
      {open ? <QRModal onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function QRModal({ onClose }: { onClose: () => void }) {
  const [tokenResp, setTokenResp] = useState<TokenResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchToken = async () => {
    setLoading(true);
    setError("");
    try {
      const resp = await apiPost<TokenResponse>("/voice/mobile-provisioning/token", {});
      setTokenResp(resp);
      const secs = Math.max(0, Math.floor((new Date(resp.expiresAt).getTime() - Date.now()) / 1000));
      setSecondsLeft(secs);

      // Auto-refresh 10 s before expiry
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      const refreshIn = Math.max(0, (secs - 10) * 1000);
      refreshTimer.current = setTimeout(fetchToken, refreshIn);
    } catch (e: any) {
      setError(e?.message || "Failed to generate QR code");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchToken();
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      if (countdownTimer.current) clearInterval(countdownTimer.current);
    };
  }, []);

  // Countdown tick
  useEffect(() => {
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    if (!tokenResp) return;
    countdownTimer.current = setInterval(() => {
      const secs = Math.max(0, Math.floor((new Date(tokenResp.expiresAt).getTime() - Date.now()) / 1000));
      setSecondsLeft(secs);
    }, 1000);
    return () => { if (countdownTimer.current) clearInterval(countdownTimer.current); };
  }, [tokenResp]);

  const qrValue = tokenResp
    ? JSON.stringify({ type: "MOBILE_PROVISIONING", token: tokenResp.token, apiBaseUrl: NEXT_PUBLIC_API_URL })
    : "";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 360, textAlign: "center" }}>
        <h3>Pair Mobile App</h3>
        <p className="muted" style={{ marginBottom: 16 }}>
          Open ConnectComms on your phone and scan this code to link your extension.
        </p>

        {loading && !tokenResp ? (
          <div style={{ height: 220, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div className="loading-spinner" />
            <span className="muted" style={{ marginLeft: 8 }}>Generating…</span>
          </div>
        ) : error ? (
          <div className="state-box" style={{ marginBottom: 16 }}>
            <strong>Error</strong>
            <p style={{ fontSize: 13, marginTop: 4 }}>{error}</p>
            <button className="btn" style={{ marginTop: 8 }} onClick={fetchToken}>Retry</button>
          </div>
        ) : qrValue ? (
          <div style={{ position: "relative", display: "inline-block" }}>
            {loading && (
              <div style={{ position: "absolute", inset: 0, background: "rgba(255,255,255,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1 }}>
                <div className="loading-spinner" />
              </div>
            )}
            <QRCodeSVG value={qrValue} size={220} level="M" style={{ display: "block" }} />
          </div>
        ) : null}

        {secondsLeft > 0 && !error && (
          <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
            Expires in <strong>{secondsLeft}s</strong>
            {secondsLeft <= 15 ? " — refreshing soon…" : ""}
          </p>
        )}

        <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          This QR code is one-time use and expires in 2 minutes.
        </p>

        <button className="btn ghost" style={{ marginTop: 12, width: "100%" }} onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
