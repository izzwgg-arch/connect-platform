"use client";

import { useEffect, useRef, useState } from "react";

type AsyncState<T> =
  | { status: "loading"; data: null; error: null; refreshing: false }
  | { status: "success"; data: T; error: null; refreshing: boolean }
  | { status: "error"; data: null; error: string; refreshing: false };

type AsyncResourceOptions = {
  keepPreviousData?: boolean;
};

export function useAsyncResource<T>(loader: () => Promise<T>, deps: unknown[], options: AsyncResourceOptions = {}): AsyncState<T> {
  const keepPreviousData = options.keepPreviousData ?? true;
  const [state, setState] = useState<AsyncState<T>>({ status: "loading", data: null, error: null, refreshing: false });
  // Keep a ref to the last successful data so subsequent refreshes don't flash "--"
  const lastData = useRef<T | null>(null);

  useEffect(() => {
    let active = true;
    // Directory-like tenant-scoped resources must be able to opt out of stale
    // previous data so tenant switches never render another tenant's rows.
    if (!keepPreviousData || lastData.current === null) {
      if (!keepPreviousData) lastData.current = null;
      setState({ status: "loading", data: null, error: null, refreshing: false });
    } else {
      setState({ status: "success", data: lastData.current, error: null, refreshing: true });
    }
    loader()
      .then((data) => {
        if (!active) return;
        lastData.current = data;
        setState({ status: "success", data, error: null, refreshing: false });
      })
      .catch((error: unknown) => {
        if (!active) return;
        // On error after first load, keep showing last data if available
      if (keepPreviousData && lastData.current !== null) {
          setState({ status: "success", data: lastData.current, error: null, refreshing: false });
        } else {
          setState({
            status: "error",
            data: null,
            error: error instanceof Error ? error.message : "Unexpected error",
            refreshing: false
          });
        }
      });
    return () => {
      active = false;
    };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  return state;
}
