"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Phone } from "lucide-react";
import { useUiLanguage } from "../../../../hooks/useUiLanguage";
import { apiGet } from "../../../../services/apiClient";

const PHRASES = [
  "Deliveries — the live map", "Live delivery map",
  "location turned off", "min ago", "last known position kept on the map",
  "Call his cell", "On route", "At stop", "GPS off", "No run",
  "Stop", "of", "run",
  "No drivers are set up yet.", "Add drivers on the Drivers screen — each gets the setup email for the driver app.",
  "No live positions yet — positions appear the moment a driver's app starts a run.",
  "Loading…",
] as string[];

type DriverRow = {
  id: string;
  name: string;
  cell: string;
  driverStatus: string;
  active: boolean;
  activeRunId: string | null;
};
type MapEntry = {
  runId: string;
  driverId: string;
  position: { lat: number; lng: number; heading: number | null } | null;
  movement: string;
  lastUpdateSec: number | null;
};
type RunRow = { id: string; stops?: Array<{ status?: string }>; status?: string };

function initials(name: string): string {
  return name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "DR";
}

const AVATAR_GRADIENTS = [
  "linear-gradient(135deg,#34c27b,#1f8f5a)",
  "linear-gradient(135deg,#4f7bff,#7c3aed)",
  "linear-gradient(135deg,#f0b655,#c47f1d)",
  "linear-gradient(135deg,#22a8ff,#4f7bff)",
];

function dial(number: string) {
  if (!number) return;
  try {
    window.dispatchEvent(new CustomEvent("crm:dial", { detail: { number } }));
  } catch {
    /* dialer not present in this window */
  }
}

export function DeliveriesInner() {
  const { t } = useUiLanguage(PHRASES);
  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [mapState, setMapState] = useState<MapEntry[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [d, m, r] = await Promise.all([
        apiGet<{ drivers: DriverRow[] }>("/supermarket/drivers"),
        apiGet<MapEntry[]>("/delivery/map").catch(() => [] as MapEntry[]),
        apiGet<any>("/delivery/runs").catch(() => ({ runs: [] })),
      ]);
      setDrivers((d.drivers ?? []).filter((x) => x.active));
      setMapState(Array.isArray(m) ? m : []);
      setRuns(Array.isArray(r) ? r : r?.runs ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const byDriver = useMemo(() => {
    const map = new Map<string, MapEntry>();
    for (const e of mapState) map.set(e.driverId, e);
    return map;
  }, [mapState]);

  // GPS-off banner: a driver on an ACTIVE run whose fix went stale/dark.
  const dark = drivers.find((d) => {
    const e = d.activeRunId ? byDriver.get(d.id) : null;
    return Boolean(d.activeRunId) && (!e || !e.position);
  });

  const positioned = mapState.filter((e) => e.position);

  // Project lat/lng into the mockup's 640×400 viewBox.
  const projected = useMemo(() => {
    if (positioned.length === 0) return [] as Array<{ e: MapEntry; x: number; y: number; label: string }>;
    const lats = positioned.map((e) => e.position!.lat);
    const lngs = positioned.map((e) => e.position!.lng);
    const minLat = Math.min(...lats) - 0.002;
    const maxLat = Math.max(...lats) + 0.002;
    const minLng = Math.min(...lngs) - 0.002;
    const maxLng = Math.max(...lngs) + 0.002;
    return positioned.map((e) => {
      const x = 40 + ((e.position!.lng - minLng) / Math.max(1e-6, maxLng - minLng)) * 560;
      const y = 360 - ((e.position!.lat - minLat) / Math.max(1e-6, maxLat - minLat)) * 320;
      const drv = drivers.find((d) => d.id === e.driverId);
      return { e, x, y, label: initials(drv?.name ?? "") };
    });
  }, [positioned, drivers]);

  return (
    <div className="sm-root sm-app">
      <div className="sm-content" style={{ minHeight: "auto" }}>
        <div className="sm-pagehead"><h3>{t("Deliveries — the live map")}</h3></div>

        {dark ? (
          <div
            className="sm-fieldbox"
            style={{
              borderColor: "color-mix(in srgb, var(--warning) 50%, transparent)",
              background: "color-mix(in srgb, var(--warning) 9%, transparent)",
              marginBottom: ".8rem",
            }}
            role="alert"
          >
            <span style={{ color: "var(--warning)", fontWeight: 700 }}>⚠ {dark.name} — {t("location turned off")}</span>
            <span style={{ color: "var(--text-dim)", fontSize: ".8rem" }}>— {t("last known position kept on the map")}</span>
            <span className="sm-spacer" />
            <button type="button" className="sm-btn sm-quiet" onClick={() => dial(dark.cell)}>
              <Phone size={12} aria-hidden /> {t("Call his cell")}
            </button>
          </div>
        ) : null}

        {loading ? <p className="sm-mut">{t("Loading…")}</p> : null}

        <div style={{ display: "grid", gridTemplateColumns: "15.5rem 1fr", gap: ".9rem" }}>
          <div style={{ display: "grid", gap: ".6rem", alignContent: "start" }}>
            {drivers.length === 0 && !loading ? (
              <div className="sm-card"><div className="sm-card-b">
                <p className="sm-mut" style={{ margin: 0 }}>{t("No drivers are set up yet.")}</p>
                <p className="sm-mut">{t("Add drivers on the Drivers screen — each gets the setup email for the driver app.")}</p>
              </div></div>
            ) : null}
            {drivers.map((d, idx) => {
              const entry = d.activeRunId ? byDriver.get(d.id) : null;
              const gpsOff = Boolean(d.activeRunId) && (!entry || !entry.position);
              return (
                <div className="sm-card" key={d.id} style={gpsOff ? { borderColor: "color-mix(in srgb, var(--warning) 50%, transparent)" } : undefined}>
                  <div className="sm-card-b" style={{ padding: ".7rem .85rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: ".55rem", marginBottom: ".3rem" }}>
                      <span className="sm-avatar-sm" style={{ background: AVATAR_GRADIENTS[idx % AVATAR_GRADIENTS.length] }}>{initials(d.name)}</span>
                      <div className="sm-who"><b>{d.name}</b><span>{d.activeRunId ? `${t("run")} #${d.activeRunId.slice(-4)}` : t("No run")}</span></div>
                    </div>
                    <div className="sm-cellsub" style={{ marginBottom: ".45rem" }}>
                      {gpsOff ? (
                        <span className="sm-pill sm-warn"><i />{t("GPS off")}{entry?.lastUpdateSec ? ` · ${Math.round(entry.lastUpdateSec / 60)} ${t("min ago")}` : ""}</span>
                      ) : d.activeRunId ? (
                        <span className="sm-pill sm-move"><i />{entry?.movement === "STOPPED" ? t("At stop") : t("On route")}</span>
                      ) : (
                        <span className="sm-pill sm-info"><i />{d.driverStatus}</span>
                      )}
                    </div>
                    <div className="sm-actions" style={{ justifyContent: "flex-start", margin: 0 }}>
                      <button type="button" className={`sm-btn ${gpsOff ? "sm-primary" : "sm-quiet"}`} style={{ padding: ".3rem .6rem" }} onClick={() => dial(d.cell)}>
                        <Phone size={12} aria-hidden /> {d.cell || "—"}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="sm-card" style={{ overflow: "hidden", minHeight: "26rem" }}>
            <svg viewBox="0 0 640 400" style={{ display: "block", width: "100%", height: "100%", background: "var(--panel-2)" }} role="img" aria-label={t("Live delivery map")}>
              <g stroke="var(--border)" strokeWidth={1}>
                <path d="M0 70 H640 M0 160 H640 M0 250 H640 M0 340 H640" />
                <path d="M90 0 V400 M210 0 V400 M330 0 V400 M450 0 V400 M560 0 V400" />
                <path d="M0 320 L640 40" strokeWidth={5} opacity={0.5} />
                <path d="M0 320 L640 40" stroke="var(--panel)" strokeWidth={3} />
              </g>
              <text x={500} y={30} fill="var(--text-dim)" fontSize={11} opacity={0.7}>Route 17M</text>
              <text x={100} y={390} fill="var(--text-dim)" fontSize={11} opacity={0.7}>Kiryas Joel</text>
              <text x={470} y={390} fill="var(--text-dim)" fontSize={11} opacity={0.7}>Monroe</text>
              {projected.length === 0 ? (
                <text x={320} y={205} textAnchor="middle" fill="var(--text-dim)" fontSize={13}>
                  {t("No live positions yet — positions appear the moment a driver's app starts a run.")}
                </text>
              ) : (
                projected.map(({ e, x, y, label }) => (
                  <g key={e.runId}>
                    <circle cx={x} cy={y} r={14} fill="var(--accent)" opacity={0.25} />
                    <circle cx={x} cy={y} r={10} fill="var(--accent)" />
                    <text x={x} y={y + 4} textAnchor="middle" fill="var(--sm-accent-ink)" fontSize={9} fontWeight={800}>{label}</text>
                  </g>
                ))
              )}
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
