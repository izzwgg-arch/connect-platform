# ⛔ AGENT HANDOFF — Amazon Polly as a second IVR voice (2026-08-06) — READ FIRST for Polly, `can_use_amazon_polly`, voice quality/engine choices, or "why don't I see all the voices"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_AMAZON_POLLY_2026-08-06.md`**
(commits `045ab5d1` + `b3385dd4`, both DEPLOYED and container-verified,
api + portal, branch `feat/ivr-migration-takeover`).

- **A second voice source beside ElevenLabs**, interchangeable by the time
  audio exists: both make 8 kHz WAV and share ONE save path
  (`generatedPromptStore.ts` — filename → storage → catalog row → PBX push,
  extracted from the ElevenLabs route so the two can never drift). Owner page
  at `/polly` holds the AWS credentials; the IVR Studio grows a "Voice source"
  switch for people who are allowed it.
- ⛔ **`can_use_amazon_polly` is in NEITHER default bucket — not even
  TENANT_ADMIN.** Polly bills per character to Connect's own AWS account, so it
  is granted one custom role at a time. SUPER_ADMIN holds it automatically (the
  bucket force-adds every key — **no snapshot migration is needed** when adding
  a permission key). **Every Polly route ALSO requires `can_manage_ivr_prompts`**:
  the new key widens what a prompt manager may use, it never makes one.
  `/voice/polly/status` answers **200 `allowed:false`**, never 403 — the Studio
  asks on every open and a 403 storm would bury real failures.
- ⛔ **SigV4 is hand-rolled over `node:crypto` — do NOT swap in
  `@aws-sdk/client-polly`.** apps/api has been killed before by an undeclared
  import (`undici`); Polly is two plain HTTPS calls and this added **zero**
  dependencies. `signRequest()` is exported so the canonical form is testable
  directly — every bad signature looks like the same unhelpful 403.
- ⛔ **The generative engine silently ignores speaking speed.** PROVEN live
  (Matthew/en-US, us-east-1): byte-identical audio at speed 1.00 / 0.95 / 0.90
  — 14,976 bytes each — while neural's length moves with the setting. Amazon
  accepts `<prosody rate>` with a 200 and discards it. So generative gets **no
  SSML at all**, and the UI hides the speed slider via a **server-told
  `supportsSpeed` flag** (no screen hard-codes the list). Delete the id from
  `ENGINES_IGNORING_SPEED` if Amazon ever fixes it.
- ⛔ **A filter whose control is hidden makes the list look broken.** "Why
  doesn't it show all 109 voices?" was the Studio filtering by quality while
  the quality control sat inside **collapsed** Advanced settings. Language +
  quality now sit directly above the voice list, and both screens show
  `N of 109`. The `/polly` page defaults to *All languages* + *Any quality* —
  an inventory page must not hide inventory.
- **Live facts (us-east-1):** 109 voices — generative 43, neural 63, long-form 6,
  standard 60. Matthew = generative/neural/standard. **Generative is the
  default** (a greeting is a few hundred characters — under a penny, paid once,
  however many callers hear it). Generative is region-limited at AWS: zero
  generative voices means check the region before debugging code.
- Credentials: ONE AgentSecret row `polly_credentials` (all three values
  together — a half-saved credential is indistinguishable from a typo),
  encrypted, **written from apps/api NOT the agent** (the agent container is a
  manual rebuild, so routing it there would make the page depend on a hand
  step). Secret is write-only; the access key ID is shown in full on purpose.
  Verified `source:"store"` with a real AWS account.
- ⛔ **Verification traps that each produced a wrong answer first:** an
  unauthenticated **401 does NOT prove a route exists** (the auth hook runs
  before routing — grep the RUNNING container's `server.ts` instead);
  `grep -i error` on pino logs matches field NAMES like `"errorCount":0` (use
  `"level":(50|60)`); PowerShell here-strings `@'…'@` are a parse error in the
  Bash tool and end up as the commit subject.
- ⛔ **Not yet proven: no Polly greeting has been installed on a PBX or heard
  by a caller.** Preview + synthesis are proven end to end with real
  credentials; the save→push tail is the shared (well-exercised) ElevenLabs
  path but has never run with Polly audio. Prove that next.
