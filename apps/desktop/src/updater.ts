import { app, BrowserWindow, dialog } from "electron";
import { autoUpdater } from "electron-updater";

// ── In-app auto-update ────────────────────────────────────────────────
// The app checks the generic update feed (see `build.publish` in package.json,
// served by nginx at https://app.connectcomunications.com/desktop/). When a newer
// version is published, electron-updater downloads it in the background and we
// prompt the user to restart. Users get one-click "Update" instead of manually
// re-downloading the installer every release.
//
// NOTE: this only works from the FIRST build that contains this module onward —
// a copy that lacks the updater can't update itself. That's why 0.1.2 is a
// one-time manual install for existing users; everything after is automatic.

type Diag = (tag: string, message: string) => void;

let diag: Diag = () => {};
// True when the user explicitly clicked "Check for Updates" — controls whether
// we show "you're up to date" / error dialogs (silent on the automatic checks).
let interactiveCheck = false;
// Guard so the "update ready" prompt only appears once per downloaded update.
let promptedForDownload = false;
let initialised = false;

function firstLiveWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
}

export function initAutoUpdater(logger: Diag): void {
  if (initialised) return;
  initialised = true;
  diag = logger;

  // Route electron-updater's own logging into our diagnostic file.
  autoUpdater.logger = {
    info: (m: unknown) => diag("update", `info: ${String(m)}`),
    warn: (m: unknown) => diag("update", `warn: ${String(m)}`),
    error: (m: unknown) => diag("update", `error: ${String(m)}`),
    debug: (m: unknown) => diag("update", `debug: ${String(m)}`),
  } as unknown as typeof autoUpdater.logger;

  autoUpdater.autoDownload = true;            // pull the update in the background
  autoUpdater.autoInstallOnAppQuit = true;    // apply on next quit if not restarted now

  autoUpdater.on("checking-for-update", () => diag("update", "checking for update"));

  autoUpdater.on("update-available", (info) => {
    diag("update", `update available: ${info?.version} — downloading`);
  });

  autoUpdater.on("update-not-available", (info) => {
    diag("update", `no update (installed ${app.getVersion()} is latest ${info?.version ?? ""})`);
    if (interactiveCheck) {
      interactiveCheck = false;
      void dialog.showMessageBox({
        type: "info",
        title: "Connect",
        message: "You're up to date",
        detail: `Connect ${app.getVersion()} is the latest version.`,
        buttons: ["OK"],
      });
    }
  });

  autoUpdater.on("download-progress", (p) => {
    diag("update", `downloading ${Math.round(p?.percent ?? 0)}%`);
  });

  autoUpdater.on("error", (err) => {
    diag("update", `error: ${String(err)}`);
    if (interactiveCheck) {
      interactiveCheck = false;
      void dialog.showMessageBox({
        type: "error",
        title: "Connect",
        message: "Couldn't check for updates",
        detail: String(err),
        buttons: ["OK"],
      });
    }
  });

  autoUpdater.on("update-downloaded", (info) => {
    diag("update", `update downloaded: ${info?.version}`);
    if (promptedForDownload) return;
    promptedForDownload = true;
    interactiveCheck = false;
    const win = firstLiveWindow();
    const opts = {
      type: "info" as const,
      title: "Update ready",
      message: `Connect ${info?.version} is ready to install`,
      detail:
        "The update has been downloaded. Restart Connect to apply it now — or it'll be applied automatically next time you quit.",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
    };
    const p = win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
    void p
      .then((res) => {
        if (res.response === 0) {
          diag("update", "user chose Restart now — quitAndInstall");
          // Defer so the dialog fully closes before windows are torn down.
          setImmediate(() => autoUpdater.quitAndInstall());
        }
      })
      .catch((e) => diag("update", `restart prompt error: ${String(e)}`));
  });

  // Check on launch, then every 3 hours while the app runs.
  void runCheck();
  setInterval(() => void runCheck(), 3 * 60 * 60 * 1000);
}

async function runCheck(): Promise<void> {
  if (!app.isPackaged) {
    diag("update", "skip check (unpackaged / dev build)");
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    diag("update", `check failed: ${String(err)}`);
  }
}

// Wired to the tray "Check for Updates…" item — gives the user feedback even
// when they're already current.
export function checkForUpdatesInteractive(): void {
  if (!app.isPackaged) {
    void dialog.showMessageBox({
      type: "info",
      title: "Connect",
      message: "Updates are disabled in development builds.",
      buttons: ["OK"],
    });
    return;
  }
  interactiveCheck = true;
  void runCheck();
}
