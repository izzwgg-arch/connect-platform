# ⛔⛔ AGENT HANDOFF — the Cloudflare bot check is ON the login page and now ARMED in OBSERVE mode; the site key had never had a path into the build (2026-08-21) — READ FIRST before touching `TURNSTILE_*`, before adding ANY `NEXT_PUBLIC_*` build arg, before flipping `TURNSTILE_ENFORCE=1`, or for "is there a robot check before the login page?"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_SECURITY_AUDIT_2026-08-16.md` §14**
(`b6ea3ff4` on `feat/ivr-migration-takeover`. **api DEPLOYED and
container-verified; one env edit to `.env.platform` (backup
`.bak.20260821T112630Z.turnstile`); one Turnstile widget created at Cloudflare.**
No migration, no PBX write, no DNS change, no proxy toggle, no tenant row.)
Izzy, 2026-08-21: *"Do we have the Cloudflare check for robots and stuff before
getting to the login page, or on the login page?"* then *"Do one, two, and three."*

- ⛔ **THE ANSWER, for every future asking: it is ON the login page** — a widget
  inside the sign-in card, verified server-side in `POST /auth/login` **after the
  throttle and before any DB read**. There is **no gate in front of the page**;
  that would be the Cloudflare edge, and `app.` is still **DNS-only**, so every
  staged WAF/bot rule remains inert. Two different controls — do not conflate them.
- ⛔⛔ **THE FINDING, and it is the reusable one: the site key had NO WAY TO REACH
  THE BUILD, so the widget had rendered NOTHING in every portal build ever made.**
  `NEXT_PUBLIC_TURNSTILE_SITE_KEY` appeared in **neither `apps/portal/Dockerfile`
  (no `ARG`, absent from the build `RUN` env) nor either compose build-args
  block**, while `TurnstileWidget` returns `null` on an empty key by design.
  **Setting the secret alone would have produced an observe log reading
  `observed_missing` forever, indistinguishable from "no bots are trying."**
  ⛔ **A `NEXT_PUBLIC_*` variable is a BUILD ARG, not runtime env** — putting it in
  `environment:` changes nothing, because Next inlines it at build time.
- ⛔ **Wired into BOTH `portal` AND `portal_candidate`** (the blue/green pair):
  wiring one tests perfectly and loses the value at the next cutover — the CRM
  storage-dir trap, third occurrence in this repo.
- ⛔ **The site key is a LITERAL DEFAULT, never a bare `${VAR:-}`, on purpose.**
  `deploy-direct.sh` sources only `.env.deploy-queue`, so an unset variable
  resolves to empty and silently bakes an **unkeyed** portal — the exact mechanism
  that left `CDR_INGEST_SECRET` blank for the platform's life. The key is public
  (it ships in the bundle to every visitor), so a literal costs nothing.
  **Site key `0x4AAAAAAEXikCDGv1Pl_SuX`; it lives in git in two places
  (Dockerfile + compose) and `turnstileWiring.test.ts` fails if they drift.**
- ⛔⛔ **THE SECRET IS THE OPPOSITE: `.env.platform` only, and it must NEVER become
  a `NEXT_PUBLIC_*` anything** — that would inline it into the bundle. A guard test
  asserts no Turnstile secret reaches any portal build input. Live secret is 35
  chars, `600 root:root`, fingerprint `sha256[0:12] = 9b0141c4e114`.
- ⛔⛔ **IN OBSERVE MODE A WRONG SECRET IS INVISIBLE — it logs `observed_invalid`
  and ALLOWS, exactly like a healthy day.** So prove the secret BEFORE relying on
  it, by asking Cloudflare to refuse it: `POST
  challenges.cloudflare.com/turnstile/v0/siteverify` with a dummy token answers
  **`invalid-input-secret`** for a wrong key and **`invalid-input-response`** for a
  right one. Run it **from inside `app-api-1`**, because the same call also proves
  the container's egress to Cloudflare — without which observe would log
  `observed_unavailable` forever. House rule in another costume: *let the provider
  refuse, then read WHICH refusal.*
- ⛔ **`loopcom.net` IS NOT A CLOUDFLARE ZONE AND THAT DOES NOT MATTER HERE.** Its
  DNS is at **Squarespace** by Izzy's own 2026-08-19 decision (*"I have other plans
  for loopcom.net"*), so there is **one** zone, not two — stop looking for a second
  one. Turnstile hostnames are just a list: Cloudflare offered *"Add
  app.loopcom.net as a custom hostname"* and took it. Its own screen says
  *"Turnstile can be embedded into any website without sending traffic through
  Cloudflare."* Widget **"Loopcom portal sign-in"**, account
  `c52b8cceadcd2b113e74350b72365765`, mode **Managed**, pre-clearance **off**
  (it only works on proxied sites anyway), both `app.` hostnames, 2 of 10.
- ✅ **PROVEN LIVE, not by unit test:** the secret is in the running container with
  `TURNSTILE_ENFORCE` empty (= observe); a browser-shaped login
  (`Origin: https://app.connectcomunications.com`, no token) answered the ordinary
  **`401 invalid_credentials`** and logged
  `{"note":"observed_missing","msg":"turnstile_observed"}` — **the gate executing
  and deliberately allowing**; `/api/health` 200 on both hostnames.
  Tests: 7 in `apps/portal/lib/turnstileWiring.test.ts` (registered), **all 4
  wiring assertions fail replayed against `HEAD`**; portal typecheck 0, suite
  250/252 (the two documented pre-existing failures).
- ⛔ **Deploy order api → portal** (either is safe; api-first only avoids a window
  where the verifier exists and no widget does). ⛔ The portal deploy queued behind
  another session's heavy build — `HEAVY JOB ALREADY RUNNING` is a lock collision,
  **not broken code**; wait on `ps -eo cmd | grep -c "[r]un-heavy.sh"` reaching 0.
- ✅✅ **THE WIDGET RENDERS AND PASSES ON BOTH HOSTNAMES — verified in a real
  browser 2026-08-21, not inferred.** The Cloudflare box draws between Password and
  Sign in, the Managed challenge completes on its own, and `cf-turnstile-response`
  holds a real **773-character token** on `app.loopcom.net` **and**
  `app.connectcomunications.com`. That single check proves the CSP allows
  `challenges.cloudflare.com`, the script loads, the baked site key is valid, and
  **both** hostname registrations work — including the one whose domain is not a
  Cloudflare zone. ⛔ Judge this in a REAL browser: `/login` renders client-side, so
  `curl | grep` returns a cached 4.8 KB shell and proves nothing either way.
- ⏳ **STILL NOT PROVEN: no human has completed a real sign-in through it**, so the
  api has only ever logged `observed_missing` (from the token-less probe) and never
  `note:"verified"`. **That flips on the next real sign-in — the one-line
  acceptance check is `docker logs app-api-1 | grep turnstile_observed | tail -1`
  reading `verified`.** ⛔ An already-open portal tab or desktop window keeps the
  OLD bundle until reloaded — the desktop app needs a full close and reopen.
- ⏳ **ENFORCE IS NOT ON AND MUST NOT BE FLIPPED YET.** `TURNSTILE_ENFORCE=1` is an
  env edit + api restart (no rebuild). ⛔ **Every `observed_missing` you see today
  becomes a REFUSED LOGIN the moment you enforce** — wait until real browser logins
  read `verified`, and re-confirm the mobile app (which sends no `Origin`) is still
  never challenged. ⚠️ Known and accepted: Turnstile is bypassed by simply omitting
  `Origin`, so it defends against **browser-driven** credential stuffing only; the
  defence against scripted attacks is the login throttle plus the 480/min global
  rate limiter. Do NOT "fix" it by challenging Origin-less callers.
- ⛔⛔ **THE WIDGET WAS DOING ITS NETWORK WORK LAST, AND THE FIX IS A `Link:`
  HEADER, NOT JSX (2026-08-21, `8a256c9a`).** Izzy: *"it shows up a little bit
  lazy and it freezes a little bit"* — *"the Cloudflare thing was lazy to show
  up, and then the spinner was kind of freezing for a while."* Both symptoms,
  one cause: **`/login` ships NO markup** (the served HTML is a ~5 KB shell with
  zero login elements — the page is a client component that is not
  server-rendered), so the whole chain was serial — shell → bundle → React boots
  → form renders → `useEffect` fires → **only THEN** DNS, TLS and the download to
  `challenges.cloudflare.com` → parse → `render()` → the challenge's own round
  trips. The widget could not appear until all of that finished, and the
  challenge only **started** at the end of it.
- ⛔⛔ **THE TRAP, and it cost a whole deploy: RENDERING `<link rel="preconnect">`
  FROM A SERVER LAYOUT LOOKS RIGHT AND DOES ALMOST NOTHING HERE.** Because
  `/login` bails to client-side rendering, React **serialises those elements into
  the RSC flight payload** (`["$","link",null,{"rel":"preconnect",…}]`) instead of
  emitting real tags — so the browser's preload scanner never sees them and the
  links only become DOM nodes **during hydration**, by which time the bundle has
  already loaded and nothing is saved. ⛔ **Found only by curling the DEPLOYED
  HTML** and noticing the hints sat inside a `self.__next_f.push` string while the
  real `<link>` tags were just the stylesheet and Next's own webpack preload.
  **Judge a resource hint by `curl -sI` / the `<link>` tags in the served HTML,
  never by the fact that you rendered one.**
- ✅ **What works: a `Link:` response header from `apps/portal/middleware.ts`**,
  matcher pinned to `["/login"]` — acted on **before a single byte of HTML is
  parsed**, the earliest moment there is. ⛔ Scoped on purpose: a hint on every
  page opens a Cloudflare connection for the overwhelming majority of requests,
  which come from signed-in users who will never see a login form. ⛔ **No
  `crossorigin` on either hint** — the widget appends a plain `<script src>`, and
  a CORS-mode hint does not match that request, so it would open a SECOND
  connection and warm the wrong one. ⛔ The header and the script URL come from
  **`lib/turnstileScript.ts`** because they must be **byte-identical** or the
  browser fetches twice and logs *"preloaded but not used"*; it is a full literal,
  not a template, because this repo verifies bundles by **grepping for strings**.
- ⛔ **The middleware is deliberately trivial — `NextResponse.next()` plus one
  header — and a guard test forbids redirects, rewrites, cookies or fetches in
  it.** It runs in front of the sign-in page: a fault there means nobody can log
  in. `app/login/layout.tsx` is **deleted** so there is exactly one mechanism, and
  a test fails if a login layout ever returns.
- ✅ **PROVEN, and the throttled tab made the proof CLEANER, not worse.** In a
  hidden (background-throttled) tab where React hydration is deferred to ~33 s,
  the Turnstile script request now starts at **818 ms**; on the previous build, in
  the identical hidden-tab conditions, it started at **33,473 ms** — i.e. it used
  to wait for React and now does not wait for it at all. Token still mints (752
  chars). Header verified live on **both** hostnames and **absent** from `/` (0
  hits), so the scoping works. ⛔ **A hidden tab is useless for absolute timings**
  (Chrome throttles it) **but is a good isolator for "does this still depend on
  React?"**.
- ⚠️ **What this does NOT fix, stated plainly: how long Cloudflare's challenge
  itself takes.** This removes OUR delay from in front of it; the round trips
  after `render()` are theirs. If the spinner is still slow on a filtered office
  line, the remaining lever is the widget MODE (Managed → non-interactive or
  invisible, a Cloudflare dashboard setting), not our code.
