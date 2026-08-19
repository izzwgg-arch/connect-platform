/**
 * Cloudflare Turnstile on the sign-in form — the "check that you're a person"
 * Izzy asked for on the login page (2026-08-19).
 *
 * WHAT IT PROTECTS, HONESTLY: the BROWSER path to /auth/login. Turnstile is a
 * widget the portal renders and a token the browser sends; a bot driving the
 * page must solve it. It does NOT protect a raw `curl -X POST /api/auth/login`
 * from a script — the mobile app is exactly such a caller and must keep
 * working — so a script that omits the browser headers is not challenged. That
 * path is covered by `loginThrottle.ts` (per-account + per-source) and the
 * global rate limiter. The two together are the whole picture; neither alone.
 *
 * WHEN IT IS REQUIRED: only when ALL of
 *   1. TURNSTILE_SECRET_KEY is set (else the feature is off — nothing changes);
 *   2. the request carries an `Origin` (or `Referer`) whose host is one of OUR
 *      portal hosts (`PLATFORM_PORTAL_HOSTS`) — i.e. it came from the portal
 *      running in a browser. The mobile app sends no Origin. A forged Origin
 *      buys an attacker nothing but a harder path;
 *   3. TURNSTILE_ENFORCE=1. Without it, a token is VERIFIED WHEN PRESENT and its
 *      absence is only logged — the safe roll-out shape, because an already-open
 *      portal tab keeps its OLD bundle (no widget) until reloaded, and enforcing
 *      on the same deploy that ships the widget locks every open tab out.
 *      Roll-out: deploy → set the keys → watch `turnstile_missing` in the log
 *      fall to zero → set TURNSTILE_ENFORCE=1.
 *
 * ⛔ The secret key is verified server-side against Cloudflare's siteverify; the
 * SITE key is public and lives in the portal build (NEXT_PUBLIC_TURNSTILE_SITE_KEY).
 * ⛔ Cloudflare's siteverify is an external call: a timeout or 5xx is treated
 * as "could not verify" and, under enforce, refuses — fail closed, but with a
 * distinct code (`human_check_unavailable`) so an outage at Cloudflare reads
 * differently from a bot.
 */
import { PLATFORM_PORTAL_HOSTS } from "./publicOrigins";

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileMode = "off" | "observe" | "enforce";

export function turnstileMode(env: NodeJS.ProcessEnv = process.env): TurnstileMode {
  if (!String(env.TURNSTILE_SECRET_KEY ?? "").trim()) return "off";
  return String(env.TURNSTILE_ENFORCE ?? "").trim() === "1" ? "enforce" : "observe";
}

/** Did this request come from the portal running in a browser on one of OUR hosts? */
export function isBrowserOnPlatformHost(headers: Record<string, unknown> | undefined): boolean {
  const h = headers ?? {};
  const candidates = [h["origin"], h["referer"]].map((v) => String(v ?? "").trim()).filter(Boolean);
  for (const c of candidates) {
    try {
      const host = new URL(c).host.toLowerCase().replace(/:\d+$/, "");
      if (PLATFORM_PORTAL_HOSTS.has(host)) return true;
    } catch { /* not a URL */ }
  }
  return false;
}

export type TurnstileVerdict =
  | { ok: true }
  | { ok: false; reason: "missing" | "invalid" | "unavailable"; codes?: string[] };

export async function verifyTurnstileToken(
  token: unknown,
  remoteIp: string | null | undefined,
  secret: string = String(process.env.TURNSTILE_SECRET_KEY ?? "").trim(),
  fetchImpl: typeof fetch = fetch,
): Promise<TurnstileVerdict> {
  const t = String(token ?? "").trim();
  if (!t) return { ok: false, reason: "missing" };
  const body = new URLSearchParams({ secret, response: t });
  if (remoteIp && remoteIp !== "unknown") body.set("remoteip", remoteIp);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetchImpl(TURNSTILE_VERIFY_URL, { method: "POST", body, signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, reason: "unavailable" };
    const json = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    return json.success ? { ok: true } : { ok: false, reason: "invalid", codes: json["error-codes"] ?? [] };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export type TurnstileGateResult =
  | { action: "allow"; note?: "off" | "not_browser" | "observed_missing" | "observed_invalid" | "observed_unavailable" | "verified" }
  | { action: "refuse"; status: 400 | 503; error: "human_check_required" | "human_check_failed" | "human_check_unavailable" };

/**
 * The whole decision for one login request. Pure apart from the verify call,
 * which is injected. `allow` always carries a note so the log can say WHY.
 */
export async function turnstileGate(input: {
  headers: Record<string, unknown> | undefined;
  token: unknown;
  remoteIp: string | null | undefined;
  mode?: TurnstileMode;
  verify?: (token: unknown, remoteIp: string | null | undefined) => Promise<TurnstileVerdict>;
}): Promise<TurnstileGateResult> {
  const mode = input.mode ?? turnstileMode();
  if (mode === "off") return { action: "allow", note: "off" };
  if (!isBrowserOnPlatformHost(input.headers)) return { action: "allow", note: "not_browser" };
  const verify = input.verify ?? ((t, ip) => verifyTurnstileToken(t, ip));
  const verdict = await verify(input.token, input.remoteIp);
  if (verdict.ok) return { action: "allow", note: "verified" };
  if (mode === "observe") {
    return { action: "allow", note: verdict.reason === "missing" ? "observed_missing" : verdict.reason === "invalid" ? "observed_invalid" : "observed_unavailable" };
  }
  if (verdict.reason === "missing") return { action: "refuse", status: 400, error: "human_check_required" };
  if (verdict.reason === "invalid") return { action: "refuse", status: 400, error: "human_check_failed" };
  return { action: "refuse", status: 503, error: "human_check_unavailable" };
}
