# ⛔ AGENT HANDOFF — "I have to reload a few times for it to register" (2026-08-20) — READ FIRST for ANY "softphone doesn't register on first load", before touching the init retry ladders in useSipPhone.ts, or before raising the credential-endpoint rate limits

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_SOFTPHONE_FIRST_LOAD_REGISTER_2026-08-20.md`**
(`a70dc721` + `b409bfc8` on `feat/ivr-migration-takeover`, portal-only — deploy state in the handoff §7.)

- ⛔⛔ **THE PRIMARY MECHANISM (`b409bfc8`): SIGNING IN NEVER STARTED THE PHONE
  ENGINE AT ALL.** The login page's success path is `router.replace` — a
  client-side navigation with **no page reload** (`window.location.assign` there is
  only a 400 ms embedded-browser fallback) — so the SIP provider that mounted on
  the signed-out login screen never remounted, and `init()`'s
  `if (!hasBrowserAuthToken()) return` was final: engine, outbound-routes and
  extra-accounts fetches all dead until a manual reload. Proven live 03:52 CEST:
  a real sign-in loaded the whole dashboard with ZERO credential fetches and no
  telephony WS. ✅ Fixed with `authTokenPresent` (storage event + 2 s localStorage
  poll, zero network) keying all three token-gated effects — the engine now boots
  the moment the token lands, and tears down if it is cleared. ⛔ Any NEW
  token-gated effect in this hook must key on `authTokenPresent` too, or it
  reintroduces "works only after a reload".
- ⛔⛔ **THE SECOND MECHANISM (`a70dc721`): a setup-class failure retried like a transient one, and the
  retry loop ate the account's own credential budget.** `useSipPhone.ts` retried
  EVERY init failure at a fixed 60 s — including `PBX_NOT_LINKED` /
  `EXTENSION_NOT_ASSIGNED` / config gaps, which the client can never fix. One such
  loop = 60 req/h = the ENTIRE per-user `/voice/me/extension` budget (60/h,
  `ext-fetch:<user.sub>`); every extra signed-in window doubles it. Once saturated,
  **a fresh page load on an account that COULD register draws 429 on its first
  fetch**, waits 60 s, and the human reloads — a lottery. Measured live: fleet-wide
  1,467×400 + 215×429 on that endpoint in one day, and a fully-provisioned Gesheft
  user (several installs, one login) drew ~24 429s in 6 minutes.
- ✅ **Fix (`a70dc721`)**: setup-class failures (ApiError 400/403/404, WebRTC config
  gaps, missing SIP password) recheck on their own slow ladder — 60 s doubling to a
  **15-min cap** — with **±15% jitter** on every retry; transients (network, 401
  race) keep the fast ladder, 429 keeps its 60 s floor. 6 source guards in
  `lib/sipInitBackoff.test.ts` (registered), all failing against the pre-change file.
  ⛔ Do NOT fix any recurrence by raising the server-side limits (2026-08-10 rule).
- ⛔⛔ **AND THE OTHER HALF IS AN ACCOUNT FACT, NOT A BUG: Izzy's SUPER_ADMIN login
  (izzywgg@gmail.com) structurally CANNOT register** — its tenant
  `connect-admin-tenant-v1` has **no PBX link** and the user has **no extension**,
  so on that login no number of reloads ever helps; his phone identity is the
  separate Landau Home login (izzwgg@gmail.com → T21). Giving the admin login a
  phone is Izzy's decision, deliberately not made for him. **Check WHICH account a
  "won't register" window is signed into before touching code.**
- ⛔ An already-open desktop window keeps the OLD bundle (old 60 s loops) until the
  app is fully closed and reopened — judge the fix only by windows opened after the
  deploy. ⏳ NOT PROVEN: nobody has watched a first load register since the deploy;
  acceptance is one Landau-Home sign-in reading Registered with no reload.
