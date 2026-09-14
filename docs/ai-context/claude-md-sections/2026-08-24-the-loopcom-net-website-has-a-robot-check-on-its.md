# ⛔⛔ AGENT HANDOFF — the loopcom.net WEBSITE has a robot check on its forms, and Cloudflare is CONFIGURED BUT NOT ACTIVATED because the domain is DNSSEC-signed (2026-08-24) — READ FIRST before changing ANY nameserver, before touching `website/server/turnstile.mjs`, before adding a form to the website, or for "the Cloudflare settings aren't doing anything"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Cutover state + the full mirror table:
**`website/deploy/dns-backup/cloudflare-cutover-state-20260824.md`**
(`2c0b2d2c` the robot check + `454f2fa1` the docs, on `feat/ivr-migration-takeover`.
✅ **Website DEPLOYED to 31.220.77.60 and PROVEN END TO END.** Cloudflare zone
created and fully configured — ⛔ **inert, the nameservers have NOT been moved.**
No Connect server, no PBX, no api, no portal touched.)
Memory: [[dnssec-blocks-a-nameserver-move]].

- ⛔⛔ **THE BLOCKER, AND IT IS ONE CLICK FROM A COMPANY-WIDE OUTAGE: loopcom.net
  IS DNSSEC-SIGNED.** `dig +short DS loopcom.net @a.gtld-servers.net` returns a
  live DS with an **86400 s (24 h) TTL**, and `+dnssec` queries to **1.1.1.1,
  8.8.8.8 AND 9.9.9.9 all return the `ad` flag** — three major resolvers are
  validating this domain right now. Moving the nameservers while that DS is
  published is **SERVFAIL everywhere**, and the blast radius is far wider than
  the marketing site: **the Google Workspace MX for the whole company**, plus
  **`app.loopcom.net` and `sip.loopcom.net`**, which is Connect's production
  SIP-over-443 route. **The move is TWO stages with a mandatory ≥24 h wait**:
  disable DNSSEC at Squarespace → wait for the DS TTL (confirm the DS query is
  EMPTY *and* the `ad` flag is gone) → change the nameservers → re-enable DNSSEC
  at Cloudflare. **Steps 1 and 3 in one sitting is the outage.**
  ⛔ **THE GENERAL RULE: ask the REGISTRY for the DS record before any nameserver
  change.** A signed domain looks completely ordinary on the registrar's
  nameserver page — Squarespace's shows four nameservers and says nothing about
  DNSSEC; the toggle is a separate sidebar item one click away. The DS query is
  the only honest check.
- ✅ **THE ROBOT CHECK IS LIVE AND PROVEN — and it does NOT need the zone
  proxied** (Cloudflare's own words: *"Turnstile can be embedded into any website
  without sending traffic through Cloudflare"*). Widget "Loopcom website forms",
  site key `0x4AAAAAAEamM79uqjq_a-aY` (public, in `website/src/site.mjs`); the
  secret is root-only in `/etc/loopcom/website.env` on 31.220.77.60.
- ⛔⛔ **THE CHECK ARMS ITSELF ONLY WHEN A SECRET IS PRESENT.** No secret → the
  widget does not render and the server does not verify, and the site behaves
  exactly as it did before. **A half-configured Turnstile that refuses every
  visitor is worse than no Turnstile at all.**
- ⛔⛔ **THE TWO FAILURE DIRECTIONS ARE DELIBERATELY OPPOSITE.** Token missing or
  forged → **REFUSE**. Cloudflare unreachable → **ACCEPT**, and stamp the email
  so the operator can see the check did not run. A bot getting through costs one
  junk email; a lost lead costs a sale and we never learn it happened.
  ⛔ `invalid-input-secret` is treated as an OUTAGE, not as a bot — a wrong
  secret of OURS must never turn a real customer away.
- ⛔⛔ **A WRONG SECRET THEREFORE FAILS OPEN AND IS INVISIBLE. Prove the secret is
  RIGHT by differential refusal**: POST a dummy token to
  `challenges.cloudflare.com/turnstile/v0/siteverify` — the real secret answers
  **`invalid-input-response`**, a wrong one answers **`invalid-input-secret`**.
  Run it from the server, so the same call also proves egress. Done, with a
  deliberately-wrong control alongside it.
- ⛔ **Verified AFTER field validation, never before.** A Turnstile token is
  **single-use**, so verifying first burns it on an honest typo and makes the
  corrected resubmission fail for a reason that has nothing to do with what the
  visitor changed. The browser also calls `turnstile.reset()` after **every**
  refusal, scoped to that form's own widget, or the second attempt at any form
  always fails.
- ⛔ **CSP needs THREE directives and `frame-src` is the one people forget** — the
  widget renders in an iframe, so with `default-src 'self'` and no explicit
  `frame-src` the check silently never appears while the form still fails
  server-side with nothing on screen explaining why.
- ⛔⛔ **DRIVING THE LIVE ENDPOINTS FOUND TWO DEFECTS, NEITHER VISIBLE IN CODE NOR
  CATCHABLE BY A UNIT TEST.** **(1) Six validation failures locked a visitor out
  for an hour** — refusals were counted against the same budget as accepted
  submissions, and fumbling a form is the most human thing there is. Split into a
  loose **attempt** budget (40/hr, stops spraying) and a tight **accepted** budget
  (6/hr, protects the inbox). Proven by driving 12 consecutive validation
  failures: all now answer 400 and the 13th well-formed attempt still reaches the
  robot check, where the old code 429'd at 7. **(2) A refusal rendered as a
  run-on telling the visitor to call us twice**, because the client pasted its own
  contact tail onto the server's message; the tail is now added only when the
  wording is ours, and the message moved from `innerHTML` to `textContent` —
  server-sourced text built into markup is an XSS sink waiting for the first
  refusal that quotes something the visitor typed.
- ⛔ **A JSON body parses as an EMPTY FORM.** `parseForm` accepts only urlencoded
  and multipart, so a JSON probe silently exercises the empty-form path and proves
  nothing about the thing you meant to test — every field comes back blank and the
  refusal looks convincing. **Probe these endpoints with `--data-urlencode`.**
- ⛔ **THERE ARE TWO RATE LIMITERS AND THE TIGHT ONE IS nginx.** The origin is
  `rate=12r/m burst=5` on `/api/`, so a scripted probe 429s at ~7 carrying
  nginx's own JSON message; the Cloudflare edge rule is deliberately ~15× looser
  (30 req / 10 s) and only sheds genuine floods. **Test the app layer against
  `127.0.0.1:8080` on the box to see past nginx.**
- ✅ **Proven end to end, not by unit test:** a real browser rendered the widget,
  minted a **752-character token** and logged **zero CSP violations**, and a real
  submission landed with **`humanCheck: "verified"`** and redirected to
  `/quote/thank-you/`. No token → 403; forged token → 403 with
  `invalid-input-response` in the audit log; bad email → 400 validation first;
  nothing persisted on any refusal.
- ⛔ **`cf-turnstile-response` travels automatically** inside `new FormData(form)`
  — do not also append it by hand, or the server sees two values.
- ⛔ **The site's leads survive a mail failure by design.** The end-to-end test
  submission stored with `delivery: "not_configured"` because ⏳ **SMTP is still
  not configured — Izzy's explicit "last thing"** — and that is the one remaining
  gap between a submitted form and an email in a human inbox.
- ⛔ **Cloudflare's DNS scan is not trustworthy, and it was caught here.** It had
  defaulted **`app` and `sip` to Proxied** — which breaks SIP WebSockets on
  Cloudflare's ~100 s idle timeout — and had **missed `turn` entirely**. All 15
  records were then verified **byte-identical by hash** against the authoritative
  Squarespace answers, including the full 2048-bit DKIM key (410 chars,
  `e025f1a7d3e5b04f` on both sides). **Re-verify the proxy flags and the record
  count after activation.**
- ⛔ **Two items genuinely CANNOT be mirrored from connectcomunications.com, and
  are recorded as such rather than claimed:** a deployable **managed ruleset** and
  **Super Bot Fight Mode** are **Pro-only**; loopcom.net is Free and gets the free
  managed ruleset applied automatically. ⛔ **Bot Fight Mode is not even offered
  while the zone is `pending` — re-check it after activation.**
- ⛔ **ONE setting is deliberately NOT mirrored:** AI crawlers stay **allowed**
  here. connectcomunications.com blocks them and should — it is an app host, where
  a crawler has no legitimate business. This is a marketing site whose entire job
  is to be found, and blocking them stops ChatGPT, Claude and Perplexity citing
  Loopcom. Mirroring the letter would have failed the intent. One toggle if Izzy
  disagrees: Security → Settings → filter "Bot traffic" → Block AI bots.
- ⛔ **A Cloudflare rule can report success in the UI and not exist.** The first
  custom-rule deploy silently did nothing — a confirmation dialog was sitting
  off-screen — and the page showed no error at all. **Verify every rule through
  `/rulesets/phases/<phase>/entrypoint`, never from the screen.** Dashboard-API
  **reads** work with the browser session; **writes are CSRF-protected** and have
  to go through the UI.
- ⏳ **NOT DONE, and each needs Izzy:** the DNSSEC disable + 24 h wait + the
  nameserver move (it means an unsigned window on a domain he has just asked to
  make 100% secure — his call, not mine); **SMTP credentials**; and ⛔ **rotating
  the Turnstile secret**, which rendered on screen during setup and so passed
  through the session transcript. Rotation: Cloudflare → Turnstile → the widget →
  rotate the secret, then on 31.220.77.60
  `sed -i "/^TURNSTILE_SECRET_KEY=/d" /etc/loopcom/website.env`, append the new
  value, `systemctl restart loopcom-web`, and re-run the differential-refusal
  check above.
- ✅✅ **THE CPNI NOTICE IS GONE FROM THE SITE (2026-08-31, Izzy's ask) — and the
  deploy recipe it forced out is worth more than the change.** `/legal/cpni/`, its
  footer link, its Legal-centre card and its `build.mjs` entry are removed; the two
  pages that linked to it (the privacy policy and `/security/`) KEEP their CPNI
  wording and lost only the dead link. Live over https: `/legal/cpni/` **404**,
  `/legal/` + `/legal/accessibility/` + `/security/` **200**, sitemap **22 urls, 0
  cpni**, `loopcom-web` `active` with **0 restarts**. ⚠️ **Stated, not acted on:
  CPNI is an FCC duty and the compliance calendar still carries its 2027-03-01
  recert — the NOTICE PAGE is gone, the OBLIGATION is not.** Rollback:
  `/root/loopcom-dist-backup-20260831T113124Z.tar.gz` on the web server.
- ⛔⛔ **THE WEBSITE HAS NO DEPLOY QUEUE AND NO DEPLOY SCRIPT — this is the whole
  recipe, and it was written down nowhere until now.** Build locally (`cd website
  && node build.mjs --check`), `tar -czf` the `dist/`, `scp` to **31.220.77.60**
  (ssh host `website`, user root, key `.connect-ssh/loopcom_web_ed25519`), extract
  to `/var/www/loopcom/dist.new`, `chown -R loopcom:loopcom`, then
  `mv dist dist.old && mv dist.new dist`. ⛔ **No restart is needed and none
  should be done** — `server.mjs` does a `readFile` PER REQUEST and serves html
  `no-cache`, so the swap is live the instant it lands. Back up first:
  `tar -czf /root/loopcom-dist-backup-$(date -u +%Y%m%dT%H%M%SZ).tar.gz -C
  /var/www/loopcom dist`.
- ⛔⛔ **DIFF THE BUILT TREE AGAINST THE LIVE ONE BEFORE ANY SWAP — it caught a file
  that existed ONLY on the server.** `comm -23` over `find . -type f | sort` from
  both sides showed a live root **`/favicon.ico`** (692 b, hand-copied 2026-08-24)
  that the build had NEVER emitted — while every page links it — so a straight swap
  would have silently deleted the site’s favicon and nothing would have failed.
  Fixed at the source (`website/public/favicon.ico`, byte-identical to
  `assets/img/favicon.ico`), after which the ONLY difference was the CPNI page.
  **Never swap a web root you have not diffed.**
- ⛔ `website/dist/` is **gitignored**, so the built tree exists only locally and on
  the server — “it is in git” is never proof of what the site is serving. And the
  build’s own `--check` verifies internal links, so removing a page it links from
  fails the build rather than shipping a dead link.
