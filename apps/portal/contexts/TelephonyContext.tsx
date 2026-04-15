"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useTelephonySocket, type TelephonySocketState } from "../hooks/useTelephonySocket";
import type { LiveCall, LiveExtensionState, LiveQueueState } from "../types/liveCall";

interface TelephonyContextValue extends TelephonySocketState {
  activeCalls: LiveCall[];
  callsByTenant: (tenantId: string | null) => LiveCall[];
  extensionList: LiveExtensionState[];
  queueList: LiveQueueState[];
  isLive: boolean;
}

const TelephonyContext = createContext<TelephonyContextValue | null>(null);

export function TelephonyProvider({ children }: { children: ReactNode }) {
  const socket = useTelephonySocket();

  const value = useMemo<TelephonyContextValue>(() => {
    const activeCalls = [...socket.calls.values()].filter(
      (c) => c.state !== "hungup",
    );
    const extensionList = [...socket.extensions.values()];
    const queueList = [...socket.queues.values()];

    const callsByTenant = (tenantId: string | null): LiveCall[] => {
      if (tenantId === null) {
        if (activeCalls.length > 0) {
          console.log("[PIPE:6/6] callsByTenant(GLOBAL) →", activeCalls.length, "calls", activeCalls.map((c) => ({ id: c.id, tenantId: c.tenantId, state: c.state })));
        }
        return activeCalls;
      }
      const filtered = activeCalls.filter((c) => c.tenantId === tenantId);
      const dropped = activeCalls.filter((c) => c.tenantId !== tenantId);
      if (activeCalls.length > 0) {
        console.log("[PIPE:6/6] callsByTenant(" + tenantId + ") →", filtered.length, "shown,", dropped.length, "dropped", dropped.map((c) => ({ id: c.id, tenantId: c.tenantId })));
      }
      return filtered;
    };

    return {
      ...socket,
      activeCalls,
      callsByTenant,
      extensionList,
      queueList,
      isLive: socket.status === "connected",
    };
  }, [socket]);

  return (
    <TelephonyContext.Provider value={value}>
      {children}
    </TelephonyContext.Provider>
  );
}

export function useTelephony(): TelephonyContextValue {
  const ctx = useContext(TelephonyContext);
  if (!ctx) throw new Error("useTelephony must be used inside TelephonyProvider");
  return ctx;
}
