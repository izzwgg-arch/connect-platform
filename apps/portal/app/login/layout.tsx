import type { ReactNode } from "react";
import { TURNSTILE_ORIGIN, TURNSTILE_SCRIPT_SRC } from "../../lib/turnstileScript";

/**
 * Exists for ONE reason: to start Cloudflare's Turnstile download before React
 * is running, so the sign-in check is not visibly late.
 *
 * ⛔ THE PROBLEM THIS SOLVES. `/login` ships **no markup at all** — the served
 * HTML is a ~4.9 KB shell with zero login elements, because the page is a client
 * component that is not server-rendered. So the browser's real chain was
 * entirely serial:
 *
 *   HTML shell → page bundle downloads → React boots → form renders →
 *   useEffect fires → *only now* DNS + TLS + download to challenges.cloudflare.com
 *   → script parses → turnstile.render() → the challenge's own round trips
 *
 * Every one of those steps had to finish before the widget could even appear,
 * and the challenge only *started* at the end of it. That is why the box showed
 * up late and then sat spinning: it was doing its network work last.
 *
 * A layout is a SERVER component, so unlike anything inside the client page,
 * whatever it renders is present in that first 4.9 KB of HTML. The browser's
 * preload scanner sees these three hints while it is still parsing, and opens
 * the connection and pulls the script **in parallel with the page's own JS**
 * instead of after it. By the time the effect runs, the script is already in
 * the memory cache, so render() is immediate and the challenge starts seconds
 * earlier on a slow or filtered connection.
 *
 * ⛔ `<link>` in the body is deliberate and correct — browsers honour
 * preconnect/dns-prefetch/preload there, and it keeps this scoped to /login
 * instead of opening a Cloudflare connection on every page of the portal for
 * users who will never see a login form.
 *
 * ⛔ These hints cost nothing but are also NOT the whole story: how long the
 * challenge itself takes afterwards is Cloudflare's, not ours. This removes our
 * delay from in front of it; it cannot make their verification faster.
 *
 * ⛔ The preload href must stay byte-identical to the script the widget appends
 * (both come from lib/turnstileScript.ts) or the browser fetches it twice and
 * logs "preloaded but not used" — pinned by lib/turnstileWiring.test.ts.
 *
 * ⛔ No `crossOrigin` on any of these: the widget appends a plain `<script src>`
 * with no crossorigin attribute, so a CORS-mode preconnect/preload would not
 * match that request and would open a SECOND connection rather than warm the
 * one that gets used.
 */
export default function LoginLayout({ children }: { children: ReactNode }) {
  // The site key is inlined at build time; with no key the widget renders
  // nothing, so hinting a script nobody will load would be pure waste.
  const hasSiteKey = Boolean((process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "").trim());
  return (
    <>
      {hasSiteKey ? (
        <>
          <link rel="dns-prefetch" href={TURNSTILE_ORIGIN} />
          <link rel="preconnect" href={TURNSTILE_ORIGIN} />
          <link rel="preload" as="script" href={TURNSTILE_SCRIPT_SRC} />
        </>
      ) : null}
      {children}
    </>
  );
}
