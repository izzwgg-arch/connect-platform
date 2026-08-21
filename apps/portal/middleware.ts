import { NextResponse } from "next/server";
import { TURNSTILE_ORIGIN, TURNSTILE_SCRIPT_SRC } from "./lib/turnstileScript";

/**
 * Sends `Link:` resource hints for the sign-in page so Cloudflare's Turnstile
 * script is fetched in PARALLEL with the page bundle instead of after it.
 *
 * ⛔ WHY A HEADER AND NOT JSX — this was tried the other way first and the
 * mistake is worth keeping. Rendering `<link rel="preconnect">` from a server
 * layout LOOKS right and does almost nothing here: because /login bails to
 * client-side rendering, React serialises those elements into the RSC flight
 * payload (`["$","link",null,{"rel":"preconnect",...}]`) rather than emitting
 * real tags, so the browser's preload scanner never sees them and the links are
 * only created during hydration — by which time the bundle has already loaded
 * and we have saved nothing. Verified by curling /login and finding the hints
 * inside a `self.__next_f.push` string instead of in the `<link>` tags.
 *
 * A `Link:` response header has no such problem: it is acted on before a single
 * byte of HTML is parsed, which is the earliest moment that exists.
 *
 * ⛔ WHY THIS MATTERS AT ALL: /login ships NO markup — the served HTML is a ~5 KB
 * shell with zero login elements — so without a hint the whole chain is serial:
 * shell → bundle → React boots → form renders → effect fires → only THEN DNS,
 * TLS and the script download → parse → render() → the challenge's own round
 * trips. The widget could not appear until all of that finished and the
 * challenge only STARTED at the end of it. That is why it looked late and then
 * sat spinning.
 *
 * ⛔ Scoped to /login by the matcher. A hint on every page would open a
 * Cloudflare connection for the overwhelming majority of requests, which are
 * from signed-in users who will never see a login form.
 *
 * ⛔ No `crossorigin` on either hint: the widget appends a plain `<script src>`
 * with no crossorigin attribute, and a CORS-mode hint does not match that
 * request — it would open a SECOND connection and warm the wrong one.
 *
 * ⛔ This removes OUR delay from in front of the challenge. How long
 * Cloudflare's verification takes afterwards is theirs, not ours.
 *
 * Deliberately the smallest possible middleware: it passes the request straight
 * through and adds one header. Anything more here runs in front of the sign-in
 * page, where a fault means nobody can log in.
 */
export function middleware() {
  const res = NextResponse.next();
  res.headers.set(
    "Link",
    `<${TURNSTILE_ORIGIN}>; rel=preconnect, <${TURNSTILE_SCRIPT_SRC}>; rel=preload; as=script`,
  );
  return res;
}

export const config = { matcher: ["/login"] };
