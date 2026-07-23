"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

// Public, no-auth customer tracking page. Token-authenticated by the API. Renders ONLY the
// privacy-filtered view the server returns (progressive map, tiered detail, honest ETA).
// Theme: dark by default (matches the approved mockup exactly); light variant via
// prefers-color-scheme so the page is consistent with the Connect theme in both modes.

type View = {
  statusCode: string;
  statusLabel: string;
  orderRef: string;
  brandName?: string | null;
  eta: string | null;
  stopsAway: number | null;
  movementLabel: string;
  lastUpdated: string | null;
  delayLabel?: string | null;
  locationStale?: boolean;
  map: { show: boolean; exactPin: boolean; approximateArea: boolean; position: { lat: number; lng: number } | null };
  detail: { address?: string; proof?: { method: string; capturedAt: string } } | null;
  contact?: { store?: string | null; phone?: string | null } | null;
};
type Resp = { state: "ok" | "invalid" | "expired" | "revoked" | "not_found" | "verify"; view?: View; verify?: { hint: string } };

function apiBase(): string {
  const env = (process.env.NEXT_PUBLIC_API_URL || "").trim().replace(/\/$/, "");
  if (env) return env;
  if (typeof window !== "undefined") return `${window.location.origin.replace(/\/$/, "")}/api`;
  return "";
}

// Status tones as CSS vars so they adapt per theme (defined in THEME_CSS below).
const TONE_VAR: Record<string, string> = {
  on_the_way: "var(--t-accent)", arriving: "var(--t-accent)", en_route: "var(--t-accent)", out_for_delivery: "var(--t-accent)",
  delivered: "var(--t-success)",
  attempted: "var(--t-warning)", rescheduled: "var(--t-warning)", delayed: "var(--t-warning)",
  canceled: "var(--t-muted)", preparing: "var(--t-muted)", processing: "var(--t-muted)",
};

const THEME_CSS = `
.trk{
  --t-bg:#0c1218; --t-panel:#141f2b; --t-panel2:#1a2635; --t-border:#26374a;
  --t-text:#e1e9f1; --t-muted:#8ea0b2; --t-faint:#5f7186;
  --t-accent:#22a8ff; --t-accent2:#4f7bff; --t-success:#34c27b; --t-warning:#f0b655; --t-danger:#ea6068;
  --t-map1:#16222f; --t-map2:#12303f; --t-chip-fg:#9fd6ff; --t-chip-bg:rgba(12,18,24,.66);
}
@media (prefers-color-scheme: light){
  .trk{
    --t-bg:#eef2f7; --t-panel:#ffffff; --t-panel2:#f4f7fb; --t-border:rgba(136,159,190,.34);
    --t-text:#15233b; --t-muted:#5f7186; --t-faint:#94a3b8;
    --t-accent:#377dff; --t-accent2:#4f7bff; --t-success:#16a34a; --t-warning:#b7791f; --t-danger:#dc2626;
    --t-map1:#dde6f2; --t-map2:#e9eff8; --t-chip-fg:#1e6fbf; --t-chip-bg:rgba(255,255,255,.82);
  }
}
`;

export default function CustomerTrackingPage() {
  const params = useParams<{ token: string }>();
  const token = String(params?.token || "");
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState("");
  const [verifyErr, setVerifyErr] = useState<string | null>(null);
  const [showReport, setShowReport] = useState(false);

  async function load(verifyCode?: string) {
    try {
      const qs = verifyCode ? `?code=${encodeURIComponent(verifyCode)}` : "";
      const res = await fetch(`${apiBase()}/track/${encodeURIComponent(token)}${qs}`);
      const json: Resp = await res.json();
      if (verifyCode && json.state === "verify") setVerifyErr("That code didn't match. Check the SMS and try again.");
      else setVerifyErr(null);
      setData(json);
    } catch {
      setData({ state: "invalid" });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    const t = setInterval(() => load(), 20_000); // near-real-time via polling fallback
    return () => clearInterval(t);
  }, [token]);

  const v = data?.view;
  const tone = v ? TONE_VAR[v.statusCode] || "var(--t-muted)" : "var(--t-muted)";

  return (
    <div className="trk" style={{ minHeight: "100vh", background: "var(--t-bg)", color: "var(--t-text)", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", display: "flex", justifyContent: "center" }}>
      <style dangerouslySetInnerHTML={{ __html: THEME_CSS }} />
      <div style={{ width: "100%", maxWidth: 440, padding: "0 0 40px" }}>
        {/* Brand header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "18px 18px 14px", borderBottom: "1px solid var(--t-border)" }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, background: "linear-gradient(135deg,var(--t-accent),var(--t-accent2))", display: "grid", placeItems: "center" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2"/><circle cx="18.5" cy="18.5" r="2"/></svg>
          </div>
          <b style={{ fontSize: 15 }}>{v?.brandName || "Delivery tracking"}</b>
          {v && <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 600, color: tone, border: `1px solid ${tone}`, background: "color-mix(in srgb, currentColor 12%, transparent)", borderRadius: 999, padding: "3px 10px" }}>{v.statusLabel}</span>}
        </div>

        {loading && !data ? (
          <div style={{ padding: 20, color: "var(--t-muted)" }}>Loading…</div>
        ) : data?.state === "verify" ? (
          // Tiered verification gate — customer enters the code sent by SMS to reveal detail.
          <div style={{ padding: "40px 26px", textAlign: "center" }}>
            <div style={{ fontSize: 26, marginBottom: 12 }}>🔒</div>
            <h1 style={{ fontSize: 18, margin: 0 }}>Verify it's you</h1>
            <p style={{ color: "var(--t-muted)", fontSize: 13.5, marginTop: 10, lineHeight: 1.5 }}>
              {data.verify?.hint || "Enter the code we texted to the phone number on this order."}
            </p>
            <input
              inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="______"
              style={{ marginTop: 16, width: 180, textAlign: "center", letterSpacing: "0.4em", fontSize: 22, fontWeight: 700, padding: "10px 12px", borderRadius: 11, border: "1px solid var(--t-border)", background: "var(--t-panel)", color: "var(--t-text)" }}
            />
            {verifyErr && <p style={{ color: "var(--t-danger)", fontSize: 12.5, marginTop: 10 }}>{verifyErr}</p>}
            <button onClick={() => load(code)} disabled={code.length < 4}
              style={{ display: "block", width: 200, margin: "16px auto 0", padding: 12, borderRadius: 11, border: "1px solid var(--t-accent)", background: "var(--t-accent)", color: "#fff", fontWeight: 700, fontSize: 14, opacity: code.length < 4 ? 0.5 : 1 }}>
              Verify
            </button>
          </div>
        ) : !v ? (
          // failure states — never reveal anything about the order
          <div style={{ padding: "44px 26px", textAlign: "center" }}>
            <div style={{ fontSize: 26, marginBottom: 12 }}>{data?.state === "expired" || data?.state === "revoked" ? "⏱" : "🔗"}</div>
            <h1 style={{ fontSize: 18, margin: 0 }}>
              {data?.state === "expired" || data?.state === "revoked" ? "This tracking link has expired" : "This tracking link isn’t valid"}
            </h1>
            <p style={{ color: "var(--t-muted)", fontSize: 13.5, marginTop: 10, lineHeight: 1.5 }}>
              For your privacy, tracking links stop working after your delivery is complete. If you need help, contact the store.
            </p>
          </div>
        ) : (
          <div style={{ padding: 18 }}>
            {/* delayed / location-stale honest-state banners */}
            {v.delayLabel && (
              <div style={{ marginBottom: 14, padding: "10px 13px", borderRadius: 11, border: "1px solid color-mix(in srgb, var(--t-warning) 45%, transparent)", background: "color-mix(in srgb, var(--t-warning) 12%, transparent)", color: "var(--t-warning)", fontSize: 12.5, fontWeight: 600 }}>
                Running a little late — {v.delayLabel}
              </div>
            )}
            {v.locationStale && (
              <div style={{ marginBottom: 14, padding: "10px 13px", borderRadius: 11, border: "1px solid var(--t-border)", background: "var(--t-panel2)", color: "var(--t-muted)", fontSize: 12.5 }}>
                The driver’s location hasn’t updated in the last few minutes. We’ll refresh it as soon as it’s back.
              </div>
            )}

            {/* map */}
            {v.map.show && (
              <div style={{ position: "relative", height: 180, borderRadius: 12, overflow: "hidden", border: "1px solid var(--t-border)", marginBottom: 16,
                background: "repeating-linear-gradient(0deg,var(--t-map1) 0 39px,var(--t-map2) 39px 40px),repeating-linear-gradient(90deg,var(--t-map1) 0 39px,var(--t-map2) 39px 40px)", filter: v.locationStale ? "grayscale(.6) opacity(.75)" : "none" }}>
                {v.map.exactPin && v.map.position ? (
                  <>
                    <div style={{ position: "absolute", left: "78%", top: "72%", transform: "translate(-50%,-50%)", fontSize: 18 }}>🏠</div>
                    <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-100%)", fontSize: 22 }}>🚚</div>
                    <span style={{ position: "absolute", left: 12, top: 12, fontSize: 11, color: "var(--t-chip-fg)", background: "var(--t-chip-bg)", borderRadius: 6, padding: "2px 8px" }}>exact location</span>
                  </>
                ) : (
                  <>
                    <div style={{ position: "absolute", left: "30%", top: "35%", width: 130, height: 130, borderRadius: "50%",
                      background: "radial-gradient(circle,color-mix(in srgb, var(--t-accent) 28%, transparent),transparent 70%)", border: "1.5px dashed color-mix(in srgb, var(--t-accent) 55%, transparent)" }} />
                    <span style={{ position: "absolute", left: 12, top: 12, fontSize: 11, color: "var(--t-chip-fg)", background: "var(--t-chip-bg)", borderRadius: 6, padding: "2px 8px" }}>approximate area</span>
                  </>
                )}
              </div>
            )}

            <div style={{ fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--t-faint)", fontWeight: 700 }}>
              {v.statusCode === "delivered" ? "Delivered" : v.eta ? "Estimated arrival" : "Status"}
            </div>
            {v.eta ? (
              <div style={{ fontSize: 26, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{v.eta}</div>
            ) : (
              <div style={{ fontSize: 20, fontWeight: 600, marginTop: 2 }}>{v.movementLabel}</div>
            )}
            <p style={{ color: "var(--t-muted)", fontSize: 13, marginTop: 4 }}>
              Order {v.orderRef}
              {v.stopsAway != null && <> · {v.stopsAway === 0 ? "you’re next" : `${v.stopsAway} stops away`}</>}
              {v.lastUpdated && <> · updated {v.lastUpdated}</>}
            </p>

            {v.detail?.address && (
              <div style={{ marginTop: 14, padding: "11px 13px", border: "1px solid var(--t-border)", borderRadius: 11, background: "var(--t-panel)", fontSize: 13 }}>
                <div style={{ color: "var(--t-faint)", fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", fontWeight: 700, marginBottom: 4 }}>Delivering to</div>
                {v.detail.address}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <a href={v.contact?.phone ? `tel:${v.contact.phone}` : undefined}
                style={{ flex: 1, padding: 11, borderRadius: 11, border: "1px solid var(--t-border)", background: "var(--t-panel2)", color: "var(--t-text)", fontWeight: 600, fontSize: 13, textAlign: "center", textDecoration: "none", pointerEvents: v.contact?.phone ? "auto" : "none", opacity: v.contact?.phone ? 1 : 0.6 }}>
                Contact store
              </a>
              <button onClick={() => setShowReport(true)}
                style={{ flex: 1, padding: 11, borderRadius: 11, border: "1px solid var(--t-border)", background: "transparent", color: "var(--t-muted)", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
                Report a problem
              </button>
            </div>
            <p style={{ color: "var(--t-faint)", fontSize: 11, textAlign: "center", marginTop: 14 }}>Live updates · your privacy is protected</p>

            {showReport && (
              <div style={{ marginTop: 12, padding: "13px 14px", border: "1px solid var(--t-border)", borderRadius: 12, background: "var(--t-panel)" }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>What’s wrong?</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  {["It never arrived", "Something’s missing or damaged", "Wrong address", "Other"].map((r) => (
                    <a key={r} href={v.contact?.phone ? `tel:${v.contact.phone}` : undefined}
                      style={{ padding: "9px 11px", borderRadius: 9, border: "1px solid var(--t-border)", background: "var(--t-panel2)", color: "var(--t-text)", fontSize: 12.5, textDecoration: "none" }}>
                      {r}
                    </a>
                  ))}
                </div>
                <button onClick={() => setShowReport(false)} style={{ marginTop: 10, background: "transparent", border: 0, color: "var(--t-muted)", fontSize: 12, cursor: "pointer" }}>Close</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
