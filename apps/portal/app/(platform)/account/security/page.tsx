"use client";
/**
 * Account → Security: two-step verification for the signed-in person.
 *
 * v3 (2026-09-08, Izzy, from the approved mockups): ONE method — a 6-digit
 * code by text message or email — turned on and off HERE, by the person, and
 * nowhere else (the per-tenant admin switch is gone). The authenticator-app
 * enrolment UI is gone; an account that still has it on (none did on ship
 * day) is told to ask an administrator.
 *
 * Reachable by EVERY signed-in user (no permission key — it is their own
 * account), from the profile menu and from the sign-in redirect that GRACE
 * mode sends required roles through. What it does:
 *
 *   off → shows where codes WOULD go (masked registered mobile + email) →
 *         "Turn on two-step verification" → POST /auth/otp/enable → on.
 *   on  → shows where codes go; "Turn off" asks for the PASSWORD (not a code,
 *         so a lost phone never locks anyone out of turning it off) →
 *         POST /auth/otp/disable { password } → off.
 *
 * ⛔ Errors are read from `e.body` — `.payload` has never existed on ApiError
 * (CLAUDE.md). ⛔ The password lives in component state only.
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "../../../../components/PageHeader";
import { useUiLanguage } from "../../../../hooks/useUiLanguage";
import { ApiError, apiGet, apiPost } from "../../../../services/apiClient";
import { safeNextPath } from "../../../../lib/mfaLogin";
// ⛔ A page.tsx may only export its default component (a named export fails the
// production build — CLAUDE.md), so the phrase list lives in a sibling module.
import { SECURITY_PHRASES } from "./phrases";

type Status = {
  enabled: boolean;
  enabledAt: string | null;
  channels: string[];
  destinations: Record<string, string>;
  phoneOnFile: boolean;
  totpEnabled: boolean;
  required: boolean;
  enrollmentRequired: boolean;
};

type Mode = { kind: "idle" } | { kind: "disable" };

function errorText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const body = e.body as { error?: string; message?: string } | null;
    if (e.status === 429) return "Too many tries. Wait a few minutes and try again.";
    if (body?.error === "invalid_password") return "That password is not right.";
    if (body?.message) return body.message;
  }
  return fallback;
}

/** `useSearchParams` needs a Suspense boundary for the production build (same
 *  shape as admin/billing/settings). */
export default function AccountSecurityPage() {
  return (
    <Suspense fallback={<div className="acs-wrap"><PageHeader title="Security" /></div>}>
      <AccountSecurityInner />
    </Suspense>
  );
}

function AccountSecurityInner() {
  const { t } = useUiLanguage(SECURITY_PHRASES);
  const params = useSearchParams();
  const wantsSetup = params?.get("setup") === "1";
  const nextPath = useMemo(() => safeNextPath(params?.get("next")), [params]);

  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState("");
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const s = await apiGet<Status>("/auth/otp/status");
      setStatus(s);
      setLoadError("");
    } catch (e) {
      setLoadError(errorText(e, "Couldn't load your security settings."));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function turnOn() {
    setBusy(true); setErr(""); setNotice("");
    try {
      const s = await apiPost<Status & { ok: boolean }>("/auth/otp/enable", {});
      setStatus(s);
      setNotice(t("Two-step verification is on. Each time you sign in we’ll ask for a code by text or email."));
    } catch (e) {
      setErr(errorText(e, "Couldn't turn two-step verification on. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function submitDisable(event: React.FormEvent) {
    event.preventDefault();
    if (!password) { setErr(t("Enter your password.")); return; }
    setBusy(true); setErr("");
    try {
      const s = await apiPost<Status & { ok: boolean }>("/auth/otp/disable", { password });
      setStatus(s);
      setMode({ kind: "idle" });
      setPassword("");
      setNotice(t("Two-step verification is off. Your password alone signs you in."));
    } catch (e) {
      setErr(errorText(e, "Couldn't turn two-step verification off. Try again."));
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setMode({ kind: "idle" });
    setPassword("");
    setErr("");
  }

  const on = Boolean(status && (status.enabled || status.totpEnabled));
  const showRequiredBanner = Boolean(status && status.enrollmentRequired) || (wantsSetup && !on);

  return (
    <div className="acs-wrap">
      <SecurityStyles />
      <PageHeader
        title={t("Security")}
        subtitle={t("Two-step verification protects your account with a code as well as your password.")}
      />

      {showRequiredBanner && status && !on ? (
        <div className="acs-banner" role="status">
          <span>{t("Your role requires two-step verification. Set it up now — it takes about a minute.")}</span>
          <Link href={nextPath} className="acs-banner-link">{t("Not now")}</Link>
        </div>
      ) : null}

      {loadError ? <div className="acs-error" role="alert">{loadError}</div> : null}
      {notice ? <div className="acs-notice" role="status">{notice}</div> : null}

      <section className="panel acs-panel">
        <div className="acs-row">
          <div>
            <div className="acs-title">{t("Two-step verification")}</div>
            {status ? (
              status.enabled ? (
                <div className="muted acs-sub">
                  {t("Turned on")}{status.enabledAt ? ` ${new Date(status.enabledAt).toLocaleDateString()}` : ""} · {t("codes by text message or email")}
                </div>
              ) : null
            ) : (
              <div className="muted acs-sub">{t("Loading…")}</div>
            )}
          </div>
          {status ? (
            <span className={`chip ${on ? "success" : "warning"}`}>{on ? t("On") : t("Off")}</span>
          ) : null}
        </div>

        {status && status.totpEnabled && !status.enabled ? (
          <div className="acs-setup">
            <p className="acs-copy">{t("This account uses an authenticator app for two-step verification. To switch to a code by text or email, ask your administrator to reset it.")}</p>
          </div>
        ) : null}

        {status && !status.totpEnabled ? (
          <div className="acs-setup">
            <p className="acs-copy">
              {status.enabled
                ? t("Where your codes go")
                : t("Each time you sign in we send a 6-digit code to your registered mobile number or email. You choose which at sign-in.")}
            </p>
            <div className="acs-dest">
              {status.channels.includes("SMS") ? (
                <div className="acs-dest-row">
                  <span className="acs-dest-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="2.5" width="12" height="19" rx="2.5" /><path d="M10.5 18.5h3" /></svg>
                  </span>
                  <div className="acs-dest-text">
                    <div className="acs-dest-title">{t("Text message")}</div>
                    <div className="muted acs-dest-to">{status.destinations.SMS} · {t("your registered mobile number")}</div>
                  </div>
                </div>
              ) : null}
              <div className="acs-dest-row">
                <span className="acs-dest-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m3.5 7 8.5 6 8.5-6" /></svg>
                </span>
                <div className="acs-dest-text">
                  <div className="acs-dest-title">{t("Email")}</div>
                  <div className="muted acs-dest-to">{status.destinations.EMAIL} · {t("your account email")}</div>
                </div>
              </div>
            </div>
            <p className="muted acs-note">
              {status.phoneOnFile
                ? t("To change the mobile number, ask your administrator. The code is asked once each time you sign in and stays until you sign out.")
                : t("No mobile number on file, so codes go by email. Ask your administrator to add your mobile number to get texts.")}
            </p>
            {!status.enabled ? (
              <p className="muted acs-note">{t("The Loopcom phone app cannot ask for the code yet. If you sign in on the app, wait before turning this on.")}</p>
            ) : null}

            {!status.enabled && mode.kind === "idle" ? (
              <div className="acs-actions">
                <button className="btn primary" type="button" disabled={busy} onClick={() => void turnOn()}>
                  {t("Turn on two-step verification")}
                </button>
              </div>
            ) : null}

            {status.enabled && mode.kind === "idle" ? (
              <div className="acs-actions">
                <button className="btn ghost danger" type="button" disabled={busy} onClick={() => { setMode({ kind: "disable" }); setPassword(""); setErr(""); setNotice(""); }}>
                  {t("Turn off")}
                </button>
              </div>
            ) : null}

            {mode.kind === "disable" ? (
              <form className="acs-setup" onSubmit={submitDisable}>
                <p className="acs-copy">{t("Enter your password to turn two-step verification off. Your password alone will sign you in.")}</p>
                <label className="label acs-label" htmlFor="acs-password">{t("Password")}</label>
                <input
                  id="acs-password"
                  className="input acs-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                />
                {err ? <div className="acs-error" role="alert">{err}</div> : null}
                <div className="acs-actions">
                  <button className="btn danger" type="submit" disabled={busy}>{t("Turn off")}</button>
                  <button className="btn ghost" type="button" disabled={busy} onClick={cancel}>{t("Cancel")}</button>
                </div>
              </form>
            ) : null}
          </div>
        ) : null}

        {mode.kind === "idle" && err ? <div className="acs-error" role="alert">{err}</div> : null}
      </section>
    </div>
  );
}

/** Theme-token colours only — no section palette (CLAUDE.md, billing theme rule). */
function SecurityStyles() {
  return (
    <style jsx global>{`
      .acs-wrap{max-width:720px;margin:0 auto;padding:8px 4px 60px}
      .acs-panel{padding:18px 20px;display:flex;flex-direction:column;gap:14px}
      .acs-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
      .acs-title{font-size:15px;font-weight:650;color:var(--text)}
      .acs-sub{font-size:12.5px;margin-top:4px}
      .acs-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:4px}
      .acs-setup{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--border);padding-top:14px}
      .acs-copy{margin:0;font-size:13.5px;line-height:1.5;color:var(--text)}
      .acs-note{margin:0;font-size:12.5px;line-height:1.5}
      .acs-label{margin-top:4px}
      .acs-password{max-width:250px}
      .acs-dest{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:10px;background:var(--bg-soft);overflow:hidden}
      .acs-dest-row{display:flex;align-items:center;gap:12px;padding:12px 14px}
      .acs-dest-row + .acs-dest-row{border-top:1px solid var(--border)}
      .acs-dest-icon{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:30px;height:30px;border-radius:8px;background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent)}
      .acs-dest-icon svg{width:16px;height:16px}
      .acs-dest-text{display:flex;flex-direction:column;gap:2px;min-width:0}
      .acs-dest-title{font-size:13.5px;font-weight:600;color:var(--text)}
      .acs-dest-to{font-size:12.5px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis}
      .acs-error{border:1px solid color-mix(in srgb,var(--danger) 42%,transparent);background:color-mix(in srgb,var(--danger) 12%,transparent);color:var(--text);border-radius:10px;padding:10px 13px;font-size:13.5px;line-height:1.45}
      .acs-notice{border:1px solid color-mix(in srgb,var(--success) 40%,transparent);background:color-mix(in srgb,var(--success) 10%,transparent);color:var(--text);border-radius:10px;padding:10px 13px;font-size:13.5px;margin-bottom:12px}
      .acs-banner{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid color-mix(in srgb,var(--warning) 45%,transparent);background:color-mix(in srgb,var(--warning) 12%,transparent);color:var(--text);border-radius:10px;padding:10px 13px;font-size:13.5px;margin-bottom:12px}
      .acs-banner-link{color:var(--text-dim);text-decoration:none;white-space:nowrap}
      .acs-banner-link:hover{color:var(--accent)}
    `}</style>
  );
}
