/**
 * The user agent the desktop app sends.
 *
 * ⛔ THE APP MUST NEVER ANNOUNCE ITSELF AS ELECTRON. Izzy, 2026-08-21: "I do not
 * want to see any mention of electron ever." Electron's default user agent is
 *
 *   Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like
 *   Gecko) Connect/0.1.6 Chrome/<v> Electron/<v> Safari/537.36
 *
 * and it goes out on every request the app makes, so it lands in our own nginx
 * access logs and in the logs of any third-party site the app ever loads.
 *
 * Its own module, importing nothing from electron, so the transform can be
 * unit-tested without booting the app.
 */

/**
 * ⛔ TRANSFORMED, NEVER HARDCODED. The `Chrome/<version>` token has to stay
 * truthful: sites — and our own portal — feature-detect off it, and pinning a
 * stale Chrome version would slowly break things as Electron is upgraded. Only
 * the Electron token is removed and the product token renamed.
 *
 * ⛔ THE PRODUCT TOKEN IS LOAD-BEARING, so it is REPLACED rather than dropped.
 * The desktop fleet is identified in nginx access logs by this token — that is
 * how the install census and the per-machine triage in the softphone-lockout and
 * mini-dialer handoffs work, and dropping it would make desktop traffic
 * indistinguishable from an ordinary browser. Installs up to 0.1.6 say
 * `Connect/0.1.6 … Electron/41.x`; from 0.1.7 they say `Loopcom/0.1.7` with no
 * Electron token — which incidentally makes the two generations trivial to tell
 * apart in a log.
 */
export function brandedUserAgent(defaultUa: string, version: string): string {
  return defaultUa
    .replace(/\s*Electron\/\S+/i, "")
    .replace(/\s*(?:@connect\/desktop|Connect|Loopcom)\/\S+/i, "")
    .replace(/\(KHTML, like Gecko\)/, `(KHTML, like Gecko) Loopcom/${version}`)
    .replace(/\s{2,}/g, " ")
    .trim();
}
