"use client";
import { useEffect, useRef } from "react";
import { startDeployPolling, type DeployPollResult } from "../lib/deployPolling";

export function useDeployPolling(poll: () => Promise<DeployPollResult>, key: string, enabled = true) {
  const callback = useRef(poll);
  callback.current = poll;
  useEffect(() => {
    if (!enabled) return;
    return startDeployPolling(() => callback.current(), {
      visible: () => !document.hidden,
      schedule: (fn, delay) => window.setTimeout(fn, delay),
      cancel: (timer) => window.clearTimeout(timer as number),
      onVisible: (fn) => {
        document.addEventListener("visibilitychange", fn);
        return () => document.removeEventListener("visibilitychange", fn);
      },
    });
  }, [key, enabled]);
}
