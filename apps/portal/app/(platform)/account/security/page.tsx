"use client";
/**
 * Account → Security: two-step verification (MFA) for the signed-in person.
 *
 * Reachable by EVERY signed-in user (no permission key — it is their own
 * account), from the profile menu and from the sign-in redirect that GRACE
 * mode sends required roles through. What it does, in order:
 *
 *   off  → "Turn on" → POST /auth/mfa/totp/setup → QR + manual key → the person
 *          types the first code → POST /auth/mfa/totp/verify → recovery codes,
 *          shown ONCE → done.
 *   on   → enabled since / codes left; "New recovery codes" and "Turn off",
 *          each behind a current 6-digit code.
 *
 * ⛔ Errors are read from `e.body` — `.payload` has never existed on ApiError
 * (CLAUDE.md). ⛔ Nothing here is logged; the secret and the codes live in
 * component state and are gone on navigation. ⛔ The QR box has a white
 * background on purpose: a scanner needs contrast the dark theme does not give.
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { PageHeader } from "../../../../components/PageHeader";
import { useUiLanguage } from "../../../../hooks/useUiLanguage";
import { ApiError, apiGet, apiPost } from "../../../../services/apiClient";
import { isSubmittableMfaCode, looksLikeTotpCodeInput, normalizeMfaCodeInput, safeNextPath } from "../../../../lib/mfaLogin";
// ⛔ A page.tsx may only export its default component (a named export fails the
// production build — CLAUDE.md), so the phrase list lives in a sibling module.
import { SECURITY_PHRASES } from "./phrases";


type Status = {
  enabled: boolean;
  enabledAt: string | null;
  pendingSetup: boolean;
  recoveryCodesRemaining: number;
  required: boolean;
  enrollmentRequired: boolean;
};

type Setup = { secretBase32: string; manualKey: string; otpauthUri: string; account: string };

type Mode =
  | { kind: "idle" }
  | { kind: "setup"; setup: Setup }
  | { kind: "codes"; codes: string[]; heading: "enabled" | "regenerated" }
  | { kind: "regenerate" }
  | { kind: "disable" };

function errorText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const body = e.body as { error?: string; message?: string } | null;
    if (e.status === 429) return "Too many wrong codes. Wait a few minutes and try again.";
    if (body?.message) return body.message;
    if (body?.error === "invalid_code") return "That code didn't match. Try the current one.";
    if (body?.error === "already_enabled") return "Two-step verification is already on.";
    if (body?.error === "mfa_unavailable") return "The server can't store a two-step secret yet. Tell your administrator.";
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
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await apiGet<Status>("/auth/mfa/status");
      setStatus(s);
      setLoadError("");
    } catch (e) {
      setLoadError(errorText(e, "Couldn't load your security settings."));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function beginSetup() {
    setBusy(true); setErr(""); setNotice("");
    try {
      const setup = await apiPost<Setup>("/auth/mfa/totp/setup", {});
      setMode({ kind: "setup", setup });
      setCode("");
    } catch (e) {
      setErr(errorText(e, "Couldn't start the setup."));
    } finally {
      setBusy(false);
    }
  }

  async function confirmSetup(event: React.FormEvent) {
    event.preventDefault();
    if (mode.kind !== "setup") return;
    const c = normalizeMfaCodeInput(code);
    if (!looksLikeTotpCodeInput(c)) { setErr(t("Enter the 6-digit code from your authenticator app.")); return; }
    setBusy(true); setErr("");
    try {
      const res = await apiPost<{ enabled: boolean; recoveryCodes: string[] }>("/auth/mfa/totp/verify", { code: c });
      setMode({ kind: "codes", codes: res.recoveryCodes, heading: "enabled" });
      setCode("");
      setCopied(false);
      await load();
    } catch (e) {
      setErr(errorText(e, "That code didn't match."));
    } finally {
      setBusy(false);
    }
  }

  async function submitRegenerate(event: React.FormEvent) {
    event.preventDefault();
    const c = normalizeMfaCodeInput(code);
    if (!looksLikeTotpCodeInput(c)) { setErr(t("Enter the 6-digit code from your authenticator app.")); return; }
    setBusy(true); setErr("");
    try {
      const res = await apiPost<{ recoveryCodes: string[] }>("/auth/mfa/recovery-codes/regenerate", { code: c });
      setMode({ kind: "codes", codes: res.recoveryCodes, heading: "regenerated" });
      setCode("");
      setCopied(false);
      await load();
    } catch (e) {
      setErr(errorText(e, "That code didn't match."));
    } finally {
      setBusy(false);
    }
  }

  async function submitDisable(event: React.FormEvent) {
    event.preventDefault();
    const c = normalizeMfaCodeInput(code);
    if (!isSubmittableMfaCode(c)) { setErr(t("Enter the 6-digit code from your authenticator app.")); return; }
    setBusy(true); setErr("");
    try {
      await apiPost("/auth/mfa/disable", { code: c });
      setMode({ kind: "idle" });
      setCode("");
      setNotice(t("Two-step verification is off. Your password alone signs you in."));
      await load();
    } catch (e) {
      setErr(errorText(e, "That code didn't match."));
    } finally {
      setBusy(false);
    }
  }

  async function copyCodes() {
    if (mode.kind !== "codes") return;
    try {
      await navigator.clipboard.writeText(mode.codes.join("\n"));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function cancel() {
    setMode({ kind: "idle" });
    setCode("");
    setErr("");
  }

  const showRequiredBanner = Boolean(status && status.enrollmentRequired) || (wantsSetup && !status?.enabled);

  return (
    <div className="acs-wrap">
      <SecurityStyles />
      <PageHeader
        title={t("Security")}
        subtitle={t("Two-step verification protects your account with a code from your phone as well as your password.")}
      />

      {showRequiredBanner && status && !status.enabled ? (
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
                  {t("Turned on")}{status.enabledAt ? ` ${new Date(status.enabledAt).toLocaleDateString()}` : ""} · {t("Recovery codes left")}: {status.recoveryCodesRemaining}
                </div>
              ) : null
            ) : (
              <div className="muted acs-sub">{t("Loading…")}</div>
            )}
          </div>
          {status ? (
            <span className={`chip ${status.enabled ? "success" : "warning"}`}>{status.enabled ? t("On") : t("Off")}</span>
          ) : null}
        </div>

        {status && !status.enabled && mode.kind === "idle" ? (
          <div className="acs-actions">
            <button className="btn" type="button" disabled={busy} onClick={() => void beginSetup()}>
              {t("Turn on two-step verification")}
            </button>
          </div>
        ) : null}

        {status && status.enabled && mode.kind === "idle" ? (
          <div className="acs-actions">
            <button className="btn ghost" type="button" disabled={busy} onClick={() => { setMode({ kind: "regenerate" }); setCode(""); setErr(""); }}>
              {t("Get new recovery codes")}
            </button>
            <button className="btn ghost danger" type="button" disabled={busy} onClick={() => { setMode({ kind: "disable" }); setCode(""); setErr(""); }}>
              {t("Turn off")}
            </button>
          </div>
        ) : null}

        {mode.kind === "setup" ? (
          <form className="acs-setup" onSubmit={confirmSetup}>
            <p className="acs-copy">{t("Scan this code with your authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password…).")}</p>
            <div className="acs-qr" aria-label="Two-step verification QR code">
              <QRCodeSVG value={mode.setup.otpauthUri} size={196} level="M" />
            </div>
            <p className="acs-copy">{t("Can't scan? Type this key into the app instead:")}</p>
            <code className="acs-key">{mode.setup.manualKey}</code>
            <label className="label acs-label" htmlFor="acs-first-code">{t("Then enter the 6-digit code the app shows:")}</label>
            <input
              id="acs-first-code"
              className="input acs-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123 456"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
            />
            {err ? <div className="acs-error" role="alert">{err}</div> : null}
            <div className="acs-actions">
              <button className="btn" type="submit" disabled={busy}>{t("Verify and turn on")}</button>
              <button className="btn ghost" type="button" disabled={busy} onClick={cancel}>{t("Cancel")}</button>
            </div>
          </form>
        ) : null}

        {mode.kind === "codes" ? (
          <div className="acs-setup">
            <p className="acs-copy acs-strong">
              {mode.heading === "enabled" ? t("Two-step verification is on.") : t("New recovery codes")}
            </p>
            <p className="acs-copy">
              {mode.heading === "regenerated" ? `${t("Your old recovery codes no longer work.")} ` : ""}
              {t("Save these recovery codes somewhere safe. Each one signs you in once if you lose your phone. They will not be shown again.")}
            </p>
            <ul className="acs-codes">
              {mode.codes.map((c) => <li key={c}><code>{c}</code></li>)}
            </ul>
            <div className="acs-actions">
              <button className="btn ghost" type="button" onClick={() => void copyCodes()}>{copied ? t("Copied") : t("Copy codes")}</button>
              <button className="btn" type="button" onClick={cancel}>{t("I've saved my recovery codes")}</button>
            </div>
          </div>
        ) : null}

        {mode.kind === "regenerate" || mode.kind === "disable" ? (
          <form className="acs-setup" onSubmit={mode.kind === "regenerate" ? submitRegenerate : submitDisable}>
            <p className="acs-copy">
              {mode.kind === "regenerate"
                ? t("Enter the current 6-digit code from your authenticator app to continue.")
                : t("Enter a current code from your authenticator app, or a recovery code, to turn two-step verification off.")}
            </p>
            <input
              className="input acs-code"
              inputMode={mode.kind === "regenerate" ? "numeric" : "text"}
              autoComplete="one-time-code"
              placeholder={mode.kind === "regenerate" ? "123 456" : "123 456 / ABCDE-FGHJK"}
              maxLength={12}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
            />
            {err ? <div className="acs-error" role="alert">{err}</div> : null}
            <div className="acs-actions">
              <button className={`btn ${mode.kind === "disable" ? "danger" : ""}`} type="submit" disabled={busy}>
                {mode.kind === "disable" ? t("Turn off") : t("Confirm")}
              </button>
              <button className="btn ghost" type="button" disabled={busy} onClick={cancel}>{t("Cancel")}</button>
            </div>
          </form>
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
      .acs-strong{font-weight:650}
      .acs-qr{align-self:flex-start;padding:12px;border-radius:12px;background:#fff;box-shadow:0 0 0 1px var(--border)}
      .acs-key{align-self:flex-start;font-size:15px;letter-spacing:.08em;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-soft);color:var(--text);user-select:all}
      .acs-label{margin-top:4px}
      .acs-code{max-width:240px;letter-spacing:.14em;font-variant-numeric:tabular-nums;font-size:16px}
      .acs-codes{margin:0;padding:12px 14px;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px 18px;list-style:none;border:1px solid var(--border);border-radius:10px;background:var(--bg-soft)}
      .acs-codes code{font-size:14.5px;letter-spacing:.06em;color:var(--text)}
      .acs-error{border:1px solid color-mix(in srgb,var(--danger) 42%,transparent);background:color-mix(in srgb,var(--danger) 12%,transparent);color:var(--text);border-radius:10px;padding:10px 13px;font-size:13.5px;line-height:1.45}
      .acs-notice{border:1px solid color-mix(in srgb,var(--success) 40%,transparent);background:color-mix(in srgb,var(--success) 10%,transparent);color:var(--text);border-radius:10px;padding:10px 13px;font-size:13.5px;margin-bottom:12px}
      .acs-banner{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid color-mix(in srgb,var(--warning) 45%,transparent);background:color-mix(in srgb,var(--warning) 12%,transparent);color:var(--text);border-radius:10px;padding:10px 13px;font-size:13.5px;margin-bottom:12px}
      .acs-banner-link{color:var(--text-dim);text-decoration:none;white-space:nowrap}
      .acs-banner-link:hover{color:var(--accent)}
    `}</style>
  );
}
