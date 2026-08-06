# AGENT HANDOFF — ElevenLabs "the key isn't accepted" (2026-08-06)

Branch `feat/ivr-migration-takeover`. Three commits, **all deployed and
container-verified** (api + portal + a manual agent rebuild, all at
`ef557f50`), merged with a parallel session's Studio work and pushed as
`42a62b2d`.

| Commit | What |
|---|---|
| `d9cf83c6` | Say WHY a key is refused; shared rules so api + agent can't drift; stop the pointless 16 kHz retry on an auth failure |
| `57f09865` | A customer never sees our supplier's billing state; deduped ADMIN_ALERT so we hear about it instead |
| `ef557f50` | ⛔ **The real bug**: an *open* invoice is not an *unpaid* one — stop blocking a working account |

Read this before touching `apps/api/src/voice/elevenLabs*.ts`,
`packages/shared/src/elevenLabsKeyFormat.ts`, the agent's
`/agent/voice/elevenlabs/status` route, or the `/elevenlabs` settings page.

---

## 1. ⛔ The one rule to take away

**Let the provider refuse. Never pre-judge from a soft field.**

Connect told a paid-up owner — active account, $100+ of credit — that he had an
unpaid ElevenLabs bill, and refused to generate anything. Meanwhile a real
synthesis request against that same account returned **200 with 8,916 bytes of
audio**. We were the ones saying no, and we blamed the supplier while doing it.

Corollary for diagnosis: **before believing our own badge, call the provider.**
A shape-only probe (§6) settles in thirty seconds what an afternoon of reading
our status code cannot.

---

## 2. What actually happened — three causes, stacked

They arrived in sequence over one night, which is why each "fix" looked like it
had failed. Do not assume a single cause next time.

### Cause 1 — the key was in ElevenLabs' retired format (real, theirs)

The stored `elevenlabs_api_key` was **64 hex characters with no prefix**.
ElevenLabs cut that format off server-side:

```
HTTP 400   detail.status: "invalid_api_key_prefix"
           "API key must start with 'sk_'."
```

It generated recordings fine on Aug 4 and was dead by Aug 6. **Nothing in
Connect changed; the provider did.** Only a new `sk_` key fixes it — re-pasting
the old one can never work, and it *was* re-pasted (row re-saved 01:39 UTC,
still 64-hex). Connect only `.trim()`s a pasted key, so nothing on our side
mangles it.

⛔ Note the status code: **400, not 401.** That matters — see cause 1's damage
below.

### Cause 2 — a genuinely `past_due` account (real, theirs)

A key pasted at ~02:05 UTC was on an account ElevenLabs had flagged
`status: past_due`. Proven to block, and worth knowing precisely:

- `/v1/voices` → **200**
- `/v1/user/subscription` → **200**
- synthesis → **401 `payment_issue`**, "Your subscription has a failed or
  incomplete payment."

So a green "connected" badge based on reachability alone is a lie on a
`past_due` account. `past_due` **is** a real blocker and we still refuse on it.

### Cause 3 — ⛔ our own bug: `has_open_invoices` is not arrears

`checkElevenLabsKey` (api) and the agent's status route both did:

```ts
if (status === "past_due" || sub.has_open_invoices === true) → unusable
```

**`has_open_invoices` counts the NEXT invoice too**, so it is `true` on a
perfectly healthy account for most of every month. Proven live on the account
that was working:

| Field | Value |
|---|---|
| `status` | `active` |
| `has_open_invoices` | `true` |
| `next_invoice.amount_due_cents` | `2379` |
| `next_invoice.next_payment_attempt_unix` | ~Sept 4 — a month away |
| a real synthesis POST | **200, 8,916 bytes of audio** |

Connect never sent that POST. It refused on the flag and told the customer
there was an unpaid bill. Fixed in `ef557f50`: **only `past_due` blocks.**

---

## 3. What each surface used to say, and why it misled

Three screens, three different stories, none of them the truth. This is what
turned a supplier problem into "something is wrong on your side".

| Surface | Said | Why |
|---|---|---|
| `/elevenlabs` settings page | *"Saved, but ElevenLabs couldn't be reached just now"* | The agent route mapped **only 401** to `invalid_key`; a 400 fell through to "unreachable" — pointing the blame at Connect |
| IVR Studio recording modal | *"The ElevenLabs key was rejected. Check it…"* | `classify()` tested `/invalid_api_key/` **before** the prefix case, and `invalid_api_key_prefix` contains it — so the one useful sentence was swallowed, and the advice was to re-paste a key that could never work |
| Both, later | *"ElevenLabs has an unpaid invoice… settle the bill at elevenlabs.io"* | Cause 3 — and shown to a **customer** |

Fixes:

- Any **4xx** from ElevenLabs is now a key problem (`isElevenLabsKeyFailure`);
  only 5xx is "them being down".
- The prefix case is classified **first**, and its message says explicitly that
  re-pasting will not help and that nothing is wrong on Connect's side.
- The settings page shows the **last 4 characters of the key that is actually
  stored**, plus a warning as you type if it doesn't start with `sk_`. A paste
  that silently didn't take is now visible rather than inferred.
- The key field is `autoComplete="new-password"` — browsers and password
  managers ignore `off` on password fields and will refill the old key over a
  new one, which looks exactly like a successful save.

---

## 4. ⛔ A customer must never see our supplier's billing state

A tenant customer opened "Make a recording" in the IVR Studio and was told to
go and settle a bill at elevenlabs.io. That names a supplier they have no
relationship with, exposes our account standing, and hands them a bill that is
not theirs.

Every failure now carries **two messages**:

- `ElevenLabsError.userMessage` / `KeyCheck.userMessage` — for Connect staff.
  Names the provider and our account state. **Not for customer eyes.**
- `ElevenLabsError.customerMessage` / `KeyCheck.customerMessage` — no supplier,
  no invoice, no key, and it points at what still works: *"you can upload a
  recording, or pick one you've already made."*

Chosen by role in `elevenLabsRoutes.ts` (`isConnectStaff` → `SUPER_ADMIN`),
applied to **status, voices, preview, generate, and the no-key 503** (which
used to send a customer to a settings page they cannot open).

Two things that keep this honest:

- Errors we raise **ourselves** ("type the greeting first", "pick a voice",
  text too long) default `customerMessage` to `userMessage` — they are about
  what the customer just did, and hiding them would strand people.
- Hiding the cause is only safe if someone is told instead: an `ourProblem`
  failure queues **one deduped ADMIN_ALERT per hour per reason**
  (`alertStaffOnce`, riding `queueBillingAdminAlertEmail`) and logs at error
  level.

⛔ **Izzy is SUPER_ADMIN, so he still sees the real reason.** That is deliberate.
Expect "but I can still see it" and do not treat it as a failed fix — check with
a tenant-admin account.

---

## 5. Where the code lives

`packages/shared/src/elevenLabsKeyFormat.ts` is the single source of truth,
because the API (Studio modal) and the agent (settings page) previously
described the same failure two different ways:

| Export | Job |
|---|---|
| `classifyElevenLabsFailure(body)` | Provider body → staff sentence. **Prefix case must stay first.** |
| `describeElevenLabsFailure(body)` | → `{ ownerMessage, customerMessage, ourProblem }` |
| `describeElevenLabsKey(key)` | → `{ looksCurrent, looksLegacy, last4, length }` — never the key |
| `isElevenLabsKeyFailure(status, body)` | 4xx = the key; 5xx = them |
| `ELEVENLABS_LEGACY_KEY_MESSAGE` / `_WARNING` / `ELEVENLABS_CUSTOMER_UNAVAILABLE` | The exact wording, in one place |

⛔ **Import it from `@connect/shared` (the root), not the subpath.** `apps/api`
and `apps/agent` typecheck under a `moduleResolution` that cannot resolve
`@connect/shared/elevenLabsKeyFormat` — the subpath compiles in the **portal**
only. This cost two rounds of typecheck errors; the module is re-exported from
`packages/shared/src/index.ts` for exactly this reason.

Other behaviour worth not regressing:

- `ElevenLabsError.providerCode` carries ElevenLabs' own `detail.status`, so
  callers branch on the real reason rather than a status code that means
  several things.
- `synthesiseSpeech` no longer retries at 16 kHz when the 400 was **about the
  key**. That retry asked a dead key the same question twice and buried the
  useful first message under the second failure. It still falls back for a
  genuine format refusal.

---

## 6. Probe recipe (shape only — the key is never printed)

`tsx` script `docker cp`'d into `app-api-1` or `app-agent-1`, importing
`@connect/db` + `@connect/security`, decrypting the `elevenlabs_api_key`
AgentSecret row, then:

1. `/v1/user` — identifies **which account** the key belongs to (`user_id`,
   `first_name`, tier, character limit). Worth doing early: "I have no open
   invoices" and "the key's account has an open invoice" can both be true if
   they are different accounts.
2. `/v1/user/subscription` — `status`, `has_open_invoices`, `next_invoice`.
3. **ONE** two-character synthesis. This is the only thing that actually
   answers "can it generate". ⛔ Never loop it, never retry it — synthesis is
   billed per character, and a retried POST double-bills.

Gotchas met while doing this:

- `@connect/db` exports **`db`**, not `PrismaClient` — `new PrismaClient()`
  throws "is not a constructor".
- `tsx` is at `apps/<app>/node_modules/.bin/tsx`, not the repo root.
- Print `last4` and a prefix at most. Never the key.
- `docker exec app-api-1 printenv ELEVENLABS_API_KEY` — worth checking. There
  is no env key in prod, so the DB row is the only key on the platform; a good
  env key would otherwise sit shadowed by a dead DB row, since
  `resolveElevenLabsKey` prefers the row.

---

## 7. State at handoff

- **Working.** Live check inside `app-api-1` returns `keyWorks: true`,
  `usable: true`, no message; the account reads 913 / 1,036,000 characters.
- Deployed: api + portal via `deploy-direct.sh --commit ef557f50`, agent via
  the manual `docker compose … build agent && up -d agent` (the deploy queue
  has **no agent service**). All three verified.
- Tests: **81/81** `apps/api` voice, **31/31** `packages/shared`. One
  timing-sensitive retry test went red once while a portal typecheck saturated
  the CPU; three consecutive re-runs were clean.
- Branch reconciled: a parallel session pushed `62a5e3ac` mid-work, merged as
  `42a62b2d` and pushed. ⛔ That session also committed some of this work into
  `db4a2ce4` by sweeping the shared working tree — the final tree is correct,
  but `db4a2ce4`'s message under-describes what it contains.

### Not proven / open

- **No Polly or ElevenLabs greeting has been generated through the UI since the
  fix** — the provider path is proven by direct probe, not by pressing the
  button. Press it.
- The customer-facing wording has been proven by unit test, **not** by loading
  the Studio as a tenant admin. Do that before calling it verified.
- The hourly ADMIN_ALERT dedupe is **in-process**, so an api restart resets it
  and blue/green means two processes can each send one. Acceptable for an
  alert; do not reuse the pattern where exactly-once matters.
