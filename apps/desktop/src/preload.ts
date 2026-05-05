import { contextBridge, ipcRenderer } from "electron";
import type { DesktopSettings, DesktopWindowKind, PhoneEngineCommand, PhoneEngineEnvelope } from "./types";

function windowKind(): DesktopWindowKind | undefined {
  const arg = process.argv.find((item) => item.startsWith("--connect-window-kind="));
  return arg?.split("=")[1] as DesktopWindowKind | undefined;
}

const desktopApi = {
  isDesktop: true,
  platform: process.platform,
  windowKind: windowKind(),

  window: {
    openMini: () => ipcRenderer.invoke("desktop:open-mini"),
    openFull: (route?: string) => ipcRenderer.invoke("desktop:open-full", route ?? null),
    expandToFull: (route?: string) => ipcRenderer.invoke("desktop:expand-full", route ?? null),
    closeMini: () => ipcRenderer.invoke("desktop:close-mini"),
    minimize: () => ipcRenderer.invoke("desktop:minimize"),
    toggleAlwaysOnTop: () => ipcRenderer.invoke("desktop:toggle-always-on-top"),
    getSettings: () => ipcRenderer.invoke("desktop:get-settings") as Promise<DesktopSettings>,
    updateSettings: (patch: Partial<DesktopSettings>) =>
      ipcRenderer.invoke("desktop:update-settings", patch) as Promise<DesktopSettings>,
    onSettings: (listener: (settings: DesktopSettings) => void) => {
      const wrapped = (_: unknown, settings: DesktopSettings) => listener(settings);
      ipcRenderer.on("desktop:settings", wrapped);
      return () => ipcRenderer.removeListener("desktop:settings", wrapped);
    },
  },

  phone: {
    sendFromEngine: (envelope: PhoneEngineEnvelope) => ipcRenderer.send("phone:engine-event", envelope),
    sendCommand: (command: PhoneEngineCommand) => ipcRenderer.invoke("phone:command", command),
    onEngineEvent: (listener: (envelope: PhoneEngineEnvelope) => void) => {
      const wrapped = (_: unknown, envelope: PhoneEngineEnvelope) => listener(envelope);
      ipcRenderer.on("phone:engine-event", wrapped);
      return () => ipcRenderer.removeListener("phone:engine-event", wrapped);
    },
    onCommand: (listener: (command: PhoneEngineCommand) => void) => {
      const wrapped = (_: unknown, command: PhoneEngineCommand) => listener(command);
      ipcRenderer.on("phone:command", wrapped);
      return () => ipcRenderer.removeListener("phone:command", wrapped);
    },
  },

  notifications: {
    show: (payload: { kind: string; title: string; body?: string; route?: string }) =>
      ipcRenderer.invoke("desktop:notification", payload),
  },
};

contextBridge.exposeInMainWorld("connectDesktop", desktopApi);
