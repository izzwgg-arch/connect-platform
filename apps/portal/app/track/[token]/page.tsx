"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

// Public, no-auth customer tracking page. Token-authenticated by the API. Renders ONLY the
// privacy-filtered view the server returns (progressive map, tiered detail, honest ETA).

type View = {
  statusCode: string;
  statusLabel: string;
  orderRef: string;
  eta: string | null;
  stopsAway: number | null;
  movementLabel: string;
  lastUpdated: string | null;
  map: { show: boolean; exactPin: boolean; approximateArea: boolean; position: { lat: number; lng: number } | null };
  detail: { address?: string; proof?: { method: string; capturedAt: string } } | null;
};
type Resp = { state: "ok" | "invalid" | "expired" | "revoked" | "not_found"; view?: View };

function apiBase(): string {
  const env = (process.env.NEXT_PUBLIC_API_URL || "").trim().replace(/\/$/, "");
  if (env) return env;
  if (typeof window !== "undefined") return `${window.location.origin.replace(/\/$/, "")}/api`;
  return "";
}

const TONE: Record<string, string> = {
  on_the_way: "#22a8ff", arriving: "#22a8ff", delivered: "#34c27b",
  attempted: "#f0b655", rescheduled: "#f0b655", canceled: "#8ea0b2", preparing: "#8ea0b2", processing: "#8ea0b2",
};

export default function CustomerTrackingPage() {
  const params = useParams<{ token: string }>();
  const token = String(params?.token || "");
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const res = await fetch(`${apiBase()}/track/${encodeURIComponent(token)}`);
      setData(await res.json());
    } catch {
      setData({ state: "invalid" });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 20_000); // near-real-time via polling fallback
    return () => clearInterval(t);
  }, [token]);

  const v = data?.view;
  const tone = v ? TONE[v.statusCode] || "#8ea0b2" : "#8ea0b2";

  return (
    <div style={{ minHeight: "100vh", background: "#0c1218", color: "#e1e9f1", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", display: "flex", justifyContent: "center" }}>
      <div style={{ width: "100%", maxWidth: 440, padding: "0 0 40px" }}>
        {/* Brand header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "18px 18px 14px", borderBottom: "1px solid #26374a" }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, background: "linear-gradient(135deg,#22a8ff,#4f7bff)" }} />
          <b style={{ fontSize: 15 }}>Delivery tracking</b>
          {v && <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 600, color: tone, border: `1px solid ${tone}55`, background: `${tone}18`, borderRadius: 999, padding: "3px 10px" }}>{v.statusLabel}</span>}
        </div>

        {loading && !data ? (
          <div style={{ padding: 20, color: "#8ea0b2" }}>Loading…</div>
        ) : !v ? (
          // failure states — never reveal anything about the order
          <div style={{ padding: "44px 26px", textAlign: "center" }}>
            <div style={{ fontSize: 26, marginBottom: 12 }}>{data?.state === "expired" || data?.state === "revoked" ? "⏱" : "🔗"}</div>
            <h1 style={{ fontSize: 18, margin: 0 }}>
              {data?.state === "expired" || data?.state === "revoked" ? "This tracking link has expired" : "This tracking link isn’t valid"}
            </h1>
            <p style={{ color: "#8ea0b2", fontSize: 13.5, marginTop: 10, lineHeight: 1.5 }}>
              For your privacy, tracking links stop working after your delivery is complete. If you need help, contact the store.
            </p>
          </div>
        ) : (
          <div style={{ padding: 18 }}>
            {/* map */}
            {v.map.show && (
              <div style={{ position: "relative", height: 180, borderRadius: 12, overflow: "hidden", border: "1px solid #26374a", marginBottom: 16,
                background: "repeating-linear-gradient(0deg,#16222f 0 39px,#12303f 39px 40px),repeating-linear-gradient(90deg,#16222f 0 39px,#12303f 39px 40px)" }}>
                {v.map.exactPin && v.map.position ? (
                  <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-100%)", fontSize: 22 }}>🚚</div>
                ) : (
                  <>
                    <div style={{ position: "absolute", left: "30%", top: "35%", width: 130, height: 130, borderRadius: "50%",
                      background: "radial-gradient(circle,rgba(34,168,255,.28),transparent 70%)", border: "1.5px dashed rgba(34,168,255,.5)" }} />
                    <span style={{ position: "absolute", left: 12, top: 12, fontSize: 11, color: "#9fd6ff", background: "#0c1218aa", borderRadius: 6, padding: "2px 8px" }}>approximate area</span>
                  </>
                )}
              </div>
            )}

            <div style={{ fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase", color: "#5f7186", fontWeight: 700 }}>
              {v.statusCode === "delivered" ? "Delivered" : v.eta ? "Estimated arrival" : "Status"}
            </div>
            {v.eta ? (
              <div style={{ fontSize: 26, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{v.eta}</div>
            ) : (
              <div style={{ fontSize: 20, fontWeight: 600, marginTop: 2 }}>{v.movementLabel}</div>
            )}
            <p style={{ color: "#8ea0b2", fontSize: 13, marginTop: 4 }}>
              Order {v.orderRef}
              {v.stopsAway != null && <> · {v.stopsAway === 0 ? "you’re next" : `${v.stopsAway} stops away`}</>}
              {v.lastUpdated && <> · updated {v.lastUpdated}</>}
            </p>

            {v.detail?.address && (
              <div style={{ marginTop: 14, padding: "11px 13px", border: "1px solid #26374a", borderRadius: 11, background: "#141f2b", fontSize: 13 }}>
                <div style={{ color: "#5f7186", fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", fontWeight: 700, marginBottom: 4 }}>Delivering to</div>
                {v.detail.address}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button style={{ flex: 1, padding: 11, borderRadius: 11, border: "1px solid #26374a", background: "#1a2635", color: "#e1e9f1", fontWeight: 600, fontSize: 13 }}>Contact store</button>
              <button style={{ flex: 1, padding: 11, borderRadius: 11, border: "1px solid #26374a", background: "transparent", color: "#8ea0b2", fontWeight: 600, fontSize: 13 }}>Report a problem</button>
            </div>
            <p style={{ color: "#5f7186", fontSize: 11, textAlign: "center", marginTop: 14 }}>Live updates · your privacy is protected</p>
          </div>
        )}
      </div>
    </div>
  );
}
