# ⛔ AGENT HANDOFF — ElevenLabs "the key isn't accepted" (2026-08-06) — READ FIRST for ElevenLabs, the `/elevenlabs` page, "Make a recording" failures, or ANY "the provider says no" report

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_ELEVENLABS_KEY_BILLING_2026-08-06.md`**
(commits `d9cf83c6` + `57f09865` + `ef557f50`, **all DEPLOYED and
container-verified** — api + portal + a manual agent rebuild; merged and pushed
as `42a62b2d`, branch `feat/ivr-migration-takeover`).

- ⛔ **THE RULE: let the provider refuse. Never pre-judge from a soft field.**
  Connect told a paid-up owner with $100+ of credit that he had an unpaid
  ElevenLabs bill and refused to generate anything — while a real synthesis
  request to that same account returned **200 with 8,916 bytes of audio**. We
  were the ones saying no, and we blamed the supplier while doing it. Before
  believing our own badge, **call the provider** (probe recipe in the handoff §6).
- **Three causes stacked in one night** — do not assume a single one: (1) the
  stored key was ElevenLabs' **retired 64-hex format**, refused server-side with
  **HTTP 400** `invalid_api_key_prefix` "must start with 'sk_'" (only a NEW `sk_`
  key fixes it — it *was* re-pasted and could never work); (2) a genuinely
  **`past_due`** account, which really does block (`/voices` + `/user/subscription`
  both 200 while synthesis is refused **401 `payment_issue`**); (3) ⛔ **our own
  bug** — we treated **`has_open_invoices: true` as arrears**, and it is not: it
  counts the NEXT invoice, so it is true on a healthy account most of every month.
  **Only `past_due` blocks now.**
- ⛔ **A customer must never see our supplier's billing state.** A tenant customer
  was told to "settle the bill at elevenlabs.io". Every failure now carries TWO
  messages — `userMessage` (staff: names the provider and our account) and
  `customerMessage` (no supplier, no invoice, no key, and points at upload /
  reuse). Chosen by role in `elevenLabsRoutes.ts` (`isConnectStaff` → SUPER_ADMIN)
  across status/voices/preview/generate **and the no-key 503**. Hiding the cause
  is only safe because an `ourProblem` failure queues one deduped ADMIN_ALERT per
  hour. **Izzy is SUPER_ADMIN so he still sees the real reason — that is
  deliberate, not a failed fix; verify with a tenant-admin account.**
- **The rules live once**, in `packages/shared/src/elevenLabsKeyFormat.ts` —
  the API (Studio modal) and the agent (settings page) had been describing the
  same failure two different ways ("couldn't be reached" vs "key rejected"),
  which is exactly what made a supplier problem read as Connect's fault. Any
  **4xx** is the key; only **5xx** is them. The `invalid_api_key_prefix` branch
  must stay **before** the generic `invalid_api_key` one — the specific code
  contains the generic string, and the useful sentence gets swallowed otherwise.
- ⛔ **Import it from `@connect/shared` (root), NOT the subpath.** `apps/api` and
  `apps/agent` typecheck under a `moduleResolution` that cannot resolve
  `@connect/shared/elevenLabsKeyFormat`; the subpath works in the **portal** only.
- **Never retry a synthesis POST** (double-bills characters), and the 16 kHz
  format fallback is now skipped when the 400 was about the KEY — that retry
  buried the useful first message under a second identical failure.
- **Not yet proven:** no greeting has been generated through the UI since the fix
  (the provider path is proven by direct probe only), and the customer-facing
  wording is proven by unit test, not by opening the Studio as a tenant admin.
