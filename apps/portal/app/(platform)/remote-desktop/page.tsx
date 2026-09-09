"use client";

/**
 * Screen 1 — Remote Desktop home (Workspace → Remote Desktop).
 *
 * Three jobs on one page: pick one of your own computers, connect to somebody
 * else's by Connect ID + password, or hand out access to the computer you are
 * sitting at. Built to the approved mockups; every colour is a portal token.
 *
 * ⛔ Connect by ID is Loopcom-app-to-Loopcom-app only. In a browser the card
 * reads as a note, and the server refuses anyway (`desktop_app_required`).
 * ⛔ The username and password for your OWN computer are typed in the connect
 * sheet and handed to the session page through sessionStorage for one read —
 * never a query string, never a server.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PermissionGate } from "../../../components/PermissionGate";
import { ConnectSelect } from "../../../components/ConnectSelect";
import { useAppContext } from "../../../hooks/useAppContext";
import {
  connectById,
  connectToMachine,
  createShare,
  desktopBridge,
  history,
  listMachines,
  listShares,
  me,
  removeMachine,
  renameMachine,
  revokeShare,
  type DesktopSession,
  type Machine,
  type RemoteDesktopMe,
  type Share,
} from "../../../services/remoteDesktop";
import { describeMachineAccess, parseConnectId, relativeTime, shareExpiryLabel, typedConnectId } from "../../../lib/remoteDesktop";

const LOGIN_HANDOFF_KEY = (sessionId: string) => `rd-login-${sessionId}`;

export default function RemoteDesktopPage() {
  return (
    <PermissionGate permission="can_use_remote_desktop">
      <RemoteDesktopHome />
    </PermissionGate>
  );
}

type ConnectDraft = { machine: Machine; username: string; password: string; monitor: string; picture: "sharp" | "smooth"; sound: boolean; mic: boolean; clipboard: boolean; error: string | null; busy: boolean };
type ShareDraft = { machine: Machine; expiry: "once" | "24h" | "standing"; scope: "company" | "anyone"; allowControl: boolean; allowSound: boolean; allowMic: boolean; allowClipboard: boolean; result: { password: string; connectIdDisplay: string } | null; error: string | null; busy: boolean };

function RemoteDesktopHome() {
  const router = useRouter();
  const { tenant, user } = useAppContext();
  const bridge = desktopBridge();
  const [facts, setFacts] = useState<RemoteDesktopMe | null>(null);
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [recent, setRecent] = useState<DesktopSession[]>([]);
  const [thisDeviceId, setThisDeviceId] = useState<string | null>(null);
  const [thisName, setThisName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [connect, setConnect] = useState<ConnectDraft | null>(null);
  const [share, setShare] = useState<ShareDraft | null>(null);
  const [shares, setShares] = useState<Share[]>([]);
  const [idInput, setIdInput] = useState("");
  const [idPassword, setIdPassword] = useState("");
  const [idAudio, setIdAudio] = useState(true);
  const [idBusy, setIdBusy] = useState(false);
  const [idError, setIdError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const [f, m, h] = await Promise.all([me(), listMachines(), history(30)]);
      setFacts(f); setMachines(m.machines); setRecent(h.sessions); setError(null);
    } catch (e: any) {
      setError(e?.body?.message || e?.message || "Could not load your computers.");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  // Which of these computers is the one we are sitting at (Windows app only).
  useEffect(() => {
    const setup = bridge?.remoteDesktopSetup;
    if (!setup) return;
    setup.identity().then((id: any) => { setThisDeviceId(id?.deviceId || null); setThisName(id?.name || null); }).catch(() => {});
  }, [bridge]);

  const thisMachine = useMemo(() => machines?.find((m) => m.deviceId === thisDeviceId) ?? null, [machines, thisDeviceId]);
  const fromLabel = thisName || thisMachine?.name || (bridge?.isDesktop ? "the Loopcom app" : "a browser");

  useEffect(() => {
    if (!thisMachine || !facts?.canShareOwnComputer) { setShares([]); return; }
    listShares(thisMachine.id).then((r) => setShares(r.shares)).catch(() => setShares([]));
  }, [thisMachine, facts?.canShareOwnComputer, share?.result]);

  const openConnect = (m: Machine) => {
    setConnect({ machine: m, username: "", password: "", monitor: "1", picture: "sharp", sound: true, mic: true, clipboard: true, error: null, busy: false });
  };

  const submitConnect = async () => {
    if (!connect) return;
    const caps = ["control", ...(connect.sound ? ["sound"] : []), ...(connect.mic ? ["mic"] : []), ...(connect.clipboard ? ["clipboard"] : [])];
    setConnect({ ...connect, busy: true, error: null });
    try {
      const res = await connectToMachine(connect.machine.id, { capabilities: caps, fromLabel });
      try {
        sessionStorage.setItem(LOGIN_HANDOFF_KEY(res.session.id), JSON.stringify({ username: connect.username, password: connect.password, monitor: connect.monitor, picture: connect.picture, sound: connect.sound, mic: connect.mic, clipboard: connect.clipboard }));
      } catch { /* the session page will ask instead */ }
      setConnect(null);
      router.push(`/remote-desktop/session/${res.session.id}`);
    } catch (e: any) {
      setConnect({ ...connect, busy: false, error: e?.body?.message || e?.message || "Could not connect." });
    }
  };

  const submitById = async () => {
    const id = parseConnectId(idInput);
    if (!id) { setIdError("A Connect ID is nine digits."); return; }
    if (!idPassword.trim()) { setIdError("Enter the password they gave you."); return; }
    setIdBusy(true); setIdError(null);
    try {
      const caps = ["control", ...(idAudio ? ["sound", "mic"] : []), "clipboard"];
      const res = await connectById({ connectId: id, password: idPassword, capabilities: caps, fromLabel });
      try { sessionStorage.setItem(LOGIN_HANDOFF_KEY(res.session.id), JSON.stringify({ sound: idAudio, mic: idAudio, clipboard: true })); } catch { /* fine */ }
      router.push(`/remote-desktop/session/${res.session.id}`);
    } catch (e: any) {
      setIdError(e?.body?.message || e?.message || "Could not connect.");
    } finally { setIdBusy(false); }
  };

  const openShare = (m: Machine) => {
    setShare({ machine: m, expiry: "24h", scope: "company", allowControl: true, allowSound: true, allowMic: false, allowClipboard: false, result: null, error: null, busy: false });
  };

  const submitShare = async () => {
    if (!share) return;
    setShare({ ...share, busy: true, error: null });
    try {
      const res = await createShare(share.machine.id, { expiry: share.expiry, scope: share.scope, allowControl: share.allowControl, allowSound: share.allowSound, allowMic: share.allowMic, allowClipboard: share.allowClipboard });
      setShare({ ...share, busy: false, result: { password: res.password, connectIdDisplay: res.connectIdDisplay } });
    } catch (e: any) {
      setShare({ ...share, busy: false, error: e?.body?.message || e?.message || "Could not create the password." });
    }
  };

  const doRename = async (m: Machine) => {
    const name = window.prompt("What should this computer be called?", m.name);
    if (!name || name.trim() === m.name) return;
    try { await renameMachine(m.id, name.trim()); await load(); } catch (e: any) { setError(e?.body?.message || "Could not rename."); }
  };
  const doRemove = async (m: Machine) => {
    if (!window.confirm(`Remove ${m.name} from Remote Desktop? Its passwords stop working. Reinstalling or re-enabling on that computer adds it back.`)) return;
    try { await removeMachine(m.id); await load(); } catch (e: any) { setError(e?.body?.message || "Could not remove."); }
  };

  const copyText = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard refused */ }
  };

  return (
    <div className="rd-root" onClick={() => menuFor && setMenuFor(null)}>
      <header className="rd-head">
        <div>
          <h1>Remote Desktop</h1>
          <p>Your computers, from wherever you are. Nothing is recorded, and the computer you connect to always shows a banner while you are on it.</p>
        </div>
        {thisMachine && <span className="rd-pill rd-pill--you"><span className="rd-dot" />You are on {thisMachine.name}</span>}
      </header>

      {error && <p className="rd-error">{error}</p>}

      <div className="rd-home">
        <div className="rd-col">
          <div className="rd-sec-head">
            <h3>My computers</h3>
            <span className="rd-note">{machines ? `${machines.length} signed in as you` : "Loading…"}</span>
          </div>
          <div className="rd-machines">
            {(machines ?? []).map((m) => {
              const isThis = m.deviceId === thisDeviceId;
              const access = describeMachineAccess({ ...m, thisComputer: isThis });
              const canConnect = !isThis && m.online && m.unattendedEnabled && m.hasAccessLogin;
              return (
                <div className="rd-card rd-machine" key={m.id}>
                  <div className="rd-top">
                    <div className="rd-name">{m.name}{isThis && <span className="rd-pill rd-pill--you">this computer</span>}</div>
                    <button type="button" className="rd-kebab" aria-label={`Options for ${m.name}`} onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === m.id ? null : m.id); }}>···</button>
                    {menuFor === m.id && (
                      <div className="rd-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                        <button type="button" onClick={() => { setMenuFor(null); void doRename(m); }}>Rename</button>
                        {isThis && facts?.canShareOwnComputer && <button type="button" onClick={() => { setMenuFor(null); openShare(m); }}>Share this computer</button>}
                        <button type="button" className="rd-menu-danger" onClick={() => { setMenuFor(null); void doRemove(m); }}>Remove from Remote Desktop</button>
                      </div>
                    )}
                  </div>
                  <div className={`rd-thumb${m.online ? "" : " rd-thumb--off"}`} aria-hidden="true">
                    <span className="rd-w" style={{ left: 14, top: 12, width: "38%", height: 44 }} />
                    <span className="rd-w" style={{ left: "50%", top: 22, width: "24%", height: 30 }} />
                  </div>
                  <div className="rd-meta">
                    <span>Status</span>
                    <b>
                      <span className={`rd-pill rd-pill--${isThis ? "you" : access.pill}`}>
                        <span className="rd-dot" />
                        {isThis ? "You are here" : m.online ? (m.locked ? "Online · Windows is locked" : "Online") : `Offline · last seen ${m.lastSeenAt ? relativeTime(m.lastSeenAt) : "never"}`}
                      </span>
                    </b>
                    <span>Access</span>
                    <b>{m.unattendedEnabled && m.hasAccessLogin ? "Unattended · username set" : <span className="rd-pill rd-pill--warn">Someone must switch it on there</span>}</b>
                    {isThis
                      ? (<><span>Connect ID</span><b className="rd-mono">{m.connectIdDisplay}</b></>)
                      : (<><span>Sound</span><b>Plays here when connected</b></>)}
                  </div>
                  <div className="rd-foot">
                    <span className="rd-note">{m.osLabel || "Windows"} · {m.monitors} monitor{m.monitors === 1 ? "" : "s"}{!isThis && !(m.unattendedEnabled && m.hasAccessLogin) ? " · turn on unattended access from its tray icon" : ""}</span>
                    {isThis
                      ? (facts?.canShareOwnComputer ? <button type="button" className="rd-btn rd-btn--sm" onClick={() => openShare(m)}>Share this computer</button> : null)
                      : <button type="button" className="rd-btn rd-btn--primary" disabled={!canConnect} title={canConnect ? undefined : m.online ? "Unattended access is off on that computer" : "That computer is offline"} onClick={() => openConnect(m)}>Connect</button>}
                  </div>
                </div>
              );
            })}
            <div className="rd-card rd-machine rd-machine--add">
              <div className="rd-name" style={{ fontSize: 14 }}>Add another computer</div>
              <p className="rd-note">
                Install Loopcom on it, sign in as you, and it shows up here. To reach it when nobody is there, switch on
                <b> Allow Remote Desktop to this computer</b> from its tray icon and set a username and password on that computer.
              </p>
              <a className="rd-btn rd-btn--sm rd-btn--ghost" href="/desktop/Connect-Setup-latest.exe">Download the installer</a>
            </div>
          </div>

          <div className="rd-card">
            <h3>Recent connections</h3>
            <div className="rd-table-wrap">
              {recent.length === 0 ? (
                <div className="rd-empty">No connections yet. Anyone who connects to one of your computers — you, a colleague, or Loopcom support — will be listed here.</div>
              ) : (
                <table className="rd-table">
                  <thead><tr><th>When</th><th>From</th><th>To</th><th>Length</th><th>Sound · Mic</th><th>Ended by</th></tr></thead>
                  <tbody>
                    {recent.map((s) => {
                      const from = s.kind === "support"
                        ? `Loopcom support${s.requestedByName ? ` · ${s.requestedByName}` : ""}`
                        : `${s.requestedByName || "Someone"}${s.requestedByUserId === user.id ? " (you)" : ""}${s.connectedFrom ? ` · ${s.connectedFrom}` : ""}`;
                      const length = s.startedAt && s.endedAt ? durationLabel(new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) : s.status === "ACTIVE" ? "live" : "—";
                      const audio = s.kind === "support" ? "—" : `${s.soundUsed ? "Here" : "Off"} · ${s.micUsed ? "Here" : "Off"}`;
                      return (
                        <tr key={s.id}>
                          <td>{relativeTime(s.createdAt)}</td>
                          <td>{from}</td>
                          <td>{s.machineName || "This account"}</td>
                          <td>{length}</td>
                          <td>{audio}</td>
                          <td>{endedByLabel(s, user.id)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

        <div className="rd-col">
          <div className="rd-card rd-card--stack">
            <div>
              <h3>Connect to someone else’s computer</h3>
              <p className="rd-sub">They give you the Connect ID and password from their Loopcom app.</p>
            </div>
            {!facts?.canConnectById ? (
              <p className="rd-note">Your account is not set up to connect by ID. Ask your administrator to turn on “connect by ID” for you.</p>
            ) : !facts.fromDesktopApp ? (
              <p className="rd-note">Open the Loopcom app on this computer to connect by ID. Connecting by ID works only from Loopcom app to Loopcom app.</p>
            ) : (
              <>
                <label className="rd-field">
                  <span className="rd-label">Connect ID</span>
                  <input className="rd-input rd-input--big rd-mono" inputMode="numeric" placeholder="000 000 000" value={typedConnectId(idInput)} onChange={(e) => setIdInput(e.target.value)} />
                </label>
                <label className="rd-field">
                  <span className="rd-label">Password</span>
                  <input className="rd-input rd-mono" type="password" placeholder="from the other person" value={idPassword} onChange={(e) => setIdPassword(e.target.value)} autoComplete="off" />
                </label>
                <label className="rd-opt" style={{ padding: 0 }}>
                  <input type="checkbox" checked={idAudio} onChange={(e) => setIdAudio(e.target.checked)} />
                  <span>Play their sound here and use my microphone there<small>Turn off for silent viewing.</small></span>
                </label>
                {idError && <p className="rd-error">{idError}</p>}
                <button type="button" className="rd-btn rd-btn--primary rd-btn--block" disabled={idBusy} onClick={() => void submitById()}>{idBusy ? "Connecting…" : "Connect"}</button>
              </>
            )}
          </div>

          <div className="rd-card rd-card--stack">
            <div>
              <h3>Let someone connect to this computer</h3>
              <p className="rd-sub">{thisMachine ? `${thisMachine.name} · you decide what they may do and for how long.` : "Available in the Loopcom app, on a computer with Remote Desktop switched on."}</p>
            </div>
            {thisMachine && facts?.canShareOwnComputer ? (
              <>
                <div className="rd-id-row">
                  <span className="rd-id rd-mono">{thisMachine.connectIdDisplay}</span>
                  <button type="button" className="rd-btn rd-btn--sm" onClick={() => void copyText(thisMachine.connectId)}>{copied ? "Copied" : "Copy"}</button>
                </div>
                <button type="button" className="rd-btn rd-btn--block" onClick={() => openShare(thisMachine)}>Create a password for them</button>
                {shares.length > 0 && (
                  <div className="rd-share-list">
                    {shares.map((s) => (
                      <div className="rd-share-row" key={s.id}>
                        <span>{shareExpiryLabel(s)} · {s.scope === "anyone" ? "anyone with Loopcom" : `people in ${tenant.name}`}{s.usedCount ? ` · used ${s.usedCount}×` : ""}</span>
                        <button type="button" className="rd-btn rd-btn--sm rd-btn--ghost" onClick={() => revokeShare(thisMachine.id, s.id).then(() => listShares(thisMachine.id)).then((r) => setShares(r.shares)).catch(() => {})}>Remove</button>
                      </div>
                    ))}
                  </div>
                )}
                <p className="rd-note">A banner stays on this screen the whole time they are connected. <b>Stop</b> on it ends the connection at once, no matter what they are doing.</p>
              </>
            ) : thisMachine ? (
              <p className="rd-note">Your account is not set up to hand out access to this computer.</p>
            ) : bridge?.remoteDesktopSetup ? (
              <a className="rd-btn rd-btn--block" href="/remote-desktop/this-computer">Switch on Remote Desktop for this computer</a>
            ) : null}
          </div>
        </div>
      </div>

      {connect && (
        <div className="rd-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="rd-connect-title" onClick={() => !connect.busy && setConnect(null)}>
          <div className="rd-modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <div>
              <h3 id="rd-connect-title">Connect to {connect.machine.name}</h3>
              <p className="rd-sub">{connect.machine.online ? (connect.machine.locked ? "Online · Windows is locked" : "Online") : "Offline"} · {connect.machine.osLabel || "Windows"} · {connect.machine.monitors} monitor{connect.machine.monitors === 1 ? "" : "s"}</p>
            </div>
            <div className="rd-two">
              <label className="rd-field">
                <span className="rd-label">Username for {connect.machine.name}</span>
                <input className="rd-input rd-mono" autoFocus autoComplete="off" value={connect.username} onChange={(e) => setConnect({ ...connect, username: e.target.value })} />
              </label>
              <label className="rd-field">
                <span className="rd-label"><span>Password</span><span className="rd-note">Set on that computer</span></span>
                <input className="rd-input rd-mono" type="password" autoComplete="off" value={connect.password} onChange={(e) => setConnect({ ...connect, password: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") void submitConnect(); }} />
              </label>
            </div>
            <div className="rd-two">
              <div className="rd-field">
                <span className="rd-label">Start on</span>
                {connect.machine.monitors > 1 ? (
                  <ConnectSelect
                    value={connect.monitor}
                    onChange={(v) => setConnect({ ...connect, monitor: v })}
                    options={Array.from({ length: connect.machine.monitors }, (_, i) => ({ value: String(i + 1), label: `Monitor ${i + 1}` }))}
                  />
                ) : <span className="rd-input" style={{ color: "var(--text-dim)" }}>Monitor 1</span>}
              </div>
              <div className="rd-field">
                <span className="rd-label">Picture</span>
                <div className="rd-seg" role="group" aria-label="Picture">
                  <button type="button" aria-pressed={connect.picture === "sharp"} onClick={() => setConnect({ ...connect, picture: "sharp" })}>Sharp</button>
                  <button type="button" aria-pressed={connect.picture === "smooth"} onClick={() => setConnect({ ...connect, picture: "smooth" })}>Smooth</button>
                </div>
              </div>
            </div>
            <div className="rd-divider">
              <div className="rd-opt">
                <button type="button" role="switch" aria-checked={connect.sound} className="rd-toggle" onClick={() => setConnect({ ...connect, sound: !connect.sound })} />
                <span><b>Play {connect.machine.name}’s sound here</b><small>Anything it plays, including a ringing phone, comes out of this computer’s speakers.</small></span>
              </div>
              <div className="rd-opt">
                <button type="button" role="switch" aria-checked={connect.mic} className="rd-toggle" onClick={() => setConnect({ ...connect, mic: !connect.mic })} />
                <span><b>Use my microphone on {connect.machine.name}</b><small>Talk into this computer; its Loopcom hears you as its microphone, so you can answer a call on the remote Loopcom from here.</small></span>
              </div>
              <div className="rd-opt">
                <button type="button" role="switch" aria-checked={connect.clipboard} className="rd-toggle" onClick={() => setConnect({ ...connect, clipboard: !connect.clipboard })} />
                <span><b>Share clipboard</b><small>Copy on one side, paste on the other.</small></span>
              </div>
            </div>
            <p className="rd-note">{connect.machine.name} will show a banner saying you are connected. If someone is there, they can press Stop.</p>
            {connect.error && <p className="rd-error">{connect.error}</p>}
            <div className="rd-acts">
              <button type="button" className="rd-btn rd-btn--ghost" disabled={connect.busy} onClick={() => setConnect(null)}>Cancel</button>
              <button type="button" className="rd-btn rd-btn--primary" disabled={connect.busy || !connect.username.trim() || !connect.password} onClick={() => void submitConnect()}>{connect.busy ? "Connecting…" : "Connect"}</button>
            </div>
          </div>
        </div>
      )}

      {share && (
        <div className="rd-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="rd-share-title" onClick={() => !share.busy && setShare(null)}>
          <div className="rd-modal" onClick={(e) => e.stopPropagation()}>
            <div>
              <h3 id="rd-share-title">Let someone connect to {share.machine.name}</h3>
              <p className="rd-sub">Give them both lines. They enter them in their Loopcom app. The password is only ever shown once, here.</p>
            </div>
            {share.result ? (
              <>
                <div className="rd-two">
                  <div className="rd-field"><span className="rd-label"><span>Connect ID</span><span className="rd-note">(this computer, permanent)</span></span><span className="rd-input rd-input--big rd-mono">{share.result.connectIdDisplay}</span></div>
                  <div className="rd-field"><span className="rd-label"><span>Password</span><span className="rd-note">(new)</span></span>
                    <div className="rd-pw"><span className="rd-input rd-mono">{share.result.password}</span><button type="button" className="rd-btn rd-btn--sm" onClick={() => void copyText(`Connect ID ${share.result!.connectIdDisplay}\nPassword ${share.result!.password}`)}>{copied ? "Copied" : "Copy both"}</button></div>
                  </div>
                </div>
                <p className="rd-note">
                  Works {share.expiry === "once" ? "once" : share.expiry === "24h" ? "for 24 hours" : "until you remove it"}, for {share.scope === "anyone" ? "anyone using the Loopcom app" : `people in ${tenant.name}`}.
                  While they are connected this screen shows a red banner with their name. <b>Stop</b> ends it instantly. You can also remove the password from the card at any time.
                </p>
                <div className="rd-acts"><button type="button" className="rd-btn rd-btn--primary" onClick={() => setShare(null)}>Done, I’ve given it to them</button></div>
              </>
            ) : (
              <>
                <div className="rd-two">
                  <div className="rd-field"><span className="rd-label">Password works</span>
                    <label className="rd-opt"><input type="radio" name="rd-expiry" checked={share.expiry === "once"} onChange={() => setShare({ ...share, expiry: "once" })} /><span>Once<small>Dies after the first connection.</small></span></label>
                    <label className="rd-opt"><input type="radio" name="rd-expiry" checked={share.expiry === "24h"} onChange={() => setShare({ ...share, expiry: "24h" })} /><span>For 24 hours</span></label>
                    <label className="rd-opt"><input type="radio" name="rd-expiry" checked={share.expiry === "standing"} onChange={() => setShare({ ...share, expiry: "standing" })} /><span>Until I remove it<small>Shows on the card as a standing password.</small></span></label>
                  </div>
                  <div className="rd-field"><span className="rd-label">Who can use it</span>
                    <label className="rd-opt"><input type="radio" name="rd-scope" checked={share.scope === "company"} onChange={() => setShare({ ...share, scope: "company" })} /><span>Only people in {tenant.name}<small>They must be signed in to Loopcom on your company.</small></span></label>
                    <label className="rd-opt"><input type="radio" name="rd-scope" checked={share.scope === "anyone"} onChange={() => setShare({ ...share, scope: "anyone" })} /><span>Anyone using the Loopcom app<small>Another company, or Loopcom support. Still app to app.</small></span></label>
                  </div>
                </div>
                <div className="rd-field"><span className="rd-label">They may</span>
                  <label className="rd-opt"><input type="checkbox" checked={share.allowControl} onChange={(e) => setShare({ ...share, allowControl: e.target.checked })} /><span>Use the mouse and keyboard<small>Off means look only.</small></span></label>
                  <label className="rd-opt"><input type="checkbox" checked={share.allowSound} onChange={(e) => setShare({ ...share, allowSound: e.target.checked })} /><span>Hear this computer’s sound on theirs</span></label>
                  <label className="rd-opt"><input type="checkbox" checked={share.allowMic} onChange={(e) => setShare({ ...share, allowMic: e.target.checked })} /><span>Use their microphone here<small>Off by default when sharing with someone else.</small></span></label>
                  <label className="rd-opt"><input type="checkbox" checked={share.allowClipboard} onChange={(e) => setShare({ ...share, allowClipboard: e.target.checked })} /><span>Share the clipboard</span></label>
                  <label className="rd-opt rd-opt--dis"><input type="checkbox" disabled /><span>Administrator windows<small>Not available in this version.</small></span></label>
                </div>
                {share.error && <p className="rd-error">{share.error}</p>}
                <div className="rd-acts">
                  <button type="button" className="rd-btn rd-btn--ghost" disabled={share.busy} onClick={() => setShare(null)}>Cancel</button>
                  <button type="button" className="rd-btn rd-btn--primary" disabled={share.busy} onClick={() => void submitShare()}>{share.busy ? "Creating…" : "Create the password"}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function durationLabel(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h} h ${String(m).padStart(2, "0")} min`;
}

function endedByLabel(s: DesktopSession, myId: string): string {
  if (!s.endedAt) return s.status === "ACTIVE" ? "Still connected" : "—";
  if (s.endedBy === "machine") return "Stop at the computer";
  if (s.endedBy === "control") return "Loopcom";
  if (s.endedBy === "viewer" || s.endedBy === "support") return s.requestedByUserId === myId ? "You" : (s.requestedByName || "Them");
  if (s.endedReason === "max_duration") return "Time limit";
  if (s.endedReason === "expired" || s.endedReason === "machine_did_not_answer") return "Not answered";
  return s.endedBy ? s.endedBy : "—";
}
