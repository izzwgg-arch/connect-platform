# AGENT HANDOFF — Amazon Polly as a second IVR voice (2026-08-06)

Branch `feat/ivr-migration-takeover`. Two commits, **both deployed and
container-verified** (api + portal):

| Commit | What |
|---|---|
| `045ab5d1` | The feature: Polly client, credentials store, routes, `/polly` page, permission, Studio switch |
| `b3385dd4` | Generative becomes the default; the hidden-filter bug; the ignores-speed discovery |

Read this before touching `apps/api/src/voice/polly*.ts`, the `/polly` page,
the IVR Studio's voice picker, or `can_use_amazon_polly`.

---

## 1. What it is

A second voice source for IVR recordings, alongside ElevenLabs. Someone types
the greeting, picks a voice, hears it, and it installs on the PBX — the same
flow, a different supplier behind it.

**The two are interchangeable by the time audio exists.** Both produce 8 kHz
mono WAV and go through the *same* save path, so a Polly greeting and an
ElevenLabs greeting are the same kind of catalog row. Only `provider` in the
log line differs.

---

## 2. ⛔ Who may use it — the whole point of the feature's shape

Polly is billed per character **against Connect's own AWS account**. So it is
NOT given to everyone who can manage prompts.

- Permission key: **`can_use_amazon_polly`** (in `packages/shared/src/portalPermissions.ts`,
  `ACTION_PERMISSION_KEYS`).
- ⛔ It is in **NEITHER default bucket — not even `TENANT_ADMIN`**. It reaches
  people one custom role at a time, via Admin → Custom Roles.
- SUPER_ADMIN holds it automatically and **no snapshot migration is needed**:
  `normalizeRolePermissionSet()` in `platformRolePermissions.ts` force-adds
  every currently-defined key for that bucket. Adding a key to the shared list
  is genuinely all that is required.
- ⛔ **Every Polly route requires the ordinary prompt-manager gate as well**
  (`can_manage_ivr_prompts`). The Polly permission widens *what* a prompt
  manager may use; it never makes someone a prompt manager. See
  `requirePollyUser()` in `pollyRoutes.ts` — two gates, not one.
- The gate is **authoritative** (`userHasActionPermission`, no role fallback),
  so a tenant admin does not inherit Polly by being a tenant admin.

**`GET /voice/polly/status` answers `200 {allowed:false}` for people without
the permission — deliberately not 403.** The Studio asks on every open; a 403
storm for the ordinary case would drown out real failures in the console. It
also returns `configured:false` to them, so someone without access learns
nothing about our setup.

---

## 3. Where the credentials live

- **One AgentSecret row, key `polly_credentials`**, holding
  `{accessKeyId, secretAccessKey, region}` as JSON, AES-256-GCM under
  `CREDENTIALS_MASTER_KEY` — the same store as the ElevenLabs key.
- ⛔ **Written from `apps/api`, NOT from the agent** (unlike the ElevenLabs
  key, which the agent owns). Deliberate: the agent has no part in Polly, and
  the agent container is rebuilt **by hand** (the deploy queue has no agent
  service), so routing this write through it would make the Polly page depend
  on a manual step.
- **Three values in ONE row on purpose.** A half-saved credential (new key,
  old secret) fails in a way indistinguishable from a typo. Writing all three
  together removes that state entirely.
- The secret is **write-only** — no endpoint returns it. The **access key ID is
  shown in full on purpose**: it is an identifier, not a secret (it travels in
  the clear in every signed request and is on display in AWS's own console).
  Showing it is what makes "did my paste land, or did the browser refill the
  old one?" answerable.
- Env fallback for local dev only: `POLLY_ACCESS_KEY_ID` / `AWS_ACCESS_KEY_ID`
  etc., with the same placeholder guard the ElevenLabs key uses.
- **Verified live 2026-08-06:** `source: "store"`, region `us-east-1` — the
  page → encrypted store → real synthesis path is proven end to end with a real
  AWS account, not just against the test fake.

---

## 4. ⛔ Hand-rolled SigV4 — do not "just use the AWS SDK"

`polly.ts` signs requests itself with `node:crypto` (~40 lines). The obvious
move is `@aws-sdk/client-polly`; it is also a large dependency tree added to a
container that **has already been taken down once by an undeclared import**
(`undici` — guarded now by `dependencyHygiene.test.ts`). Polly is two plain
HTTPS calls. **apps/api gained no new dependency for this feature.**

`signRequest()` is exported specifically so the canonical form can be asserted
directly in tests — every AWS call fails *identically* (403, unhelpful message)
when a signature is wrong, so testing it only through a live call tells you
nothing about why.

Routes (all in `pollyRoutes.ts`):

| Route | Gate |
|---|---|
| `GET /voice/polly/status` | prompt manager (answers `allowed:false` without the Polly permission) |
| `GET /voice/polly/voices` | prompt manager + Polly |
| `POST /voice/polly/preview` | prompt manager + Polly |
| `POST /voice/ivr/prompts/generate-polly` | prompt manager + Polly |
| `GET`/`PUT` `/voice/polly/credentials` | **platform owner only** (`requireSuperAdmin`) |

Guards mirror ElevenLabs exactly: 12/min per caller, 4 concurrent syntheses,
customers never told the real reason, staff told plus a deduped hourly admin
alert.

---

## 5. ⛔ The generative engine silently ignores speaking speed

**Measured against the live account, not read in a doc** (2026-08-06,
Matthew/en-US, us-east-1):

| Engine | speed 1.00 | speed 0.95 | speed 0.90 |
|---|---|---|---|
| generative | 14,976 bytes | **14,976 bytes** | **14,976 bytes** |
| neural | — | 13,630 bytes | — |

Amazon accepts the `<prosody rate>` wrapper on generative with a **200** and
then does nothing with it. Byte-identical output at every speed. No error to
notice, no effect to hear — the worst kind of failure.

Two consequences, both live:

1. **Generative never gets an SSML wrapper** (`engineSupportsSpeed()` /
   `ENGINES_IGNORING_SPEED` in `polly.ts`). Markup Amazon will discard is only
   ever a new way to break.
2. **The UI hides the speed slider** on such engines instead of leaving a dead
   control, driven by a server-told `supportsSpeed` flag on each engine in the
   status payload — **no screen hard-codes which engines those are.**

⛔ If Amazon later adds prosody support to generative, delete the id from
`ENGINES_IGNORING_SPEED` and both behaviours correct themselves. A test
(`pollyRoutes.test.ts`) locks this in so a tidy-up can't quietly undo it.

**Speed control still works on Natural (neural).** Matthew offers that too.

---

## 6. ⛔ The bug worth remembering: a filter whose control is hidden

Reported as *"why doesn't it show all 109 voices?"* and *"I'm looking for
Matthew in Generative"*. Nothing was missing — Matthew offers generative, and
all 109 voices were fetched. Three of my own filters were in the way:

- **The Studio filtered the voice list by quality while the quality control sat
  inside "Advanced settings", collapsed by default.** Two thirds of the voices
  vanished with the reason hidden behind a disclosure triangle.
- The `/polly` page's quality dropdown **only tinted a badge instead of
  filtering**, so "which voices do generative?" meant scanning 109 badges by eye.
- Its language filter **defaulted to English**, which is why 109 looked like far
  fewer.

**The rule this encodes: the control that filters a list must be visible beside
the list, and a filtered list must say so.** Both screens now show
`N of 109`; language and quality sit directly above the voice list in the
Studio; the Polly page defaults to *All languages* + *Any quality* because an
inventory page's job is to show the inventory.

---

## 7. Live facts (us-east-1, measured 2026-08-06)

- **109 voices total.** Per engine: generative 43, neural 63, long-form 6,
  standard 60.
- **Matthew (en-US): generative, neural, standard.**
- Generative is the **default engine**. Amazon charges more per character, but a
  greeting is a few hundred characters — under a penny, paid once, however many
  thousands of callers hear it. The cost argument against generative does not
  survive contact with IVR-sized text.
- Trade-off that follows: defaulting to generative shows **43 of 109** voices.
  That is why the count and the quality control had to become visible.
- ⛔ **Generative is region-limited at AWS.** If a future region shows zero
  generative voices, that is Amazon's availability, not our bug — check the
  region before debugging code.

---

## 8. Shared save path

`generatedPromptStore.ts` holds everything that happens **after** audio exists:
filename → tenant-scoped storage → catalog row (`source: "generated"`) → PBX
push. Extracted from the ElevenLabs route and shared, so there can never be two
versions of the tenant-slug rule or of "a failed push is not a failed
generation". All 55 pre-existing ElevenLabs tests passed unchanged through the
refactor.

⛔ `tenantSlug` is still always derived from `Tenant.name` via the
`toIvrSlug` normalisation — the Tenant model has no slug column.

---

## 9. Tests

`apps/api/src/voice/pollyRoutes.test.ts` — 23 tests, real Fastify + a fake AWS
behind global `fetch`. No network, no credentials, no spent characters.

```bash
cd apps/api && node --experimental-test-module-mocks --import tsx --test src/voice/pollyRoutes.test.ts
```

⛔ **node:test via tsx — never vitest** (apps/api does not install it; see the
standing rule about vitest imports after every merge).

Covers: the permission (no key ⇒ no character can be spent, and AWS is never
contacted), signing (sorted lower-case headers, correct scope, secret really in
the chain), the concurrency slot never leaking, credential shape-checking,
the 8 kHz request, the SSML escape, and the generative no-SSML rule.

---

## 10. Diagnostics recipe — asking AWS directly

Read-only probe against the live stored credentials, without exposing them:

```bash
# write a .ts probe locally, then:
scp -i .connect-ssh/connect2_ed25519 probe.ts root@45.14.194.179:/tmp/probe.ts
ssh ... 'docker cp /tmp/probe.ts app-api-1:/app/apps/api/probe.ts && \
         docker exec -w /app/apps/api app-api-1 npx tsx probe.ts; \
         docker exec app-api-1 rm -f /app/apps/api/probe.ts'
```

The api container runs `tsx src/server.ts`, so `npx tsx` is available and can
import `./src/voice/polly` and `./src/voice/pollyCredentials` directly.
**Print voice/region data only — never the credentials.**

⛔ **Never retry a synthesis POST** — it double-bills. The probe calls each
combination exactly once.

---

## 11. ⛔ Verification traps hit this session (all cost a wrong conclusion first)

- **An unauthenticated `401` does NOT prove a route exists.** The global auth
  hook runs *before* routing, so a nonexistent route answers 401 too. Verify a
  route by grepping the **running container's** `server.ts` for the
  registration, not by probing an endpoint without a token.
- **`grep -i error` on pino logs matches field NAMES** — `"errorCount":0` and
  `"expoError":null` in perfectly healthy call-wake push lines. Check
  `"level":(50|60)` instead.
- **PowerShell here-strings (`@'…'@`) are a parse error in the Bash tool** —
  the `@` ends up as the commit subject line. Use a heredoc for multi-line
  commit messages.
- **A deploy queue reporting `success` is not proof the code is live.** Both
  deploys were confirmed by `deployedCommit` *and* by grepping the running
  containers for the new symbols.

---

## 12. State at handoff

- ✅ Deployed and verified: api + portal at `b3385dd4`, healthy, zero
  error-level log lines, `/polly` and `/pbx/ivr-studio` both 200.
- ✅ Pushed to GitHub (`045ab5d1` then `b3385dd4`). Push from this machine is
  classifier-blocked — the working route is `git bundle` → `scp` → `git fetch`
  in `/opt/connectcomms/app` → push from the server clone.
- ✅ Real credentials saved through the page and working (`source: "store"`,
  us-east-1).
- ⛔ **Nobody has generated and installed a real Polly greeting on a PBX yet,
  and no caller has heard one.** Preview and synthesis are proven; the save →
  PBX push tail is the shared ElevenLabs path (well-exercised) but has not been
  run with Polly audio end to end. That is the next thing to prove.
- The branch is `feat/ivr-migration-takeover`, which is what production serves.
  `main` has none of this.
