"use client";

import { useCallback, useEffect, useState } from "react";
import { Mail, Phone } from "lucide-react";
import { useAppContext } from "../../../../hooks/useAppContext";
import { useUiLanguage } from "../../../../hooks/useUiLanguage";
import { apiGet, apiPost, ApiError } from "../../../../services/apiClient";

const PHRASES = [
  "Drivers", "Deliveries", "Add a driver",
  "Driver", "Cell", "App", "Call",
  "Active", "Invited — not set up",
  "Full name", "Cell phone — where reps call him", "Email — the setup link goes here",
  "Create driver & send setup email",
  "He gets an email to choose his password for the driver app. His name and cell number are filled in already — he signs in and he's on the map.",
  "The driver was created and the setup email is on its way.",
  "The driver was created, but the email could not be sent — use Resend.",
  "No drivers yet — add the first one on the right.",
  "Loading…",
] as string[];

type DriverRow = {
  id: string;
  userId: string;
  name: string;
  email: string;
  cell: string;
  appStatus: string;
  active: boolean;
};

function dial(number: string) {
  if (!number) return;
  try {
    window.dispatchEvent(new CustomEvent("crm:dial", { detail: { number } }));
  } catch {
    /* no dialer in this window */
  }
}

export function DriversInner() {
  const { t } = useUiLanguage(PHRASES);
  const { can } = useAppContext();
  const canManage = can("can_manage_tracking_drivers" as never);
  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [cell, setCell] = useState("");
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ drivers: DriverRow[] }>("/supermarket/drivers");
      setDrivers(res.drivers ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = useCallback(async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await apiPost<{ ok: boolean; emailed: boolean }>("/supermarket/drivers/full", { name, cell, email });
      setMsg(res.emailed ? t("The driver was created and the setup email is on its way.") : t("The driver was created, but the email could not be sent — use Resend."));
      setName("");
      setCell("");
      setEmail("");
      void load();
    } catch (e) {
      const body: any = e instanceof ApiError ? e.body : null;
      setErr(body?.message || body?.error || "The driver could not be created.");
    } finally {
      setBusy(false);
    }
  }, [name, cell, email, load, t]);

  const cols = "1.3fr 1fr 1fr auto";

  return (
    <div className="sm-root sm-app">
      <div className="sm-content" style={{ minHeight: "auto" }}>
        <div className="sm-pagehead">
          <h3>{t("Drivers")}</h3>
          <span className="sm-crumb">{t("Deliveries")}</span>
          <span className="sm-spacer" />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: canManage ? "1.5fr 1fr" : "1fr", gap: ".9rem" }}>
          <div className="sm-table" style={{ alignSelf: "start" }}>
            <div className="sm-thead" style={{ gridTemplateColumns: cols }}>
              <span>{t("Driver")}</span><span>{t("Cell")}</span><span>{t("App")}</span><span />
            </div>
            {loading ? (
              <div className="sm-trow" style={{ gridTemplateColumns: cols }}><span className="sm-cellsub">{t("Loading…")}</span><span /><span /><span /></div>
            ) : null}
            {!loading && drivers.length === 0 ? (
              <div className="sm-trow" style={{ gridTemplateColumns: cols }}><span className="sm-cellsub">{t("No drivers yet — add the first one on the right.")}</span><span /><span /><span /></div>
            ) : null}
            {drivers.map((d) => (
              <div className="sm-trow" key={d.id} style={{ gridTemplateColumns: cols }}>
                <div className="sm-who"><b>{d.name}</b><span>{d.email}</span></div>
                <span className="sm-cellsub">{d.cell || "—"}</span>
                <span>
                  {d.appStatus === "ACTIVE" ? (
                    <span className="sm-pill sm-done"><i />{t("Active")}</span>
                  ) : (
                    <span className="sm-pill sm-warn"><i />{t("Invited — not set up")}</span>
                  )}
                </span>
                {d.appStatus === "ACTIVE" ? (
                  <button type="button" className="sm-btn sm-quiet" onClick={() => dial(d.cell)}>
                    <Phone size={12} aria-hidden /> {t("Call")}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="sm-btn sm-quiet"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      apiPost(`/supermarket/drivers/${encodeURIComponent(d.userId)}/resend-invite`)
                        .then(() => setMsg(t("The driver was created and the setup email is on its way.")))
                        .catch((e) => setErr(e instanceof ApiError ? ((e.body as any)?.message ?? "Resend failed.") : "Resend failed."))
                        .finally(() => setBusy(false));
                    }}
                  >
                    <Mail size={12} aria-hidden /> Resend
                  </button>
                )}
              </div>
            ))}
          </div>

          {canManage ? (
            <div className="sm-card" style={{ alignSelf: "start" }}>
              <div className="sm-card-h">{t("Add a driver")}</div>
              <div className="sm-card-b">
                <div className="sm-flab">{t("Full name")}</div>
                <div className="sm-fieldbox">
                  <input value={name} onChange={(e) => setName(e.target.value)} aria-label={t("Full name")}
                    style={{ flex: 1, background: "transparent", border: 0, outline: "none", color: "inherit", font: "inherit" }} />
                </div>
                <div className="sm-flab">{t("Cell phone — where reps call him")}</div>
                <div className="sm-fieldbox">
                  <input value={cell} inputMode="tel" onChange={(e) => setCell(e.target.value)} aria-label={t("Cell phone — where reps call him")}
                    style={{ flex: 1, background: "transparent", border: 0, outline: "none", color: "inherit", font: "inherit" }} />
                </div>
                <div className="sm-flab">{t("Email — the setup link goes here")}</div>
                <div className="sm-fieldbox">
                  <input value={email} inputMode="email" onChange={(e) => setEmail(e.target.value)} aria-label={t("Email — the setup link goes here")}
                    style={{ flex: 1, background: "transparent", border: 0, outline: "none", color: "inherit", font: "inherit" }} />
                </div>
                <div className="sm-actions" style={{ justifyContent: "stretch", marginTop: "1rem" }}>
                  <button
                    type="button"
                    className="sm-btn sm-primary"
                    style={{ width: "100%", justifyContent: "center" }}
                    disabled={busy || name.trim().length < 2 || cell.trim().length < 7 || !email.includes("@")}
                    onClick={() => void create()}
                  >
                    <Mail size={13} aria-hidden /> {t("Create driver & send setup email")}
                  </button>
                </div>
                {msg ? <p className="sm-mut" role="status">{msg}</p> : null}
                {err ? <p className="sm-mut" role="alert">{err}</p> : null}
                <p className="sm-mut">{t("He gets an email to choose his password for the driver app. His name and cell number are filled in already — he signs in and he's on the map.")}</p>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
