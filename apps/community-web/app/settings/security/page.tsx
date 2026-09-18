"use client";

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button, Chip, Dialog, Field, Icon, Switch, timeAgo, useToast } from "@/components/ui";
import { passkeyRegister, passkeysSupported } from "@/components/auth/passkeys";

type Session = { id: string; deviceLabel: string | null; client: string; ip: string | null; lastUsedAt: string; createdAt: string; current: boolean };
type Passkey = { id: string; label: string | null; deviceType: string | null; backedUp: boolean; lastUsedAt: string | null; createdAt: string };

export default function SecurityPage() {
  const { me, reload } = useAuth();
  const toast = useToast();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [pkSupported, setPkSupported] = useState(false);
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [mfa, setMfa] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [disableOpen, setDisableOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [s, p] = await Promise.all([api<{ sessions: Session[] }>("/auth/sessions"), api<{ passkeys: Passkey[] }>("/auth/passkeys")]);
    setSessions(s.sessions);
    setPasskeys(p.passkeys);
  };
  useEffect(() => {
    setPkSupported(passkeysSupported());
    void load();
  }, []);

  async function revoke(id: string) {
    await api(`/auth/sessions/${id}`, { method: "DELETE" });
    toast("Signed that device out.");
    void load();
  }
  async function logoutAll() {
    await api("/auth/logout-all", { method: "POST" });
    toast("Signed out everywhere. This device will sign out too.");
  }
  async function addPasskey() {
    setBusy(true);
    try {
      await passkeyRegister();
      toast("Passkey added.");
      void load();
    } catch (err) {
      toast((err as Error).message || "Passkey setup didn't complete.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }
  async function removePasskey(id: string) {
    await api(`/auth/passkeys/${id}`, { method: "DELETE" });
    toast("Passkey removed.");
    void load();
  }
  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (pw.next !== pw.confirm) return toast("Those passwords don't match.", { kind: "err" });
    setBusy(true);
    try {
      await api("/auth/password/change", { body: { currentPassword: pw.current || undefined, newPassword: pw.next } });
      toast("Password changed. Other devices were signed out.");
      setPw({ current: "", next: "", confirm: "" });
      void load();
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }
  async function startMfa() {
    setMfa(await api("/auth/mfa/totp/setup", { method: "POST" }));
  }
  async function enableMfa() {
    setBusy(true);
    try {
      await api("/auth/mfa/totp/enable", { body: { code: mfaCode } });
      toast("Two-step verification is on.");
      setMfa(null);
      setMfaCode("");
      await reload();
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }
  async function disableMfa() {
    setBusy(true);
    try {
      await api("/auth/mfa/totp/disable", { body: { code: mfaCode } });
      toast("Two-step verification is off.");
      setDisableOpen(false);
      setMfaCode("");
      await reload();
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="card">
        <div className="ct">Sign-in methods</div>
        <div className="list sm">
          <div className="li">
            <Icon name="key" />
            <div className="t">
              <b>Passkeys</b>
              <small>{passkeys.length ? passkeys.map((p) => p.label || p.deviceType || "Passkey").join(" · ") : "Sign in with Face ID, Touch ID or Windows Hello — no password."}</small>
            </div>
            {pkSupported ? <Button small onClick={addPasskey} loading={busy} data-testid="add-passkey">Add passkey</Button> : <Chip>Not supported here</Chip>}
          </div>
          {passkeys.map((p) => (
            <div className="li" key={p.id} style={{ paddingLeft: 30 }}>
              <div className="t"><b style={{ fontWeight: 500 }}>{p.label || p.deviceType || "Passkey"}</b><small>Added {timeAgo(p.createdAt)} ago{p.lastUsedAt ? ` · used ${timeAgo(p.lastUsedAt)} ago` : ""}{p.backedUp ? " · synced" : ""}</small></div>
              <Button small kind="g d" onClick={() => removePasskey(p.id)}>Remove</Button>
            </div>
          ))}
          <div className="li">
            <Icon name="shield" />
            <div className="t">
              <b>Two-step verification (authenticator app)</b>
              <small>{me?.person.mfaEnabled ? "On — a code from your app is required at sign-in." : "Off. Adds a 6-digit code from Google Authenticator, 1Password, etc."}</small>
            </div>
            <Switch on={!!me?.person.mfaEnabled} label="Two-step verification" onChange={(on) => (on ? startMfa() : setDisableOpen(true))} />
          </div>
        </div>
      </div>

      <form className="card" onSubmit={changePassword}>
        <div className="ct">Password</div>
        <div className="grid3">
          <Field label="Current password" htmlFor="pw-cur"><input id="pw-cur" className="in" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
          <Field label="New password" htmlFor="pw-new"><input id="pw-new" className="in" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
          <Field label="Confirm" htmlFor="pw-conf"><input id="pw-conf" className="in" type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
        </div>
        <div className="row" style={{ marginTop: 10 }}><Button type="submit" loading={busy} data-testid="change-password">Change password</Button><span className="xs dim">Other devices get signed out.</span></div>
      </form>

      <div className="card">
        <div className="ct">Active sessions <span className="more" style={{ color: "var(--ink-danger)", cursor: "pointer" }} onClick={logoutAll}>Sign out of all other devices</span></div>
        <table className="tbl">
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td><b>{s.deviceLabel || s.client}</b><br /><small className="dim">{s.current ? "This device" : `Last used ${timeAgo(s.lastUsedAt)} ago`}{s.ip ? ` · ${s.ip}` : ""}</small></td>
                <td style={{ textAlign: "right" }}>{s.current ? <Chip kind="ok">current</Chip> : <Button small kind="g" onClick={() => revoke(s.id)}>Sign out</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={!!mfa} onClose={() => setMfa(null)} title="Set up two-step verification" footer={<><Button kind="g" onClick={() => setMfa(null)}>Cancel</Button><Button kind="p" onClick={enableMfa} loading={busy} data-testid="mfa-enable">Turn on</Button></>}>
        {mfa ? (
          <>
            <p className="sm">Scan this with your authenticator app, then enter the 6-digit code it shows.</p>
            <div className="qr" style={{ justifySelf: "center" }}><QRCodeSVG value={mfa.otpauthUrl} size={168} /></div>
            <p className="xs dim mono" style={{ textAlign: "center", overflowWrap: "anywhere" }}>Or type the key: {mfa.secret}</p>
            <Field label="Code" htmlFor="mfa-code"><input id="mfa-code" className="in" inputMode="numeric" autoComplete="one-time-code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} data-testid="mfa-code" /></Field>
          </>
        ) : null}
      </Dialog>
      <Dialog open={disableOpen} onClose={() => setDisableOpen(false)} title="Turn off two-step verification" footer={<><Button kind="g" onClick={() => setDisableOpen(false)}>Cancel</Button><Button kind="d" onClick={disableMfa} loading={busy}>Turn off</Button></>}>
        <p className="sm">Enter the current code from your authenticator app to confirm.</p>
        <Field label="Code" htmlFor="mfa-off"><input id="mfa-off" className="in" inputMode="numeric" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} /></Field>
      </Dialog>
    </>
  );
}
