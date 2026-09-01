/**
 * The session banner's own bridge.
 *
 * The banner is a separate window with no node integration, so it needs a
 * preload to reach the main process. Kept to exactly two things — say stop,
 * and receive a text update — because this window sits on top of everything the
 * customer does and should be able to do as little as possible.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("connectBanner", {
  /** ⛔ The customer's stop button. Must never be able to fail or be gated. */
  stop: () => ipcRenderer.send("remote-support:banner-stop"),
  onUpdate: (listener: (state: { supportName?: string; controlGranted?: boolean }) => void) => {
    ipcRenderer.on("banner:update", (_e, state) => listener(state));
  },
});
