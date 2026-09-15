/**
 * The Loopcom edge frame — the blue glow the mockup calls the takeover screen.
 *
 * One transparent, click-through, always-on-top, non-focusable BrowserWindow per
 * display, covering that display's full work area. It shows the frame in the
 * session's colour (blue working / grey paused / amber asking / green finished) and
 * the live status text, and it NEVER receives input: `setIgnoreMouseEvents(true)`
 * means every click passes straight through to the real app underneath. The person
 * always sees, unmistakably, that the screen is being driven — and can still work.
 *
 * ⛔ It must never steal focus or the cursor. focusable:false, showInactive(), no
 * accelerators. The one thing that stops a run — Escape — is watched non-swallowing
 * by the yield hook (screenController.ts), NOT by a global accelerator that would
 * take Escape away from every other app.
 */
import type { BrowserWindow as BW, Screen, Display } from "electron";

export type OverlayFrame = "blue" | "grey" | "amber" | "green" | "none";

export type OverlayDeps = {
  BrowserWindow: typeof BW;
  screen: Screen;
  assetPath: (file: string) => string;
  preloadPath: string;
  log: (line: string) => void;
  attachDiag?: (win: BW, tag: string) => void;
};

type PerDisplay = { id: number; win: BW };

export class ScreenOverlay {
  private windows: PerDisplay[] = [];
  private frame: OverlayFrame = "none";
  private status = "";
  private displaysChanged = () => this.reflow();

  constructor(private deps: OverlayDeps) {}

  /** True while any overlay window is up. */
  get shown(): boolean {
    return this.windows.length > 0;
  }

  /** Raise the frame on every display and start following display changes. */
  show(frame: OverlayFrame, status: string): void {
    this.frame = frame;
    this.status = status;
    try {
      this.build();
      this.deps.screen.on("display-added", this.displaysChanged);
      this.deps.screen.on("display-removed", this.displaysChanged);
      this.deps.screen.on("display-metrics-changed", this.displaysChanged);
    } catch (e) {
      this.deps.log(`overlay show failed: ${String(e)}`);
    }
  }

  /** Change the frame colour and status text without rebuilding the windows. */
  update(frame: OverlayFrame, status?: string): void {
    this.frame = frame;
    if (status !== undefined) this.status = status;
    for (const d of this.windows) this.push(d.win);
  }

  /** Drop the frame from every display and stop following display changes. */
  hide(): void {
    try {
      this.deps.screen.off("display-added", this.displaysChanged);
      this.deps.screen.off("display-removed", this.displaysChanged);
      this.deps.screen.off("display-metrics-changed", this.displaysChanged);
    } catch { /* not listening */ }
    for (const d of this.windows) { try { if (!d.win.isDestroyed()) d.win.destroy(); } catch { /* gone */ } }
    this.windows = [];
    this.frame = "none";
  }

  private build(): void {
    const displays = this.deps.screen.getAllDisplays();
    for (const display of displays) {
      if (this.windows.some((d) => d.id === display.id)) continue;
      const win = this.makeWindow(display);
      if (win) this.windows.push({ id: display.id, win });
    }
  }

  /** A display was added/removed/resized — rebuild to cover the new arrangement. */
  private reflow(): void {
    if (!this.shown) return;
    const wanted = new Set(this.deps.screen.getAllDisplays().map((d) => d.id));
    for (const d of [...this.windows]) {
      if (!wanted.has(d.id)) { try { if (!d.win.isDestroyed()) d.win.destroy(); } catch { /* gone */ } this.windows = this.windows.filter((x) => x !== d); }
    }
    this.build();
    // resize survivors to their display's current bounds
    for (const d of this.windows) {
      const disp = this.deps.screen.getAllDisplays().find((x) => x.id === d.id);
      if (disp && !d.win.isDestroyed()) { try { d.win.setBounds(disp.bounds); } catch { /* ignore */ } }
    }
  }

  private makeWindow(display: Display): BW | null {
    try {
      const b = display.bounds;
      const win = new this.deps.BrowserWindow({
        x: b.x, y: b.y, width: b.width, height: b.height,
        frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
        fullscreenable: false, skipTaskbar: true, focusable: false, hasShadow: false, show: false, backgroundColor: "#00000000",
        // ⛔ alwaysOnTop at the screen-saver level so it floats over full-screen apps,
        // but it never takes focus and never eats a click (setIgnoreMouseEvents below).
        alwaysOnTop: true, acceptFirstMouse: false,
        webPreferences: { preload: this.deps.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true, additionalArguments: ["--connect-window-kind=coworker-screen-overlay"] },
      });
      this.deps.attachDiag?.(win, "coworker-screen-overlay");
      win.setIgnoreMouseEvents(true, { forward: false }); // click-through: the frame never intercepts a click
      win.setAlwaysOnTop(true, "screen-saver");
      try { win.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true }); } catch { /* platform */ }
      win.loadFile(this.deps.assetPath("coworkerScreenOverlay.html"));
      win.once("ready-to-show", () => { try { win.showInactive(); this.push(win); } catch { /* ignore */ } });
      return win;
    } catch (e) {
      this.deps.log(`overlay window failed: ${String(e)}`);
      return null;
    }
  }

  /** Send the current frame + status to one overlay window's renderer. */
  private push(win: BW): void {
    try {
      if (win.isDestroyed()) return;
      win.webContents.send("coworker-screen-overlay:state", { frame: this.frame, status: this.status });
    } catch { /* renderer not ready; ready-to-show pushes again */ }
  }
}
