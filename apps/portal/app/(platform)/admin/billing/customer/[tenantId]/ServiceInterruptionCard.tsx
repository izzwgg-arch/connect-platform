"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, apiGet, apiPost, apiPut } from "../../../../../../services/apiClient";

/**
 * Overdue-account service interruption — the switch, and the two manual
 * buttons. SUPER_ADMIN only (the API refuses everyone else with 403).
 *
 * ⛔ Restore and Force are deliberately NOT symmetrical. Restore turns a phone
 * system back ON and is hard to refuse. Force takes a WORKING phone system off
 * on the spot and requires a written reason — a cutoff with no recorded reason
 * is indistinguishable from an accident when someone asks a week later.
 *
 * ⛔ Errors are read from `e.body` and rendered as plain English. `.payload`
 * has never existed on ApiError — see the portal-wide trap in CLAUDE.md.
 */

type State = {
  enabled: boolean;
  graceDays: number | null;
  effectiveGraceDays: number;
  countdownStartedAt: string | null;
  invoiceId: string | null;
  lastReminderAt: string | null;
  lastReminderDaysLeft: number | null;
  interruptedAt: string | null;
  restoredAt: string | null;
  disabledArsMembers: Array<{ arsId: string; outboundRouteId: string }>;
  interrupted: boolean;
  cutoverAt: string | null;
  armed: boolean;
};

const ERROR_TEXT: Record<string, string> = {
  cannot_restore: "Couldn't restore",
  cannot_interrupt: "Couldn't switch off",
  reason_required: "A reason is required",
  no_billing_settings: "This customer has no billing settings yet",
  forbidden: "Only a platform admin can do this",
};

function describe(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const b = (e.body ?? {}) as { error?: string; detail?: unknown };
    const head = ERROR_TEXT[String(b.error || "")] || fallback;
    const detail = typeof b.detail === "string" ? b.detail : "";
    return detail ? `${head} — ${detail}` : head;
  }
  return fallback;
}

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

export function ServiceInterruptionCard({ tenantId }: { tenantId: string }) {
  const [state, setState] = useState<State | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"switch" | "restore" | "force" | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "bad" | "warn"; text: string } | null>(null);
  const [forceOpen, setForceOpen] = useState(false);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setState(await apiGet<State>(`/admin/billing/tenants/${tenantId}/service-interruption`));
    } catch (e) {
      setNotice({ kind: "bad", text: describe(e, "Couldn't load the service interruption settings") });
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async () => {
    if (!state) return;
    setBusy("switch");
    setNotice(null);
    try {
      await apiPut(`/admin/billing/tenants/${tenantId}/service-interruption`, { enabled: !state.enabled });
      setNotice({ kind: "ok", text: state.enabled ? "Switched off — this customer will not be interrupted." : "Switched on." });
      await load();
    } catch (e) {
      setNotice({ kind: "bad", text: describe(e, "Couldn't change the switch") });
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    setBusy("restore");
    setNotice(null);
    try {
      const r = await apiPost<{ ok: boolean; restored: number }>(
        `/admin/billing/tenants/${tenantId}/service-interruption/restore`,
        {},
      );
      setNotice({ kind: "ok", text: `Service restored — ${r.restored} outbound route${r.restored === 1 ? "" : "s"} switched back on.` });
      await load();
    } catch (e) {
      setNotice({ kind: "bad", text: describe(e, "Couldn't restore") });
    } finally {
      setBusy(null);
    }
  };

  const force = async () => {
    setBusy("force");
    setNotice(null);
    try {
      const r = await apiPost<{ ok: boolean; disabled: number }>(
        `/admin/billing/tenants/${tenantId}/service-interruption/interrupt`,
        { reason: reason.trim() },
      );
      setNotice({ kind: "warn", text: `Service switched off — ${r.disabled} outbound route${r.disabled === 1 ? "" : "s"} disabled.` });
      setForceOpen(false);
      setReason("");
      await load();
    } catch (e) {
      setNotice({ kind: "bad", text: describe(e, "Couldn't switch off") });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="cbill-card">
      <div className="cbill-card-hd">
        <h3>Service interruption for non-payment</h3>
        {state?.interrupted ? (
          <span className="cbill-pill bad">Switched off</span>
        ) : state?.countdownStartedAt ? (
          <span className="cbill-pill warn">Countdown running</span>
        ) : state?.enabled ? (
          <span className="cbill-pill info">On</span>
        ) : null}
      </div>
      <div className="cbill-card-bd">
        {loading && !state && <p className="cbill-sub">Loading…</p>}

        {state && !state.armed && (
          <div className="cbill-row">
            <div className="cbill-banner warn" style={{ width: "100%" }}>
              <span>
                The automatic cutoff is not armed on this server (no cutover date set), so nothing
                happens by itself yet. The manual buttons below still work.
              </span>
            </div>
          </div>
        )}

        {state && (
          <div className="cbill-row">
            <div className="cbill-label">
              <span className="t">Automatic cutoff</span>
              <span className="h">
                After a failed payment: a reminder every day, then service switched off after{" "}
                {state.effectiveGraceDays} days, back on the moment they pay. 911 keeps working.
              </span>
            </div>
            <div className="cbill-controls">
              <button
                type="button"
                className="cbill-toggle"
                data-on={state.enabled}
                aria-label="Automatic service interruption"
                disabled={busy !== null}
                onClick={() => void toggle()}
              />
              <span className="cbill-x">{state.enabled ? "on" : "off"}</span>
            </div>
          </div>
        )}

        {state?.countdownStartedAt && !state.interrupted && (
          <div className="cbill-row">
            <div className="cbill-label">
              <span className="t">Countdown</span>
              <span className="h">
                Started {when(state.countdownStartedAt)}
                {state.lastReminderDaysLeft != null ? ` · last reminder said ${state.lastReminderDaysLeft} day${state.lastReminderDaysLeft === 1 ? "" : "s"} left` : ""}
              </span>
            </div>
          </div>
        )}

        {state?.interrupted && (
          <div className="cbill-row">
            <div className="cbill-label">
              <span className="t">Switched off since {when(state.interruptedAt)}</span>
              <span className="h">
                {state.disabledArsMembers.length} outbound route
                {state.disabledArsMembers.length === 1 ? "" : "s"} disabled. Callers hear busy on
                Connect-routed numbers. Emergency calls still go out.
              </span>
            </div>
            <div className="cbill-controls">
              <button
                type="button"
                className="cbill-btn primary"
                disabled={busy !== null}
                onClick={() => void restore()}
              >
                {busy === "restore" ? "Restoring…" : "Restore service now"}
              </button>
            </div>
          </div>
        )}

        {state && !state.interrupted && (
          <div className="cbill-row">
            <div className="cbill-label">
              <span className="t">Switch off now</span>
              <span className="h">
                Takes a working phone system off before the countdown ends. Needs a reason — it goes
                on the record.
              </span>
            </div>
            <div className="cbill-controls">
              {!forceOpen ? (
                <button type="button" className="cbill-btn" disabled={busy !== null} onClick={() => setForceOpen(true)}>
                  Switch off…
                </button>
              ) : (
                <>
                  <input
                    className="cbill-input text"
                    value={reason}
                    placeholder="Why? (at least 8 characters)"
                    onChange={(e) => setReason(e.target.value)}
                    aria-label="Reason for switching off"
                    style={{ minWidth: 260 }}
                  />
                  <button
                    type="button"
                    className="cbill-btn"
                    disabled={busy !== null || reason.trim().length < 8}
                    onClick={() => void force()}
                  >
                    {busy === "force" ? "Switching off…" : "Confirm"}
                  </button>
                  <button type="button" className="cbill-btn" disabled={busy !== null} onClick={() => { setForceOpen(false); setReason(""); }}>
                    Cancel
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {notice && (
          <div className="cbill-row">
            <div className={`cbill-banner ${notice.kind === "ok" ? "ok" : notice.kind === "warn" ? "warn" : "bad"}`} style={{ width: "100%" }}>
              <span>{notice.text}</span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
