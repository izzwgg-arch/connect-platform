"use client";

/**
 * Screen 5 — switching Remote Desktop on AT this computer.
 *
 * Reaching a computer when nobody is there is a decision made at that computer,
 * by the person signed in. This page is that decision: set the username and
 * password (kept only on this computer, checked only on this computer), name
 * it, and flip the switch. ⛔ In a browser tab there is nothing to switch — the
 * page says so and points at the Loopcom app.
 *
 * ⛔ Everything here goes through `connectDesktop.remoteDesktopSetup`, which is
 * published ALWAYS (it polls nothing and shares nothing); the host key that
 * makes the machine reachable is a separate, gated thing.
 */
import { useCallback, useEffect, useState } from "react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { desktopBridge, listMachines, type Machine } from "../../../../services/remoteDesktop";
import { formatConnectId } from "../../../../lib/remoteDesktop";

type Identity = {
  enabled: boolean;
  deviceId: string;
  machineKey: string;
  name: string;
  hostname: string;
  osLabel: string;
  appVersion: string;
  monitors: number;
  locked: boolean;
  login: { set: boolean; username: string | null; lockedForMs: number };
};

export default function ThisComputerPage() {
  return (
    <PermissionGate permission="can_use_remote_desktop">
      <ThisComputer />
    </PermissionGate>
  );
}

function ThisComputer() {
  const bridge = desktopBridge();
  const setup = bridge?.remoteDesktopSetup;
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [machine, setMachine] = useState<Machine | null>(null);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!setup) return;
    try {
      const id: Identity = await setup.identity();
      setIdentity(id);
      setName((cur) => cur || id.name);
      if (!username && id.login.username) setUsername(id.login.username);
      try {
        const res = await listMachines();
        setMachine(res.machines.find((m) => m.deviceId === id.deviceId) ?? null);
      } catch { /* not registered yet — that is fine */ }
    } catch (e: any) {
      setError(e?.message || "Could not read this computer's settings.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (!setup) {
    return (
      <div className="rd-root">
        <header className="rd-head">
          <div>
            <h1>Allow Remote Desktop to this computer</h1>
            <p>This is set at the computer itself, inside the Loopcom app.</p>
          </div>
        </header>
        <div className="rd-card rd-setup">
          <h3>Open this page in the Loopcom app</h3>
          <p className="rd-note">
            You are in a browser. Reaching a computer when nobody is there is a decision made <b>at that computer</b>, by the
            person signed in to Loopcom on it: open Loopcom there, right-click the tray icon and choose
            <b> Allow Remote Desktop to this computer…</b>, or open this page inside the app.
          </p>
          <div>
            <a className="rd-btn rd-btn--sm rd-btn--ghost" href="/desktop/Connect-Setup-latest.exe">Download the Loopcom app</a>
          </div>
        </div>
      </div>
    );
  }

  const saveLogin = async () => {
    setError(null); setOk(null);
    if (password !== confirm) { setError("The two passwords do not match."); return; }
    setBusy(true);
    try {
      const res = await setup.setLogin(username.trim(), password);
      if (!res.ok) { setError(res.message || "That username or password is not allowed."); return; }
      setPassword(""); setConfirm("");
      setOk(identity?.login.set ? "Username and password changed." : "Username and password set. You can turn Remote Desktop on now.");
      await refresh();
    } catch (e: any) {
      setError(e?.message || "Could not save.");
    } finally { setBusy(false); }
  };

  const saveName = async () => {
    setError(null);
    try { await setup.setName(name.trim()); setOk("Name saved."); await refresh(); } catch (e: any) { setError(e?.message || "Could not save the name."); }
  };

  const toggle = async (on: boolean) => {
    setError(null); setOk(null); setBusy(true);
    try {
      const res = await setup.setEnabled(on);
      if (!res.ok) { setError(res.message || "Could not change that."); return; }
      setOk(on
        ? "Remote Desktop is allowed. It takes effect the next time Loopcom starts — fully close it (tray included) and open it again."
        : "Remote Desktop is off. Any connection to this computer was stopped.");
      await refresh();
    } catch (e: any) {
      setError(e?.message || "Could not change that.");
    } finally { setBusy(false); }
  };

  const clearLogin = async () => {
    if (identity?.enabled) { setError("Turn Remote Desktop off before removing the username and password."); return; }
    setBusy(true);
    try { await setup.clearLogin(); setUsername(""); setOk("Username and password removed."); await refresh(); } finally { setBusy(false); }
  };

  return (
    <div className="rd-root">
      <header className="rd-head">
        <div>
          <h1>Allow Remote Desktop to this computer</h1>
          <p>
            With this on, you can connect to <b>{identity?.name || "this computer"}</b> from your other computers when nobody is
            using it. Anyone connecting must type the username and password below, which are kept only on this computer and are
            not your Loopcom login.
          </p>
        </div>
        {identity && (
          <span className={`rd-pill ${identity.enabled ? "rd-pill--on" : "rd-pill--off"}`}>
            <span className="rd-dot" />{identity.enabled ? "Allowed" : "Off"}
          </span>
        )}
      </header>

      <div className="rd-setup">
        <div className="rd-card rd-card--stack">
          <div className="rd-state">
            <div>
              <h3>Remote Desktop to this computer</h3>
              <p className="rd-sub">
                {identity?.enabled
                  ? "On. Applies to windows opened from now on; a running session is stopped the moment you turn it off."
                  : identity?.login.set
                    ? "Off. Turn it on to reach this computer when nobody is here."
                    : "Off. Set a username and password first."}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={identity?.enabled === true}
              aria-label="Allow Remote Desktop to this computer"
              className="rd-toggle"
              disabled={busy || !identity || (!identity.enabled && !identity.login.set)}
              onClick={() => void toggle(!identity?.enabled)}
            />
          </div>
          {machine && (
            <div className="rd-id-row rd-divider" style={{ paddingTop: 10 }}>
              <div>
                <div className="rd-note">Connect ID · permanent, this computer</div>
                <div className="rd-id rd-mono">{machine.connectIdDisplay || formatConnectId(machine.connectId)}</div>
              </div>
              <button type="button" className="rd-btn rd-btn--sm" onClick={() => void navigator.clipboard?.writeText(machine.connectId)}>Copy</button>
            </div>
          )}
        </div>

        <div className="rd-card rd-card--stack">
          <div><h3>Username and password for this computer</h3><p className="rd-sub">Checked here, on this computer. Five wrong tries locks it for 15 minutes.</p></div>
          <label className="rd-field">
            <span className="rd-label">Username for this computer</span>
            <input className="rd-input rd-mono" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" placeholder="e.g. izzy-home" />
          </label>
          <div className="rd-two">
            <label className="rd-field">
              <span className="rd-label">Password (8 or more characters)</span>
              <input className="rd-input rd-mono" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </label>
            <label className="rd-field">
              <span className="rd-label">Type the password again</span>
              <input className="rd-input rd-mono" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
            </label>
          </div>
          <div className="rd-acts" style={{ justifyContent: "space-between" }}>
            <span className="rd-note">{identity?.login.set ? `Currently set for ${identity.login.username}.` : "Not set yet."}</span>
            <div style={{ display: "flex", gap: 8 }}>
              {identity?.login.set && <button type="button" className="rd-btn rd-btn--ghost" disabled={busy} onClick={() => void clearLogin()}>Remove</button>}
              <button type="button" className="rd-btn rd-btn--primary" disabled={busy || !username.trim() || password.length < 8} onClick={() => void saveLogin()}>
                {identity?.login.set ? "Change" : "Set username and password"}
              </button>
            </div>
          </div>
        </div>

        <div className="rd-card rd-card--stack">
          <div><h3>What this computer is called</h3><p className="rd-sub">Shown on your Remote Desktop page and in the banner when someone is connected.</p></div>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="rd-input" value={name} onChange={(e) => setName(e.target.value)} placeholder={identity?.hostname || "This computer"} />
            <button type="button" className="rd-btn" onClick={() => void saveName()}>Save</button>
          </div>
        </div>

        <div className="rd-card">
          <label className="rd-opt rd-opt--dis"><input type="checkbox" checked readOnly disabled /><span>Show a banner whenever someone is connected<small>Always on. Shown here so you know.</small></span></label>
          <label className="rd-opt rd-opt--dis"><input type="checkbox" checked readOnly disabled /><span>Windows lock screen is <b>not</b> unlocked for you<small>If Windows is locked, the connecting person sees a black picture and cannot type until someone unlocks it at the computer. Loopcom never stores or types Windows passwords.</small></span></label>
          <p className="rd-note" style={{ marginTop: 6 }}>Turning it on takes effect after Loopcom restarts. Turning it off stops any connection immediately.</p>
        </div>

        {error && <p className="rd-error">{error}</p>}
        {ok && <p className="rd-ok">{ok}</p>}
      </div>
    </div>
  );
}
