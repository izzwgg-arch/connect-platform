"use client";

import { useCallback, useEffect, useState } from "react";
import { Mail } from "lucide-react";
import { useAppContext } from "../../../../hooks/useAppContext";
import { useUiLanguage } from "../../../../hooks/useUiLanguage";
import { apiGet, apiPost, ApiError } from "../../../../services/apiClient";

const PHRASES = [
  "Specials", "Write the weekly special once — it goes to the customer list by email.",
  "Subject", "The special", "Save draft", "Send to the list",
  "Sent", "Draft", "Failed", "recipients",
  "Every email carries a one-click unsubscribe, and an unsubscribed address never gets another special.",
  "The sending lane isn't set up yet — specials never ride the platform mailbox, so nothing was sent.",
  "Past specials", "No specials yet.", "Loading…", "Saved.",
] as string[];

type SpecialRow = {
  id: string;
  subject: string;
  body: string;
  status: string;
  recipientCount: number;
  sentAt: string | null;
  createdAt: string;
};

export function SpecialsInner() {
  const { t } = useUiLanguage(PHRASES);
  const { can } = useAppContext();
  const canSend = can("can_manage_supermarket_specials" as never);
  const [specials, setSpecials] = useState<SpecialRow[]>([]);
  const [laneReady, setLaneReady] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ specials: SpecialRow[]; laneReady: boolean }>("/supermarket/specials");
      setSpecials(res.specials ?? []);
      setLaneReady(Boolean(res.laneReady));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveDraft = useCallback(async (): Promise<string | null> => {
    try {
      const res = await apiPost<{ special: SpecialRow }>("/supermarket/specials", { subject, body });
      setSubject("");
      setBody("");
      setMsg(t("Saved."));
      setErr(null);
      void load();
      return res.special.id;
    } catch (e) {
      const b: any = e instanceof ApiError ? e.body : null;
      setErr(b?.message || "The special could not be saved.");
      return null;
    }
  }, [subject, body, load, t]);

  const sendNow = useCallback(async () => {
    setBusy(true);
    const id = await saveDraft();
    if (!id) {
      setBusy(false);
      return;
    }
    try {
      const res = await apiPost<any>(`/supermarket/specials/${encodeURIComponent(id)}/send`);
      setMsg(`${t("Sent")} — ${res.recipients} ${t("recipients")}.`);
      setErr(null);
    } catch (e) {
      const b: any = e instanceof ApiError ? e.body : null;
      setErr(b?.message || "The blast could not be sent.");
    } finally {
      setBusy(false);
      void load();
    }
  }, [saveDraft, load, t]);

  return (
    <div className="sm-root sm-app">
      <div className="sm-content" style={{ minHeight: "auto", maxWidth: "56rem" }}>
        <div className="sm-pagehead">
          <h3>{t("Specials")}</h3>
          <span className="sm-crumb">{t("Write the weekly special once — it goes to the customer list by email.")}</span>
        </div>

        {!laneReady ? (
          <div
            className="sm-fieldbox"
            style={{ borderColor: "color-mix(in srgb, var(--warning) 50%, transparent)", background: "color-mix(in srgb, var(--warning) 9%, transparent)", marginBottom: ".8rem" }}
          >
            <span style={{ color: "var(--warning)", fontWeight: 700 }}>⚠</span>
            <span style={{ color: "var(--text-dim)", fontSize: ".82rem" }}>{t("The sending lane isn't set up yet — specials never ride the platform mailbox, so nothing was sent.")}</span>
          </div>
        ) : null}

        {canSend ? (
          <div className="sm-card" style={{ marginBottom: ".9rem" }}>
            <div className="sm-card-h">{t("The special")}</div>
            <div className="sm-card-b">
              <div className="sm-flab">{t("Subject")}</div>
              <div className="sm-fieldbox">
                <input value={subject} onChange={(e) => setSubject(e.target.value)} aria-label={t("Subject")}
                  style={{ flex: 1, background: "transparent", border: 0, outline: "none", color: "inherit", font: "inherit" }} />
              </div>
              <div className="sm-flab">{t("The special")}</div>
              <div className="sm-fieldbox" style={{ alignItems: "stretch" }}>
                <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={7} aria-label={t("The special")}
                  style={{ flex: 1, background: "transparent", border: 0, outline: "none", color: "inherit", font: "inherit", resize: "vertical" }} />
              </div>
              <div className="sm-actions">
                <button type="button" className="sm-btn sm-quiet" disabled={busy || subject.trim().length < 3 || body.trim().length < 3} onClick={() => void saveDraft()}>
                  {t("Save draft")}
                </button>
                <button type="button" className="sm-btn sm-primary" disabled={busy || subject.trim().length < 3 || body.trim().length < 3} onClick={() => void sendNow()}>
                  <Mail size={13} aria-hidden /> {t("Send to the list")}
                </button>
              </div>
              {msg ? <p className="sm-mut" role="status">{msg}</p> : null}
              {err ? <p className="sm-mut" role="alert">{err}</p> : null}
              <p className="sm-mut">{t("Every email carries a one-click unsubscribe, and an unsubscribed address never gets another special.")}</p>
            </div>
          </div>
        ) : null}

        <p className="sm-flab">{t("Past specials")}</p>
        <div className="sm-table">
          {loading ? <div className="sm-trow" style={{ gridTemplateColumns: "1fr auto auto" }}><span className="sm-cellsub">{t("Loading…")}</span><span /><span /></div> : null}
          {!loading && specials.length === 0 ? (
            <div className="sm-trow" style={{ gridTemplateColumns: "1fr auto auto" }}><span className="sm-cellsub">{t("No specials yet.")}</span><span /><span /></div>
          ) : null}
          {specials.map((s) => (
            <div className="sm-trow" key={s.id} style={{ gridTemplateColumns: "1fr auto auto" }}>
              <div className="sm-who"><b>{s.subject}</b><span>{new Date(s.createdAt).toLocaleString()}</span></div>
              <span className="sm-cellsub">{s.recipientCount > 0 ? `${s.recipientCount} ${t("recipients")}` : ""}</span>
              <span>
                {s.status === "SENT" ? <span className="sm-pill sm-done"><i />{t("Sent")}</span>
                  : s.status === "FAILED" ? <span className="sm-pill sm-warn"><i />{t("Failed")}</span>
                  : <span className="sm-pill sm-info"><i />{t("Draft")}</span>}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
