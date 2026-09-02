/**
 * Main-process half of Remote Desktop: the identity this installation proves
 * itself with, the username and password that protect it, and the two things
 * the renderer cannot know on its own — whether Windows is locked, and whether
 * this session may carry the computer's sound.
 *
 * ⛔ THE CREDENTIALS NEVER LEAVE THIS PROCESS. The renderer hands a typed
 * username and password to `verify-login`, gets back a verdict, and never sees
 * the hash. The server never sees any of it. That is the promise the mockups
 * make ("kept only on this computer"), and it is kept here.
 *
 * ⛔ NOTHING IN HERE STARTS BY ITSELF. Screen capture, input and the banner are
 * the remote-support module's handlers, reused unchanged; every one of them runs
 * only when the renderer holds a session id the server issued.
 */
import { app, ipcMain, powerMonitor, screen, BrowserWindow } from "electron";
import os from "node:os";
import type { DesktopSettings, RemoteDesktopIdentity } from "../types";
import {
  attemptLogin,
  createAccessLogin,
  describeLogin,
  mintDeviceId,
  mintMachineKey,
  validatePassword,
  validateUsername,
} from "./credentials";

type Deps = {
  getSettings: () => DesktopSettings;
  writeSettings: (next: DesktopSettings) => void;
  log: (line: string) => void;
  /** Turning the feature OFF ends whatever is running, now. */
  onDisabled: () => void;
  /** Re-draw the tray after a change that its labels reflect. */
  rebuildTray: () => void;
};

let sessionLocked = false;
/** The session whose capture may include the computer's sound. Null = never. */
let audioAllowedForSession: string | null = null;

/** Read by main.ts's display-media handler. */
export function remoteDesktopAudioAllowed(): boolean {
  return audioAllowedForSession !== null;
}

/** Everything torn down together. Called on disable and on quit. */
export function stopRemoteDesktop(): void {
  audioAllowedForSession = null;
}

export function isSessionLocked(): boolean {
  return sessionLocked;
}

/**
 * Mint the install id and machine key the first time they are needed, and
 * persist them. Idempotent; never rotates an existing pair (rotating is
 * "remove this computer, enroll again", which is the owner's deliberate act).
 */
export function ensureRemoteDesktopIdentity(settings: DesktopSettings): { settings: DesktopSettings; changed: boolean } {
  const rd = settings.remoteDesktop ?? {};
  if (rd.deviceId && rd.machineKey) return { settings, changed: false };
  return {
    settings: {
      ...settings,
      remoteDesktop: {
        ...rd,
        deviceId: rd.deviceId || mintDeviceId(),
        machineKey: rd.machineKey || mintMachineKey(),
      },
    },
    changed: true,
  };
}

function osLabel(): string {
  const release = os.release();
  // 10.0.22000+ is Windows 11 in disguise.
  const build = Number(release.split(".")[2] || 0);
  if (process.platform === "win32") return build >= 22000 ? "Windows 11" : "Windows 10";
  return `${process.platform} ${release}`;
}

function identityFrom(settings: DesktopSettings): RemoteDesktopIdentity {
  const rd = settings.remoteDesktop ?? {};
  return {
    enabled: settings.remoteDesktopEnabled === true,
    deviceId: rd.deviceId || "",
    machineKey: rd.machineKey || "",
    name: (rd.name || "").trim() || os.hostname(),
    hostname: os.hostname(),
    osLabel: osLabel(),
    appVersion: app.getVersion(),
    monitors: safeDisplayCount(),
    locked: sessionLocked,
    login: describeLogin(rd.accessLogin ?? null),
  };
}

function safeDisplayCount(): number {
  try { return Math.max(1, screen.getAllDisplays().length); } catch { return 1; }
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try { win.webContents.send(channel, payload); } catch { /* window going away */ }
  }
}

export function registerRemoteDesktopIpc(deps: Deps): void {
  // Windows tells us when the session locks. A locked desktop is a black
  // picture and the OS refuses injected input — say so instead of being
  // discovered by failing.
  try {
    powerMonitor.on("lock-screen", () => { sessionLocked = true; broadcast("remote-desktop:lock-changed", true); deps.log("session locked"); });
    powerMonitor.on("unlock-screen", () => { sessionLocked = false; broadcast("remote-desktop:lock-changed", false); deps.log("session unlocked"); });
  } catch (err) {
    deps.log(`lock watch unavailable: ${String(err)}`);
  }

  /** Who this installation is. Mints the id + key on first ask, and persists them. */
  ipcMain.handle("remote-desktop:identity", (): RemoteDesktopIdentity => {
    const cur = deps.getSettings();
    const ensured = ensureRemoteDesktopIdentity(cur);
    if (ensured.changed) deps.writeSettings(ensured.settings);
    return identityFrom(ensured.settings);
  });

  /**
   * Set (or replace) the username and password for this computer. Validated
   * here again — the renderer's checks are for a good error message, these are
   * the ones that count.
   */
  ipcMain.handle("remote-desktop:set-login", (_event, raw: unknown): { ok: true; login: RemoteDesktopIdentity["login"] } | { ok: false; reason: string; message: string } => {
    const body = (raw ?? {}) as { username?: unknown; password?: unknown };
    const u = validateUsername(body.username);
    if (!u.ok) return u;
    const p = validatePassword(body.password);
    if (!p.ok) return p;
    const cur = ensureRemoteDesktopIdentity(deps.getSettings()).settings;
    const login = createAccessLogin(String(body.username), String(body.password));
    deps.writeSettings({ ...cur, remoteDesktop: { ...(cur.remoteDesktop ?? {}), accessLogin: login } });
    deps.log("access login set");
    deps.rebuildTray();
    return { ok: true, login: describeLogin(login) };
  });

  ipcMain.handle("remote-desktop:clear-login", () => {
    const cur = deps.getSettings();
    deps.writeSettings({ ...cur, remoteDesktop: { ...(cur.remoteDesktop ?? {}), accessLogin: null } });
    deps.log("access login cleared");
    deps.rebuildTray();
    return { ok: true };
  });

  /**
   * One login attempt from the connecting side, arriving over the peer
   * connection. Returns a verdict; persists the strike or the reset FIRST so a
   * crash between the two cannot lose a lockout.
   */
  ipcMain.handle("remote-desktop:verify-login", (_event, raw: unknown): { ok: boolean; attemptsLeft: number; lockedForMs: number; reason?: string } => {
    const body = (raw ?? {}) as { username?: unknown; password?: unknown };
    const cur = deps.getSettings();
    const verdict = attemptLogin(cur.remoteDesktop?.accessLogin ?? null, body.username, body.password);
    if (verdict.login) {
      deps.writeSettings({ ...cur, remoteDesktop: { ...(cur.remoteDesktop ?? {}), accessLogin: verdict.login } });
    }
    if (verdict.ok) {
      deps.log("login accepted");
      return { ok: true, attemptsLeft: 0, lockedForMs: 0 };
    }
    deps.log(`login refused: ${verdict.reason}`);
    return {
      ok: false,
      reason: verdict.reason,
      attemptsLeft: verdict.attemptsLeft,
      lockedForMs: verdict.lockedUntil ? Math.max(0, verdict.lockedUntil - Date.now()) : 0,
    };
  });

  /**
   * The tray switch, from the setup page. ⛔ Turning ON requires a login to
   * exist — an unattended computer with no password is a door with no lock, and
   * the server refuses to connect to it anyway (`no_access_login`).
   */
  ipcMain.handle("remote-desktop:set-enabled", (_event, enabled: unknown): { ok: boolean; enabled: boolean; message?: string } => {
    const on = enabled === true;
    const cur = ensureRemoteDesktopIdentity(deps.getSettings()).settings;
    if (on && !cur.remoteDesktop?.accessLogin) {
      return { ok: false, enabled: false, message: "Set a username and password first." };
    }
    deps.writeSettings({ ...cur, remoteDesktopEnabled: on });
    if (!on) {
      stopRemoteDesktop();
      deps.onDisabled();
    }
    deps.log(`${on ? "allowed" : "turned off"} — applies to windows opened from now on`);
    deps.rebuildTray();
    return { ok: true, enabled: on };
  });

  ipcMain.handle("remote-desktop:set-name", (_event, raw: unknown) => {
    const name = String(raw ?? "").trim().slice(0, 80);
    const cur = deps.getSettings();
    deps.writeSettings({ ...cur, remoteDesktop: { ...(cur.remoteDesktop ?? {}), name: name || undefined } });
    deps.rebuildTray();
    return { ok: true, name: name || os.hostname() };
  });

  /** The server minted a Connect ID; remember it so the tray can show it. */
  ipcMain.handle("remote-desktop:report-connect-id", (_event, raw: unknown) => {
    const id = String(raw ?? "").replace(/\D/g, "");
    if (!/^\d{9}$/.test(id)) return { ok: false };
    const cur = deps.getSettings();
    if ((cur.remoteDesktop as any)?.connectId !== id) {
      deps.writeSettings({ ...cur, remoteDesktop: { ...(cur.remoteDesktop ?? {}), connectId: id } as any });
      deps.rebuildTray();
    }
    return { ok: true };
  });

  /**
   * May this session's capture include the computer's sound? Set by the
   * renderer only for a session the server granted `sound`, cleared when it
   * ends. Read by the display-media handler in main.ts.
   */
  ipcMain.handle("remote-desktop:allow-audio", (_event, raw: unknown) => {
    const body = (raw ?? {}) as { sessionId?: unknown; allow?: unknown };
    const id = String(body.sessionId || "");
    audioAllowedForSession = body.allow === true && id ? id : null;
    deps.log(`system audio ${audioAllowedForSession ? "allowed" : "not allowed"} for capture`);
    return { ok: true };
  });

  ipcMain.handle("remote-desktop:lock-state", () => sessionLocked);
}
