"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "../services/apiClient";
import { readDndState, savedDndState, type DndResponse, type DndState } from "./profileDnd";

export function useProfileDnd(open: boolean, accountKey: string) {
  const [state, setState] = useState<DndState>({ status: "loading" });
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const pendingWrite = useRef<Promise<DndResponse> | null>(null);

  const refresh = useCallback(async () => {
    const id = ++request.current;
    setState({ status: "loading" });
    setError(null);
    try {
      // Reopening while a save is in flight must read AFTER that save finishes.
      await pendingWrite.current?.catch(() => undefined);
      if (id !== request.current) return;
      const response = await apiGet<DndResponse>("/voice/extensions/me/dnd");
      if (id === request.current) setState(readDndState(response));
    } catch {
      if (id === request.current) setState({ status: "unavailable", reason: "read_failed" });
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
    return () => { request.current += 1; };
  }, [open, accountKey, refresh]);

  async function change(enabled: boolean) {
    if (state.status !== "ready" || pendingWrite.current) return;
    const id = ++request.current;
    setState({ status: "saving" });
    setError(null);
    const operation = apiPost<DndResponse>("/voice/extensions/me/dnd", { dnd: enabled });
    pendingWrite.current = operation;
    try {
      // This is the real extension-wide PBX endpoint, never the browser mute or
      // mobile wake-suppression flag. No write occurs on mount, refresh or retry.
      const response = await operation;
      if (id !== request.current) return;
      const next = savedDndState(response);
      setState(next);
      if (next.status === "ready" && next.enabled !== enabled) {
        setError("The phone system reported a different state. Please try again.");
      }
    } catch {
      if (id === request.current) {
        setState({ status: "unavailable", reason: "unconfirmed" });
        setError("We couldn’t confirm the change. Check status to see whether it took effect.");
      }
    } finally {
      if (pendingWrite.current === operation) pendingWrite.current = null;
    }
  }

  return { state, error, refresh, change };
}
