"use client";

import { useEffect, useRef, useState } from "react";

type AsyncState<T> =
  | { status: "loading"; data: null; error: null }
  | { status: "success"; data: T; error: null }
  | { status: "error"; data: null; error: string };

export function useAsyncResource<T>(loader: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading", data: null, error: null });
  // Keep a ref to the last successful data so subsequent refreshes don't flash "--"
  const lastData = useRef<T | null>(null);

  useEffect(() => {
    let active = true;
    // Only show "loading" on the very first fetch; subsequent refreshes keep last data visible
    if (lastData.current === null) {
      setState({ status: "loading", data: null, error: null });
    }
    loader()
      .then((data) => {
        if (!active) return;
        lastData.current = data;
        setState({ status: "success", data, error: null });
      })
      .catch((error: unknown) => {
        if (!active) return;
        // On error after first load, keep showing last data if available
        if (lastData.current !== null) {
          setState({ status: "success", data: lastData.current, error: null });
        } else {
          setState({
            status: "error",
            data: null,
            error: error instanceof Error ? error.message : "Unexpected error"
          });
        }
      });
    return () => {
      active = false;
    };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  return state;
}
