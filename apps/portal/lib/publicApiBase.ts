/**
 * Where the browser should send API calls from a PUBLIC (signed-out) page.
 *
 * ⛔ Connect is served on MORE THAN ONE HOSTNAME (`app.connectcomunications.com`
 * and `app.loopcom.net`, and more are planned). Any hardcoded absolute API URL is
 * therefore a bug: on the *other* hostname the browser makes a cross-origin
 * request, the api sends no `Access-Control-Allow-Origin`, and the fetch is
 * blocked by CORS — the page simply never loads. That is a payment outage on the
 * pay pages, not a cosmetic issue.
 *
 * There are TWO different questions here and they have DIFFERENT answers. Do not
 * collapse them into one helper:
 *
 *  1. `resolveSameOriginApiBase()` — for a `fetch()` made by the page the customer
 *     is already looking at. The answer is a RELATIVE base (`/api`), which is
 *     correct on every hostname nginx serves, present and future, and involves no
 *     CORS at all.
 *
 *  2. `resolveAbsoluteApiBase()` — for a URL that leaves this browser and is
 *     consumed by ANOTHER device (today: the mobile-pairing QR code). A relative
 *     `/api` is meaningless to a phone — React Native's `fetch` requires an
 *     absolute URL — so this must stay absolute. But it is derived from the
 *     CURRENT origin at runtime, never from a hardcoded domain, so a phone paired
 *     from either hostname talks to the hostname it was paired from.
 *
 * In both cases an explicitly-set `NEXT_PUBLIC_API_URL` still wins — that is how
 * local development points the portal at `http://localhost:3001`.
 *
 * (`services/apiClient.ts` already resolves the authenticated path this way; these
 * helpers exist so the public pages, which use bare `fetch` rather than the client,
 * get the same behaviour instead of each re-deriving it.)
 */

/** The domain that used to be hardcoded. Kept ONLY as the last-resort value for
 *  an absolute URL when there is no `window` to read an origin from (server-side
 *  render). Never use it as a fetch base. */
export const LEGACY_ABSOLUTE_API_BASE = "https://app.connectcomunications.com/api";

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function readEnv(envValue: string | null | undefined): string {
  return typeof envValue === "string" ? envValue.trim() : "";
}

function isAbsolute(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * API base for `fetch()` from the current page.
 *
 * Returns `NEXT_PUBLIC_API_URL` when it is set, otherwise the same-origin
 * relative base `/api`. Safe to evaluate at module scope: it never touches
 * `window`, so it renders identically on the server and in the browser.
 */
export function resolveSameOriginApiBase(envValue?: string | null): string {
  const fromEnv = readEnv(envValue);
  if (fromEnv) return trimTrailingSlashes(fromEnv);
  return "/api";
}

/**
 * Absolute API base for a URL that will be used by a DIFFERENT device.
 *
 * @param envValue `NEXT_PUBLIC_API_URL` (wins when set; joined onto `origin` if
 *                 it is itself relative).
 * @param origin   `window.location.origin` in the browser; omit on the server.
 *
 * ⛔ The return value is always absolute. If there is no origin and no absolute
 * env value, it falls back to {@link LEGACY_ABSOLUTE_API_BASE} rather than
 * emitting a relative path a phone could not use.
 */
export function resolveAbsoluteApiBase(envValue?: string | null, origin?: string | null): string {
  const fromEnv = readEnv(envValue);
  const cleanOrigin = trimTrailingSlashes(readEnv(origin));

  if (fromEnv) {
    if (isAbsolute(fromEnv)) return trimTrailingSlashes(fromEnv);
    // A relative override (e.g. "/api") still has to become absolute here.
    const path = trimTrailingSlashes(fromEnv.startsWith("/") ? fromEnv : `/${fromEnv}`);
    if (cleanOrigin) return `${cleanOrigin}${path}`;
    return LEGACY_ABSOLUTE_API_BASE;
  }

  if (cleanOrigin) return `${cleanOrigin}/api`;
  return LEGACY_ABSOLUTE_API_BASE;
}

/** `window.location.origin` when there is a browser, otherwise null. */
export function currentBrowserOrigin(): string | null {
  if (typeof window === "undefined" || !window.location) return null;
  return window.location.origin || null;
}
