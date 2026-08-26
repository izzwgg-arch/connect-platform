"use client";

/**
 * The order-twin trigger (mockup screen 3, v9): on a SUPERMARKET-mode tenant,
 * the moment an inbound call is ANSWERED, the window that answered opens the
 * order surface inside the caller's account — the mini dialer pops its twin
 * window; a full browser window navigates to /orders/new.
 *
 * ⛔ PASSIVE OBSERVER ONLY. This component watches phone.callState transitions
 * through useOptionalSipPhone and never touches the answer path, the SIP
 * engine, or any call control — the never-propose-a-fix-that-breaks-answering
 * rule made blast radius the design constraint. If this component crashes or
 * is unmounted, calls behave exactly as before.
 *
 * Cross-window: the answering window also broadcasts on localStorage
 * ("sm-order-pop", the AuthGate storage-event bus) so a main window can pick
 * the order up when the answer happened in the mini dialer and the twin
 * window could not open (popup policy). Only the answering window opens UI
 * directly; listeners only act in a full window, never another mini dialer.
 */

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useOptionalSipPhone } from "../hooks/useSipPhone";
import { apiGet, hasBrowserAuthToken } from "../services/apiClient";

const POP_KEY = "sm-order-pop";
const TWIN_FEATURES = "width=420,height=720,resizable=yes,scrollbars=yes";

function isMiniWindow(pathname: string | null): boolean {
  return Boolean(pathname && pathname.startsWith("/desktop"));
}

export function SupermarketOrderPop() {
  const phone = useOptionalSipPhone();
  const pathname = usePathname();
  const router = useRouter();
  const [mode, setMode] = useState<"unknown" | "classic" | "supermarket">("unknown");
  const prevState = useRef<string | null>(null);
  const firedForCall = useRef<string | null>(null);

  // One mode probe per session; classic tenants make this component inert.
  useEffect(() => {
    if (!hasBrowserAuthToken()) return;
    let dead = false;
    apiGet<{ mode: string }>("/supermarket/mode")
      .then((res) => {
        if (!dead) setMode(res.mode === "supermarket" ? "supermarket" : "classic");
      })
      .catch(() => {
        if (!dead) setMode("classic");
      });
    return () => {
      dead = true;
    };
  }, []);

  // Cross-window listener: a full window follows a pop broadcast.
  useEffect(() => {
    if (mode !== "supermarket") return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== POP_KEY || !e.newValue) return;
      if (isMiniWindow(pathname)) return; // only full windows follow
      try {
        const payload = JSON.parse(e.newValue) as { phone?: string; ts?: number };
        if (!payload?.ts || Date.now() - payload.ts > 15_000) return;
        router.push(`/orders/new?phone=${encodeURIComponent(payload.phone ?? "")}&fromCall=1`);
      } catch {
        /* malformed broadcast — ignore */
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [mode, pathname, router]);

  const callState = phone?.callState ?? null;
  const callDirection = phone?.callDirection ?? null;
  const remoteNumber = phone?.remotePartyNumber ?? phone?.remoteParty ?? "";

  useEffect(() => {
    const prev = prevState.current;
    prevState.current = callState;
    if (mode !== "supermarket") return;
    if (!(prev === "ringing" && callState === "connected" && callDirection === "inbound")) return;
    const callKey = `${remoteNumber}:${Math.floor(Date.now() / 60_000)}`;
    if (firedForCall.current === callKey) return; // once per answered call
    firedForCall.current = callKey;

    const digits = String(remoteNumber ?? "").replace(/\D/g, "");
    try {
      localStorage.setItem(POP_KEY, JSON.stringify({ phone: digits, ts: Date.now() }));
    } catch {
      /* private mode — the direct open below still runs */
    }
    if (isMiniWindow(pathname)) {
      // The mini dialer pops its TWIN — a second little window, same size.
      try {
        window.open(`/orders/twin?phone=${encodeURIComponent(digits)}`, "sm-order-twin", TWIN_FEATURES);
      } catch {
        /* popup refused — the storage broadcast already reached a full window */
      }
    } else {
      router.push(`/orders/new?phone=${encodeURIComponent(digits)}&fromCall=1`);
    }
  }, [callState, callDirection, remoteNumber, mode, pathname, router]);

  return null;
}
