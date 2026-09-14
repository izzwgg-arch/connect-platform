# ⛔⛔ AGENT HANDOFF — Connect is on TWO hostnames now, and that makes every hardcoded absolute API URL a DEAD PAY PAGE (2026-08-16) — READ FIRST before putting ANY url in a portal page, before "making it relative", before touching the pairing QR, and before testing a new-host bug on the old host

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: the new section in
**`docs/ai-context/PLAN_CLOUDFLARE_EDGE_SIP_SPLIT_2026-08-16.md` §4b**
(`93a85d25` on `feat/ivr-migration-takeover`. **Portal DEPLOYED, container-verified,
and verified in a REAL BROWSER ON BOTH HOSTS.** No nginx, no DNS, no Cloudflare, no
env file, no PBX — portal source only.)

- ⛔⛔ **THE RULE, and it is a CLASS not an incident: the moment Connect answers on a
  second hostname, every hardcoded absolute API URL in the portal is a live outage on
  the hostname that isn't hardcoded.** `NEXT_PUBLIC_API_URL` is **empty** in
  `app-portal-1`, so four public pages fell through to a literal
  `|| "https://app.connectcomunications.com/api"`. On `app.loopcom.net` that is a
  **cross-origin** request, the api sends no `Access-Control-Allow-Origin`, and the
  browser **blocks it**: `has been blocked by CORS policy` +
  `Uncaught (in promise) TypeError: Failed to fetch`. ⛔ **The three public PAY pages
  were dead on the new domain** — permanent loading state, customer cannot pay.
- ⛔ **It is INVISIBLE from the old host** — the identical URL there returns a clean
  404. A check run only against `app.connectcomunications.com` passes and proves
  nothing. **Test a new-host bug on the new host.**
- ⛔⛔ **THE TRAP THAT MAKES ONE BLANKET FIX WRONG — it breaks mobile pairing.** Two
  different questions, two different answers, never one helper:
  **(1) the three pay pages** (`app/p/[code]`, `app/pay/invoice/[token]`,
  `app/pay/invoices/[token]`) fetch from the page the customer is already on → a
  **same-origin RELATIVE base (`/api`)**, right on every hostname forever, no CORS.
  **(2) `components/QRPairingModal.tsx` is NOT that case** — it bakes the base into a
  **QR code scanned by a PHONE**. A relative `/api` is meaningless off-device
  (`apps/mobile/src/api/client.ts:1210` does `fetch(\`${apiBaseUrl}/…\`)` and RN
  rejects a relative URL), so it stays **ABSOLUTE — but built from
  `window.location.origin` at runtime**, so a phone paired from either host talks to
  the host it was paired from.
- **Both answers live once**, in **`apps/portal/lib/publicApiBase.ts`**
  (`resolveSameOriginApiBase` / `resolveAbsoluteApiBase` / `currentBrowserOrigin`).
  ⛔ **`NEXT_PUBLIC_API_URL` still wins when set** — only the fallback changed; do not
  remove the override, it is how local dev reaches `:3001`.
  **`services/apiClient.ts` already did this for authenticated calls** — the public
  pages use bare `fetch` and never got it. **Prefer `apiClient` on any new page.**
- ⛔ **The guard reads the CALL SITES' SOURCE, not just the helpers** — the defect was
  **four callers**, and a unit test of a resolver passes straight through it (same
  shape as `sipPublicEndpoint.test.ts`). `apps/portal/lib/publicApiBase.test.ts`,
  **14 tests**, registered in the portal `test` script; **proven real — all four
  pre-fix files fail it.** It also asserts the QR modal does NOT use the same-origin
  resolver.
- ✅ **Proven in a browser on BOTH hosts** (probe code `PROBE000`, signed out, no real
  card): `/p/` **404/404**, `/pay/invoice/` **410/410**, `/pay/invoices/` **401/401** —
  **identical on both**, every request went to `app.loopcom.net/api/...`, **zero
  requests to the other domain**, and console filtered for
  `CORS|Failed to fetch|Content Security|Refused` had **no matches on either host**.
  Container-verified too: `grep -c app.connectcomunications.com` on all three shipped
  pay-page chunks inside `app-portal-1` is **0**.
- ⏳ **NOT PROVEN: no phone has been paired from `app.loopcom.net`.** The QR half is
  proven by unit test and by reading the shipped bundle, **never by scanning a code
  with a real handset** — that is the acceptance test. ⏳ **No real payment has been
  taken on either host since the change.**
- ⏳ **Still hardcoded, deliberately out of scope, same class:**
  `components/AppDownloadCard.tsx:8` (APK link), `navigation/navConfig.ts:88` (desktop
  installer), `app/(platform)/billing/invoices/[id]/page.tsx:46` (mildest — already
  prefers `window.location.origin`). ⛔ **Sweep the class, don't fix one-offs:**
  `grep -rn "app\.connectcomunications\.com" apps/portal --include=*.ts --include=*.tsx`
  (exclude `.next`).
