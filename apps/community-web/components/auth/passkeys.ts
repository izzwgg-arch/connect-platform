"use client";

import { startAuthentication, startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { api } from "@/lib/api";

export function passkeysSupported(): boolean {
  try {
    return typeof window !== "undefined" && browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/** Register a passkey for the signed-in person. */
export async function passkeyRegister(label?: string) {
  const options = await api("/auth/passkeys/register/options", { method: "POST" });
  const response = await startRegistration({ optionsJSON: options });
  return api("/auth/passkeys/register/verify", { body: { response, label } });
}

/** Sign in with a passkey (discoverable credential when no identifier). */
export async function passkeyLogin(identifier?: string) {
  const { scope, ...options } = await api("/auth/passkeys/login/options", { body: { identifier }, auth: false });
  const response = await startAuthentication({ optionsJSON: options });
  return api("/auth/passkeys/login/verify", { body: { scope, response }, auth: false });
}
