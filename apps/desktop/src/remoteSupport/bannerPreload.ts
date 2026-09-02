/**
 * The session banner's own bridge.
 *
 * The banner is a separate window with no node integration, so it needs a
 * preload to reach the main process. Kept to three things — say stop, answer a
 * yes/no question the connected person asked, and receive a text update —
 * because this window sits on top of everything the customer does and should be
 * able to do as little as possible.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("connectBanner", {
  /** ⛔ The customer's stop button. Must never be able to fail or be gated. */
  stop: () => ipcRenderer.send("remote-support:banner-stop"),
  /**
   * The mid-session ask, answered INSIDE the banner (Remote Desktop, 2026-09-02).
   * Carries only the capability name and yes/no; the renderer that owns the
   * session turns it into the server call.
   */
  answer: (capability: string, allow: boolean) =>
    ipcRenderer.send("remote-support:banner-answer", { capability: String(capability || ""), allow: allow === true }),
  onUpdate: (listener: (state: Record<string, unknown>) => void) => {
    ipcRenderer.on("banner:update", (_e, state) => listener(state));
  },
});
