"use client";

import type { ReactNode } from "react";
import { ApiError } from "../services/apiClient";

export function BillingActionToast({ kind, text }: { kind: "ok" | "err"; text: string }) {
  return (
    <div className={`billing-toast billing-toast--${kind}`} role="status">
      {text}
    </div>
  );
}

export function billingErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.body && typeof err.body === "object") {
    const body = err.body as { error?: string; message?: string };
    const code = typeof body.error === "string" ? body.error : "";
    const msg = typeof body.message === "string" ? body.message : "";
    if (code && msg) return `${code}: ${msg}`;
    if (code) return code;
    if (msg) return msg;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export function BillingPageChrome({ children, toast }: { children: ReactNode; toast: { kind: "ok" | "err"; text: string } | null }) {
  return (
    <>
      {children}
      {toast ? <BillingActionToast kind={toast.kind} text={toast.text} /> : null}
    </>
  );
}
