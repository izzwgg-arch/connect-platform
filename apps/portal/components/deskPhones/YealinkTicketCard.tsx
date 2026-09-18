"use client";

/**
 * Admin → Integrations → Yealink ticket portal (MAC release) (round 23, 2026-09-17).
 * Platform-wide, not per company: one Loopcom ticket.yealink.com session files release
 * requests for any tenant's Yealink still RPS-held by a previous provider — the office
 * wizard's own conflict path (`yealinkRedirectClaim.ts`) fires it automatically; this
 * card is where the one-time sign-in gets stored, and a manual filing door for staff.
 *
 * ⛔ Write-only, mirroring GdmsCredentialsCard exactly: the api hands back masked hints,
 * never the cookie, and the paste field is cleared the moment a save lands. Verify only
 * reads Yealink's own usage counter; it never files anything.
 */

import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost, ApiError } from "../../services/apiClient";

type Described = { configured: boolean; savedAt: string | null; note: string | null };

const BASE = "/admin/desk-phones/yealink-ticket-session";
const INPUT_STYLE = { flex: 1, background: "transparent", border: 0, outline: "none", color: "inherit", font: "inherit", resize: "vertical" as const };

function errText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const b: any = e.body;
    return b?.message || b?.error || e.message || fallback;
  }
  return fallback;
}

function fmt(iso: string | null): string {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

export function YealinkTicketCard() {
  const [described, setDescribed] = useState<Described | null>(null);
  const [cookie, setCookie] = useState("");
  const [mac, setMac] = useState("");
  const [serial, setSerial] = useState("");
  const [usage, setUsage] = useState<{ removedCount: number; errorCount: number } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ session: Described }>(BASE);
      setDescribed(res.session ?? null);
    } catch (e) {
      setErr(errText(e, "The Yealink ticket-portal status could not be loaded."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(async (work: () => Promise<string>, fallback: string) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg(await work());
      setErr(null);
    } catch (e) {
      setErr(errText(e, fallback));
    } finally {
      setBusy(false);
    }
  }, []);

  const save = () =>
    run(async () => {
      try {
        const res = await apiPost<{ session: Described }>(BASE, { cookie });
        setDescribed(res.session ?? null);
        setUsage(null);
        return "Session saved. Press Verify to prove it still works.";
      } finally {
        // Never keep the cookie in the page longer than the request.
        setCookie("");
      }
    }, "The session could not be saved.");

  const clear = () =>
    run(async () => {
      const res = await apiDelete<{ session: Described }>(BASE);
      setDescribed(res.session ?? null);
      setUsage(null);
      return "Yealink ticket-portal session cleared.";
    }, "The session could not be cleared.");

  const verify = () =>
    run(async () => {
      const res = await apiPost<{ removedCount: number; errorCount: number }>(`${BASE}/verify`, {});
      setUsage({ removedCount: res.removedCount, errorCount: res.errorCount });
      return "The saved session still works. Nothing was changed at Yealink.";
    }, "Yealink didn't accept the saved session.");

  const file = () =>
    run(async () => {
      const res = await apiPost<{ ticketId: string }>(`${BASE}/file`, { mac, serial });
      return `Release ticket ${res.ticketId} filed with Yealink.`;
    }, "The release ticket could not be filed.");

  const canSave = cookie.trim().length > 0;
  const canFile = mac.trim().length >= 12 && serial.trim().length >= 6;

  return (
    <div className="sm-card" style={{ marginBottom: "1rem" }}>
      <div className="sm-card-h">Yealink ticket portal (MAC release)</div>
      <div className="sm-card-b">
        <div className="sm-krow">
          <b>Session</b>
          <span className="sm-k">{described?.configured ? `saved ${fmt(described.savedAt)}` : "not set"}</span>
          {described?.configured ? <span className="sm-pill sm-done"><i />Saved</span> : <span className="sm-pill sm-warn"><i />Missing</span>}
          {described?.configured ? (
            <button type="button" className="sm-btn sm-quiet" disabled={busy} onClick={() => void verify()}>Verify</button>
          ) : (
            <span />
          )}
        </div>

        <div className="sm-actions" style={{ justifyContent: "flex-start", marginTop: ".8rem", gap: ".5rem", flexWrap: "wrap" }}>
          <div className="sm-fieldbox" style={{ flex: 1, minWidth: "18rem" }}>
            <textarea
              value={cookie}
              onChange={(e) => setCookie(e.target.value)}
              placeholder="Paste the Cookie request header here"
              aria-label="ticket.yealink.com Cookie header"
              autoComplete="off"
              rows={2}
              style={INPUT_STYLE}
            />
          </div>
          <button type="button" className="sm-btn sm-ghost" disabled={busy || !canSave} onClick={() => void save()}>Save</button>
          {described?.configured ? (
            <button type="button" className="sm-btn sm-quiet" disabled={busy} onClick={() => void clear()}>Clear</button>
          ) : null}
        </div>

        {usage ? (
          <p className="sm-mut">Today at Yealink: {usage.removedCount} of 20 releases used, {usage.errorCount} of 5 mismatch errors.</p>
        ) : null}

        {described?.configured ? (
          <div className="sm-actions" style={{ justifyContent: "flex-start", marginTop: ".8rem", gap: ".5rem", flexWrap: "wrap" }}>
            <div className="sm-fieldbox" style={{ flex: 1, minWidth: "14rem" }}>
              <input value={mac} onChange={(e) => setMac(e.target.value)} placeholder="Phone MAC, e.g. 80:5E:C0:11:22:33" aria-label="Phone MAC address" autoComplete="off" style={INPUT_STYLE} />
            </div>
            <div className="sm-fieldbox" style={{ flex: 1, minWidth: "12rem" }}>
              <input value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="Serial number" aria-label="Phone serial number" autoComplete="off" style={INPUT_STYLE} />
            </div>
            <button type="button" className="sm-btn sm-quiet" disabled={busy || !canFile} onClick={() => void file()}>File release</button>
          </div>
        ) : null}

        {msg ? <p className="sm-mut" role="status">{msg}</p> : null}
        {err ? <p className="sm-mut" role="alert">{err}</p> : null}
        <p className="sm-mut">
          Sign in at ticket.yealink.com, copy the request Cookie header, paste it here — Loopcom files release requests
          for phones still held by a previous provider. Filing is automatic when the office wizard hits one; the button
          above is only for a phone it hasn't reached yet. Yealink then processes the release itself, over the next few days.
        </p>
      </div>
    </div>
  );
}
