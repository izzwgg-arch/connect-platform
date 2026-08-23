"use client";

/**
 * "Loopcom would like to find the phones in your office" — the consent card.
 *
 * ⛔⛔ THIS IS THE ONE THING THAT STAYS IN THE OFFICE. Izzy, 2026-08-23: he wants
 * to run a tenant's phone setup from his own desk while one of THEIR machines does
 * the network work. Everything else moved to his end — but scanning somebody's
 * network needs a person there to agree, exactly as remote support asks the owner
 * of the screen. That single click is also what makes the feature defensible:
 * nobody can say Loopcom crawled their network uninvited.
 *
 * ⛔ It is mounted globally (not on the desk-phones settings page) because the
 * person in that office will be looking at their dashboard or their chat, not at a
 * settings screen somebody else opened. A card only they can press, wherever they
 * are.
 *
 * ⛔ It renders NOTHING unless Loopcom is actually waiting — no card, no polling
 * noise, no "we might want something later". The poll is cheap and stops entirely
 * once the run is consented or gone.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost, hasBrowserAuthToken } from "../../services/apiClient";
import "./deskPhones.css";

type Pending = {
  pending: boolean;
  runId?: string | null;
  needsConsent?: boolean;
  message?: string;
};

/** ⛔ Slow on purpose: this is a "somebody may ask you something" poll, not a
 * live feed. Every signed-in browser in every tenant runs it. */
const POLL_MS = 60_000;

export function LoopcomSetupRequest() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const check = useCallback(async () => {
    // ⛔ Never poll signed out: a dead token here is a 401 stream that can get a
    // whole office auto-banned at nginx (the 2026-08-17 blank-app incident).
    if (!hasBrowserAuthToken()) return;
    try {
      const out = await apiGet<Pending>("/desk-phones/pending");
      setPending(out?.pending ? out : null);
    } catch {
      // A refusal here is normal for anyone without the permission. Stay quiet.
      setPending(null);
    }
  }, []);

  useEffect(() => {
    void check();
    timer.current = setInterval(() => void check(), POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [check]);

  const accept = useCallback(async () => {
    if (!pending?.runId) return;
    setBusy(true);
    try {
      await apiPost(`/desk-phones/runs/${pending.runId}/office-consent`, {});
      // The wizard's own driver takes it from here; this card's job is done.
      setPending(null);
    } catch {
      setBusy(false);
    }
  }, [pending]);

  const decline = useCallback(async () => {
    if (!pending?.runId) return;
    setBusy(true);
    try { await apiPost(`/desk-phones/runs/${pending.runId}/office-stop`, {}); } catch { /* ignore */ }
    setPending(null);
    setBusy(false);
  }, [pending]);

  if (!pending?.pending || !pending.needsConsent || dismissed) return null;

  return (
    <div className="dps-root dps-consent-wrap" role="dialog" aria-label="Loopcom phone setup request">
      <div className="dps-consent">
        <div className="dps-consent-icon" aria-hidden>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--dps-accent)" strokeWidth="1.8">
            <rect x="4" y="2" width="16" height="20" rx="2.5" />
            <rect x="7.5" y="5" width="9" height="4.5" rx="1" />
            <circle cx="9" cy="14" r="1" /><circle cx="12" cy="14" r="1" /><circle cx="15" cy="14" r="1" />
          </svg>
        </div>
        <div className="dps-consent-body">
          <b>Loopcom would like to set up your phones</b>
          <p>
            {pending.message ||
              "Loopcom would like to find the phones in your office and connect them."}{" "}
            Nothing is changed until you say yes, and you can stop it at any time.
          </p>
        </div>
        <div className="dps-consent-actions">
          {/* ⛔ "Not now" is a real answer and sits first — a card whose only
              button is Yes is not a consent card. */}
          <button className="dps-btn dps-btn-g" onClick={() => { setDismissed(true); void decline(); }} disabled={busy}>
            Not now
          </button>
          <button className="dps-btn dps-btn-p" onClick={accept} disabled={busy}>
            {busy ? "Starting…" : "Yes, go ahead"}
          </button>
        </div>
      </div>
    </div>
  );
}
