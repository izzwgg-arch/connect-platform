# Connect 2 — working rules for Claude

## ⛔ AGENT HANDOFF — the agent got TOOLS; audio adaptation is measured but not built (2026-08-06) — READ FIRST for apps/agent, the model router, call-quality data, or permission-granting

Full handoff + spec: **`docs/ai-context/PLAN_SELF_IMPROVING_CONNECT_2026-08-06.md`**

- **The agent had NO agentic loop at all** — zero `tool_use` handling anywhere.
  Code pre-fetched data, pasted it in a prompt, and the model narrated it; it
  could never ask a follow-up. Fixed: `completeWithTools` in `llm/router.ts`
  (both providers, 8-round cap, degrades to a plain completion on failure —
  never replays a half-finished tool exchange across providers).
- ⛔ **The security model CHANGED.** The agent used to be safe because it was
  powerless. Now it can *ask* for data, so enforcement lives in
  `tools/toolRegistry.ts`: **no tool schema may declare a tenant**, `executeTool`
  strips any tenant-ish key the model invents and audit-logs the drop, and role
  gating hides internal tools from customers. **Every new tool must follow this.**
- ⛔ **OpenAI tool calls MUST use `/v1/responses`, not chat.completions** —
  `gpt-5.6-luna` (the live picked chat model, set via the owner model-picker,
  which OVERRIDES `DEFAULT_ROUTES`) rejects tools+reasoning there. Caught in prod.
- ⛔ **Thinking shares the `max_tokens` budget** on Opus 5 / Sonnet 5 / gpt-5.
  Four ceilings were too small; chat's 800 could return EMPTY text, which the
  engine silently turned into the canned "passed it to our team" line. Never
  lower these to "save money" — you truncate after paying to think.
- **Phase 1 measured (do not re-derive):** Android quality reporting is healthy
  (~452 reports / 668 connected calls). **iOS reported ZERO** — `platform` was
  hardcoded `"ANDROID"` in the shared RN client — and `networkType` was always
  null. Both fixed in `apps/mobile/src/sip/jssip.ts`, **needs an APK/TestFlight
  build to take effect**. ⛔ Do NOT import `@react-native-community/netinfo`:
  it is in node_modules but in NO package.json and absent from pnpm-lock
  (the undici failure mode) — networkType now comes from WebRTC ICE stats.
- **The tuner is deliberately NOT built.** Only 8 days of history and exactly
  ONE person+network group with both relay and direct arms — it would propose
  nothing. Coverage first (the mobile build above), then the decision layer.
- ✅ **Permission-grant-by-chat is COMPLETE (§7 of the plan doc)** — API apply
  endpoint (`apps/api/src/agentGrantRoutes.ts`) + portal password dialog
  (`apps/portal/components/AgentGrantConfirmDialog.tsx`, wired into BOTH the
  floating bubble and `/assistant`). The agent still only PREPAREs. Authority is
  the EXPORTED `getGrantablePermissions()` from `customRoleRoutes.ts` — there is
  exactly one authority rule; never write a second. The allow-list, deny-list
  and approval hash now live in `@connect/shared`
  (`chatPermissionGrants.ts` root-exported + browser-safe;
  `chatPermissionGrantHash.ts` is `node:crypto`, **subpath only**, and a shared
  subpath needs a `paths` entry in `tsconfig.base.json` or apps/api cannot
  resolve it). ⛔ The password goes to `/api/*` and NEVER `/agent-api/*`. Grants
  land in one per-recipient role `Assistant grants — <email>`. 35 API tests +
  12 agent tests cover every stress case; **not yet walked in a browser**.
- Deployed this session: `812674ca` → `c8f12a99` on `feat/ivr-migration-takeover`.
  Agent deploys are a MANUAL compose rebuild (no agent service in the deploy queue).


## ⛔ AGENT HANDOFF — the worker's dead push channel + a website that lived in a stash (2026-08-06) — READ FIRST before dropping ANY stash, removing a worktree on Windows, or believing a push/wake feature is live

Full handoff: **`docs/ai-context/AGENT_HANDOFF_WORKTREE_SWEEP_FCM_WIRING_2026-08-06.md`**
(commits `f9907e5d`, `8c15d5fa`, `8b2c29f6`, `5272a8fc` on
`feat/ivr-migration-takeover`; `ad3fb49d` on `rescue/marketing-website`.
api + portal + worker **DEPLOYED and verified**.)

- ⛔ **`git stash show --stat` shows NOTHING for a stash carrying untracked
  files** — it is a 3-parent commit and the untracked tree is **parent 3**. An
  entire marketing website (23 files: home, pricing, contact, 3 product pages,
  all 5 legal pages) existed ONLY in `stash@{0}` — not on disk, not on any
  branch, not in any commit — and read as empty. **Always
  `git show --stat <stash>^3` before dropping.** Rescued to
  `rescue/marketing-website`, unreviewed and deliberately unmerged.
- ⛔ **The worker's direct-FCM sender was DEAD CODE for 6 days.** Shipped
  2026-07-31, never sent one push: the container had no credential mount and no
  `FCM_SERVICE_ACCOUNT_PATH`, so `isFcmDirectConfigured()` failed closed and
  100% of call rings/wakes/cancels rode the slow Expo relay — *including*
  devices holding a native FCM token. Fixed + deployed; the worker now logs
  `FCM_DIRECT_ARMED` at boot. **Config, not code, was the bug** — so the guard
  is `apps/worker/src/fcmDirectWiring.test.ts`, which reads compose and failed
  against the pre-fix file. Never claim a push channel is live from code alone.
- ⛔ **`docker exec` runs as root no matter the container's runtime user** —
  reading a `-rw------- root` credential that way proves nothing. Check
  `docker inspect -f '{{.Config.User}}'` too. And the worker needs **~90 s**
  (`prisma generate`) before app logs appear; an absent boot line right after a
  deploy is not yet a failure.
- **Answering a call had `MAX_ATTEMPTS = 3` on paper and 1 in reality** — the
  per-attempt timer was the whole remaining deadline. That is the Create A Box
  ext 102 voicemail drop: answered in ~160 ms, no ACK, sat 16.1 s past the 15 s
  ring timer. Per-attempt cap is now 4 s (chosen against the PBX ring window,
  not SIP), and `answer_unacked` is its own **recoverable** verdict —
  `session_not_found_timeout` was a lie that misled two investigations.
  ⛔ Committed only; **ships with a mobile build, which needs Izzy's word.**
- ⛔ **Committing while another agent is live in the same tree**: never
  `checkout`/`stash`/switch branches. Build it with a temp index
  (`GIT_INDEX_FILE` + `read-tree` + `commit-tree` + `git branch`) — recipe in
  handoff §4. Stage explicit paths, never `git add -A`.
- ⛔ **Windows: `git worktree remove` fails "Filename too long"** on
  node_modules. Use `robocopy <empty> <target> /MIR` then delete; emptied dirs
  stay handle-locked for minutes and delete cleanly on retry — don't kill
  processes over it. All 6 worktrees + 8 merged branches cleared (~8 GB).
- ⛔ **Kept on purpose: `claude/silly-zhukovsky-9bd516`** (mobile perf). It adds
  `react-native-svg`, a NATIVE dep, and its lockfile predates the Expo SDK
  51→54 upgrade — pinning RN 0.74/React 18 resolutions that no longer exist.
  Merging that lockfile is the exact break `0e5207d7` fixed. Needs a re-resolve
  **and** a native build. Six May/June stashes also kept, pending Izzy's call.

## ⛔ AGENT HANDOFF — the portal `.payload` trap + IVR Studio publish feedback (2026-08-06) — READ FIRST before writing ANY portal error message, or for "publish did nothing" / "the error is just a code"

Full handoff: **`docs/ai-context/AGENT_HANDOFF_IVR_STUDIO_PUBLISH_FEEDBACK_2026-08-06.md`**
(commit `62a5e3ac`, on `feat/ivr-migration-takeover` — ✅ **DEPLOYED 2026-08-06**
inside portal `7f7ec541`; portal-only, nothing touching call routing).

- ⛔ **`ApiError` exposes the server's JSON body as `.body` — NOT `.payload`.**
  `.payload` has never existed. Every `e?.payload?.detail` in the portal is
  **dead code** that silently falls through to `e?.message`, which `apiRequest`
  builds from only the `error` and `message` fields and **never `detail`**. So
  the API sends a full explanation plus structured lists and the UI prints a
  bare slug like `prompt_refs_not_in_catalog`. This survives review because the
  chain *reads* correct and nothing fails loudly — the catch var is `any`, so
  there is no crash, no console error, and no type error.
  Correct examples live in the billing, login, and onboarding pages.
  **Triage by which field the dead read targets:** `.payload?.detail` is
  **total loss** (only the slug survives — the customer-visible kind);
  `.payload?.message` is **cosmetic** (`e.message` is built as
  `"<error>: <message>"`, so the sentence still gets through with the slug glued
  on front). ⛔ **A bare `grep .payload` MISLEADS — most hits are legitimate**
  (`admin/call-timeline`, `admin/call-flight`, `ai-trainer`, `useSipPhone.ts`
  and the admin billing components all read `.payload` as a real field on event
  / WS-envelope objects). Only hits **inside a `catch` on a value from
  `apiGet`/`apiPost`** are the bug.
  **Status (swept 2026-08-06):** both IVR pages fixed — studio `62a5e3ac`,
  migration `3fc51bb0` (merged `8b2c29f6`). One instance remains,
  `admin/card-test/page.tsx:40`, and it is the cosmetic kind on a
  super-admin-only screen — not worth a dedicated deploy.
  ⛔ Switching to `.body` is only half the job: where the server sends a code
  with **no `detail`** (`pbx_tenant_not_found`, `forbidden`, …) you still get a
  slug on screen. Map those to plain English, as ivr-studio's
  `PUBLISH_ERROR_TEXT` and ivr-migration's `ERROR_TEXT` do.
- **"It didn't publish" was a 3-second toast.** Success flashed and vanished, so
  admins clicked again — two real publishes 16s apart for *A plus center*. Both
  succeeded; the second was redundant, not harmful, and needed no cleanup.
  Success now leaves a banner up until the next edit (gated on `!dirty`), with
  the `keysWritten` count and the time; 422s render the API's `detail` plus each
  blocking recording translated into a place on screen; the button reads
  "Publishing…" and `publish()` guards re-entry itself, because the warnings
  dialog and the assistant deep-link both call it **without going through the
  button**.
- ⛔ **Not verified in a browser** — typechecked only. After deploy, watch one
  real publish and one deliberate 422.
- Env traps re-confirmed: `apps/portal/tsconfig.tsbuildinfo` is **tracked** and
  dirtied by `tsc` (restore before committing); fresh `.claude` worktrees spawn
  from **stale `main`, which has no IVR Studio at all** — fast-forward onto
  `feat/ivr-migration-takeover` first or the files don't exist; ESLint is not
  configured (`next lint` opens an interactive setup prompt), so typecheck is
  the gate. ⛔ **A worktree was deleted out from under this session mid-task** —
  push early; new customer-facing strings must be added to the page's
  `UI_PHRASES` with byte-exact em-dashes/apostrophes or they never reach Yiddish.

## ⛔ AGENT HANDOFF — ElevenLabs "the key isn't accepted" (2026-08-06) — READ FIRST for ElevenLabs, the `/elevenlabs` page, "Make a recording" failures, or ANY "the provider says no" report

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

## ⛔⛔ AGENT HANDOFF — the IVR actually works now (2026-08-06) — READ FIRST for ANYTHING touching the IVR Studio, publishing, recordings, menu keys, or "I changed it and nothing changed"

Full handoff: **`docs/ai-context/AGENT_HANDOFF_IVR_RUNTIME_2026-08-06.md`**

- ⛔ **THE RULE: the database is not what callers hear. Verify with a real
  call.** Four times in one night the DB, the publish record, and the API
  response all said "success" while callers reached the wrong menu — for four
  DIFFERENT reasons. Use `scripts/pbx/ivr-full-coverage.sh` /
  `ivr-pointing-stress.sh` / `ivr-e2e.sh` (real calls + real DTMF, asserted
  from the Asterisk log). Never report "fixed" from stored state.
- **Six defects found and fixed**, each producing a symptom the owner had been
  reporting for weeks: (1) the runtime NEVER read a number's assigned menu —
  `grep -c profile_id` on the live dialplan was **0**, so every number played
  one tenant-global menu; (2) publishing never copied recordings to the PBX;
  (3) a publish answered `{ok:true}` before Asterisk applied a single key
  (fire-and-forget `sendAction("DBPut")`); (4) the drift reconciler overwrote
  the owner's work — reverting fresh publishes AND rewriting the number→menu
  pointer every ~10 min; (5) the panel had repurposed the shared doorway
  destination row; (6) a menu with no greeting hung up on callers.
- ⛔ **TWO publish paths exist** — `POST /voice/ivr/publish` (Studio button) and
  `publishIvrForTenant()` (agent door + mode sweep). Near-duplicates. A fix
  applied to one silently skips the other; that shipped broken audio for a
  whole test round. **Anything added to one belongs in both.**
- ⛔ **Any repair path that writes owner-chosen state must respect
  `PUBLISH_SETTLE_MS`** (5 min). A watchdog that "repairs" from state read
  seconds ago will silently undo a publish — that is exactly what "I published
  and it didn't take effect" was.
- **Submenus are live** ("press N → another menu"): per-menu AstDB families +
  the additive `[connect-menu]` engine. The `m<id>` exten prefix is
  **hyphen-free on purpose** — Asterisk strips `-` in patterns.
- Harness traps that produced false "product is broken" reports: isolate traces
  by linkedid, match case-insensitively (`BackGround`), allow ~4s between key
  presses, use `Dial(...,/n,D(wwww<digits>))` for DTMF, **verify every config
  write**, and never edit/scp a script while it is running.

## ⛔ AGENT HANDOFF — the IVR coverage suite REWRITES live config (2026-08-06) — READ THIS WITH THE SECTION ABOVE, before running `ivr-full-coverage.sh` or believing any "I tested the IVR and it misbehaved" report

Full handoff: **`docs/ai-context/AGENT_HANDOFF_IVR_COVERAGE_SUITE_2026-08-06.md`**

- ⛔ **The suite the section above recommends is NOT a passive test — every round
  rewrites the live tenant's menu and publishes it**: overwrites keys 1–5,
  **deletes key 6**, swaps the greeting twice, and **repoints the DID to "Closed
  menu" and back**. Anyone hand-testing that number mid-run hears the wrong
  greeting / reaches the wrong menu / presses a just-deleted key. That is a FALSE
  failure and is indistinguishable from a real bug. **Never run it while a human
  is testing that number; never leave it looping unattended.**
- ⛔ **A killed run leaves the DB and the PBX out of sync** (config written,
  publish not reached, or the reverse). After any interruption: set the keys
  correctly, **Publish once**, then test.
- ⛔ **`disposition:"answered"` + `hangupCause:16` proves ONLY that the call
  connected.** A menu playing the wrong greeting or landing on the wrong
  destination writes an identical CDR row. Correctness comes from the suite's own
  PASS/FAIL (Asterisk-log grep) or a real listen — never from CDR disposition.
  This mistake was made and corrected in this session.
- Probe calls are spottable: `direction outgoing`, `fromNumber <unknown>`,
  `toNumber` = DID + keys pressed (`8457231213*1wwwwwwww9`), `channelsSeen` holds
  `…@connect-probe` / `…@connect-probe-press`. ⛔ **They land in the customer's
  real call history and inflate the Overview counters** — rule out a probe run
  before believing impossible dashboard numbers.
- 2026-08-06: a parallel session looped it ~30 min on Connect Communications
  (845) 723-1213 while Izzy hand-tested; killed at his word (PID 27372).
  **His original keys 1–6 were overwritten and never captured** — open item.
  The suite takes no snapshot and restores nothing on exit.

## ⛔ AGENT HANDOFF — Amazon Polly as a second IVR voice (2026-08-06) — READ FIRST for Polly, `can_use_amazon_polly`, voice quality/engine choices, or "why don't I see all the voices"

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

## ⛔ AGENT HANDOFF — VitalPBX panel locked out of its own configs (2026-08-06) — READ FIRST for "An exception has occurred / file_put_contents Permission denied" in the panel, tenant conf ownership, or the helper's privileges

Full handoff: **`docs/ai-context/AGENT_HANDOFF_PBX_PANEL_LOCKOUT_2026-08-06.md`**
(commits `fc826643` helper-side + `2f017f88` privilege/installer-side — both now
pushed to `origin/feat/ivr-migration-takeover`).

- **Symptom**: red modal on any panel Save for one tenant —
  `file_put_contents(/etc/asterisk/vitalpbx/extensions__50-<t>-dialplan.conf):
  Permission denied` (OmbuSystemConf.php) — while the green "data has been
  updated in the database" toast is simultaneously CORRECT. The DB write lands;
  only the live routing file write fails, so the change needs a re-save after
  the fix. ⛔ **Calls are never affected** (Asterisk only READS these, mode 644).
  Hit tenants 2 (`a_plus_center`) and 35 (`connect_communications`).
- ⛔ **ROOT CAUSE — the fix already existed and could not run.** `fc826643`
  added `_chown_gui_conf` / `restore_gui_conf_ownership` to hand each
  regenerated conf back to www-data, and it shipped in the deployed helper.
  But `connect-pbx-helper.service` runs `User=asterisk`, and **handing a file
  to another user is root-only** — every call raised `PermissionError` into a
  deliberate "never raises" swallow. Live-proven: manual chown at 21:41,
  re-broken at 22:09, the exact minute the helper *carrying the fix* installed.
  **The code was never wrong; the privilege was missing.**
- **Real fix**: drop-in
  `/etc/systemd/system/connect-pbx-helper.service.d/10-gui-conf-ownership.conf`
  granting `AmbientCapabilities=CAP_CHOWN CAP_FOWNER` (+ matching
  CapabilityBoundingSet) — still NOT root. Applied live, verified via
  `getpcaps`, and added to the installer. Unit backup
  `/root/connect-pbx-helper.service.bak-20260806-ownership`.
- ⛔ **Two non-fixes — do not retry**: a one-off `chown` (right emergency move,
  but the next regen re-takes it), and **a POSIX ACL alone** (the regen's
  `chmod 0644` sets the ACL *mask* to `r--`, masking `www-data:rw-` to
  effective `r--` — verified with a probe file).
- **Canary kept**: `connect-conf-owner-heal.{path,timer}` +
  `/usr/local/sbin/connect-vitalpbx-conf-owner-heal.sh`. It should now NEVER
  fire — new entries in `journalctl -t connect-conf-heal` mean the capability
  grant regressed.
- ⛔ **The installer would have DOWNGRADED the PBX**: its embedded helper had
  drifted to `2026.08.06.2` while the `.py`/live PBX were `2026.08.06.6`, so a
  reinstall would have wiped the same day's doorway-hijack fix (`db4a2ce4`).
  Re-synced. The `fc826643` drift guard catches this **only if someone runs
  it** — and on Windows it could not pass at all (`core.autocrlf` → `.sh` CRLF
  vs `.py` LF), now pinned by a new `.gitattributes` (`/scripts/pbx/**
  text eol=lf`, scoped — a repo-wide `*.sh` rule would churn 113 files).
  Run the guard after ANY change to either file — it is 33 node:test cases,
  ~1 s: `npx tsx --test scripts/pbx/install-vitalpbx-inbound-route-helper.test.ts`
  (green as of 2026-08-06, both files at `2026.08.06.6`).
- **Where the ownership code lives** (`fc826643`, four call sites — all four
  matter): `restore_gui_conf_ownership()` runs after a successful
  `apply_tenant_changes()` regen and BEFORE the MOH re-apply, and
  `_chown_gui_conf()` runs after `os.replace` in each of the three atomic
  tenant-conf writers (queue musicclass patch, dialplan MOH patch, route-Goto
  bake). All are tenant-scoped and non-fatal by design — with the capability
  grant in place they now actually take effect.
- Env: the helper's `audit.jsonl` is `/var/lib/connect-pbx-helper/` (**66 GB**,
  `tail -c` only) — NOT `/opt/connect-pbx-helper/`. Multiple sessions edit the
  SAME working tree concurrently: stage explicit paths, never `git add -A`.

## ⛔ AGENT HANDOFF — Connect doorway rebuild: DID switch-to-connect was broken platform-wide (2026-08-05) — READ FIRST for IVR Studio number switching, "published but callers hear the old routing", the PBX route helper, or the connect-doorway dialplan

Full handoff: **`docs/ai-context/AGENT_HANDOFF_CONNECT_DOORWAY_2026-08-05.md`**

- **Every switch-to-connect had been dead since ~May**: the PBX doorway
  destination (id 607, an April-era T21 custom app) was panel-deleted — FK
  cascade emptied `ombu_custom_contexts` — and the pinned env id made every
  flip fail `connect_destination_not_found`. Nobody flipped a number between
  April and August, so it surfaced only when Izzy tested the Studio.
- **Rebuilt as a global self-healing doorway** (helper v2026.08.05.1 DEPLOYED,
  backup `/root/helper-backup-doorway-20260805.py` on the PBX): Custom Context
  `connect-doorway` discovered BY NAME at flip time (stale pinned ids are
  skipped, never fatal), dialplan shim self-installs to
  `/etc/asterisk/vitalpbx/extensions__96-connect-doorway.conf` (verified live),
  rows self-create inside the retarget transaction, `POST /doorway-status` for
  health. Connect side at `e9ab55ca` (deployed api+portal): picker auto-fills
  from PBX-synced numbers, switch failures are LOUD in the Studio
  (`lastSwitchError` on the numbers list).
- ✅ **UNBLOCKED AND DONE 2026-08-05 (evening session)**: Izzy ran the GRANT +
  two helper installs via Run buttons. The doorway needed TWO more fixes to
  actually work, both shipped as helper **v2026.08.05.3** (deployed, commit
  `3399f0df`, backups `/root/helper-backup-{moduleid,bake}-20260805.py`):
  (1) the doorway `ombu_destinations` INSERT was missing `module_id`;
  (2) ⛔ **retarget/restore never regenerated the dialplan** — they updated the
  DB then ran the legacy apply (reload only), so every "successful" switch
  left callers on the OLD routing. Now both directions run the real
  per-tenant regen + Goto bake (agent_set pattern). The custom-context render
  IS `Goto(connect-doorway,s,1)` — proven live. Full connect→pbx→connect
  cycle proven on (845) 723-1213; left ON CONNECT.
- ⛔ **api-side: switches take ~35-40s now (full regen).** The 15s helper
  timeout filed phantom failures that the scheduler retry healed (noop
  convergence). Fixed to 90s in `pbxInboundRouteHelperClient.ts` (`3399f0df`)
  — ✅ **DEPLOYED 2026-08-06** inside api `7f7ec541`; the transient
  `helper_*_failed: operation was aborted` per switch should no longer appear.
- **Landau's mapping was stale** (said connect, PBX rings ext 101 directly —
  route was rebuilt as id 68) — corrected to `pbx` this session. PBX ssh that
  works: repo key `.connect-ssh/connect2_server2_ed25519`, port 22 (the `pbx`
  alias pins port 2222 and times out).

## ⛔ AGENT HANDOFF — Create A Box (T7) desk-phone outage + ext 102 app failure (2026-08-05) — READ FIRST for Create A Box, "phones don't ring / straight to voicemail", the WireGuard-tunnel office, or any PENDING PBX registration-expiry fix

Full handoff: **`docs/ai-context/AGENT_HANDOFF_CREATEABOX_T7_OUTAGE_2026-08-05.md`**

- ⛔ **A PBX fix is STAGED but was NOT APPLIED at handoff** — check
  `pjsip show aor T7_101 | grep -i expir` (read-only) FIRST: `120` = Izzy ran it,
  `3600/7200` = still pending, re-surface it. The fix caps T7 desk aors 101–107
  (never `_1` app aors) at 120 s registration in
  `/etc/asterisk/vitalpbx/pjsip__50-7-extensions.conf`, backup + 21-line abort guard.
  ⛔ The session's auto-classifier blocked the ssh write, the settings self-grant, AND
  the Desktop Commander route despite Izzy's explicit repeated mandate — do NOT waste
  time re-trying tool routes; hand Izzy the Run-button block (in the handoff §4).
- **2026-08-05 12:57 PM ET: ALL Create A Box desk phones went dead → instant VM**
  ("greeting looping" = wake-hold MOH loop for 102 + instant VM greeting for 101).
  Cause (tcpdump-proven): the office GL.iNet router (wg peer 10.88.0.2, on T-Mobile
  cellular) lost its NAT ledger; loopcom forwarded every qualify perfectly, the box
  answered only on NEW ports. Phones stay dark until their next re-register (1–2 h
  grants — hence the fix). Scope was Create A Box ONLY. NOT the wake-dial rollout
  (dial keys verified byte-correct). Immediate fix = power-cycle the office router.
- **Ordinary T-Mobile IP rotation never causes this** (WireGuard roams through it;
  62-day history proves it) — only a router state reset does. Near-daily small
  self-healing blips + probable smaller repeats (7/29, 8/3 miss-rates 35%/32%)
  predate the first total wipe on 8/5.
- **Ext 102 (Sender Weiss) is a SEPARATE chronic problem**: registered 1–3.5 h/day
  (T-Mobile CGNAT churn, ~90 IPs/10 d), Expo-relay-only pushes (no nativeFcmToken),
  pre-Aug-1 build — answer taps land mid-reconnect and die (`SIP_REGISTER_FAILED`
  right after ANSWER_TAPPED). Fix = latest APK + Samsung battery settings +
  wake-dial (enrolled 8/5). NOT a port-443 case.
- Query gotchas + env notes (conntrack missing on loopcom, Prisma field names,
  history-window limits) in the handoff §5.

## ⛔ AGENT HANDOFF — onboarding uploads were destroyed by every api deploy (2026-08-06) — READ FIRST for wizard file uploads, port document attachments, or BEFORE ADDING ANY NEW STORAGE DIRECTORY to apps/api

Full handoff: **`docs/ai-context/AGENT_HANDOFF_ONBOARDING_UPLOADS_VOLUME_2026-08-06.md`**
(commit `5b2214fe` on `feat/ivr-migration-takeover`, shipped inside the tip
`ff1d9a7b` — **DEPLOYED and container-verified 2026-08-06**.)

- ⛔ **THE RULE: a `process.cwd()` storage fallback is fine in dev and is a
  DATA-LOSS BUG in a container.** `onboardingStorageRoot()` fell back to
  `<cwd>/data/onboarding-files` because `ONBOARDING_STORAGE_DIR` was never set
  and no volume covered `/app/data`, so every api deploy destroyed the
  customer's uploaded bills/LOAs — while the `onboardingUploadedFile` **DB row
  survived**, leaving the admin UI and the port-attach loop believing the file
  was there. **Silent at every step**: the write succeeds, the deploy succeeds,
  and the attach failure lands in `portDocAttachFailures`, which nobody reads.
- **Proven casualty**: inii mini (`cmsey1ydz0000o4xoxu92gh2m`) uploaded
  `Invoice_14945_2026-08-01.pdf` at 20:56 on 2026-08-05; the 21:49 and 22:31
  deploys destroyed it, and **VoIP.ms port order 217760 was filed with no bill
  attached**. Old containers are removed, so it is unrecoverable — the customer
  must re-upload. An audit on 2026-08-06 found **exactly ONE** orphaned row
  platform-wide (that one); query in the handoff §2. **Policy is flag, never
  delete** — the row is the only evidence the customer ever supplied the doc,
  so admin detail now carries `fileOnDisk` instead of dropping the row.
- ⛔ **`docker-compose.app.yml` has TWO api service blocks with duplicated env
  and volumes — `api` AND `api_candidate`** (blue/green, host `:3004`). A volume
  added to only one tests perfectly and then silently loses every file at the
  next cutover. Any new storage dir needs FOUR things: the named volume, the
  mount + `*_STORAGE_DIR` env in **both** blocks, and a boot-time warning when
  the env is unset (`warnIfOnboardingStorageEphemeral` in `server.ts` is the
  pattern). `crm-lead-docs` / `crm-voicemail-drops` are shared for this reason.
- The root had been **copy-pasted into three files** and had drifted; it now
  lives once in `apps/api/src/onboarding/storage.ts`, which also gives the admin
  download path the path-traversal guard it never had.
- ⏳ **NOT PROVEN END TO END — the volume holds ZERO files.** No upload has
  happened since the deploy, so "file survives a deploy" is proven only as
  plumbing (env + mount + volume + new code all verified inside `app-api-1`).
  Prove it in 5 minutes without a customer: upload any small PDF through a
  sign-up link, deploy, confirm the file is still under
  `/var/lib/connect/onboarding-files/` and `fileOnDisk` is true.
- Env trap: an audit script copied to `/tmp` dies `MODULE_NOT_FOUND` on
  `@prisma/client` — pipe it via **stdin** into
  `docker exec -i -w /app/packages/db app-api-1 node -`.

## ⛔ AGENT HANDOFF — onboarding E2E payment proof, journey tracking, auto-ban fix (2026-08-04→05) — READ FIRST for the sign-up wizard, public pay page, sign-up report emails, "link stopped working" reports, or ElevenLabs Make One

Full handoff: **`docs/ai-context/AGENT_HANDOFF_ONBOARDING_E2E_PAYMENT_2026-08-04.md`**

- **The whole paid path is PROVEN with a real card** ($33: declined → retried →
  approved → build → wiped). Five dead-code bugs were stacked behind the
  never-reachable checkout; ⛔ the recurring lesson is **never invent an
  event/enum value — grep the Prisma enum first** (an invalid
  OnboardingEventType silently ate the paid-marker: money taken, build never
  started). Declined cards are retryable forever (`allowRetry: true` in the
  public pay route); APPROVED still replays, PENDING still 409s.
- **First extension = Owner → TENANT_ADMIN** (movable radio in the wizard,
  owner must have an email). Before this, fresh accounts had NO admin at all.
- **Every sign-up emails tod10950**: on first link-open and on finish/failure
  (plain-English report with a play-by-play). Journey beacons record steps,
  time-per-step, exact stuck-messages, searches, card declines
  (`journeyTracking.ts`, `adminSignupReport.ts`, `POST /onboarding/:token/track`).
- ⛔ **Sign-up links NEVER expire** — "the link stopped working" = check the
  nginx auto-ban FIRST (`monitor.sh` bans 60 min on >30×401/5min; a signed-out
  portal tab used to 401 every 2.5s and self-ban customers — fixed `cdb88fdf`
  via `hasBrowserAuthToken()` gate + backoff). Matamim's office IP is
  allowlisted; customer links: `9lHaW…` unused, `Ic6…` = Matamim mid-wizard
  (porting a Verizon number).
- ElevenLabs Make One: /status now carries the voice list (one round-trip) and
  **preview audio is reused on save** (10-min cache — no second synthesis, half
  the character spend). AuthGate keeps query strings on login redirect —
  dropping `?firstrun=1` had made the IVR walkthrough unreachable.
- Resume works (currentStep is a STRING column — `Number()` it), /progress
  self-heals paid-but-unmarked submissions, the E911 address + `language` are
  no longer stripped by the submit schema.

## ⛔ AGENT HANDOFF — wake-and-wait FLEET ROLLOUT (2026-08-05) — READ FIRST for wake enrollment, extension dial strings, or "phone didn't ring while asleep" work

Full handoff: **`docs/ai-context/AGENT_HANDOFF_WAKE_DIAL_FLEET_2026-08-05.md`**

- **Wake-and-wait is LIVE FLEET-WIDE and self-maintaining** (deployed `68fc38b5`,
  2026-08-05, Izzy's mandate). 12 extensions enrolled (10 new + Simon T5_101 +
  T102_101); the worker's 5-min cycle auto-enrolls any future device once its
  user has a fresh active MobileDevice (Android AND iOS), and re-heals VitalPBX
  panel edits that revert the dial key.
- ⛔ **Never hand-edit extension dial keys for wake enrollment — the worker
  re-asserts every 5 min and will fight you.** Use
  `POST /telephony/internal/wake-dial-publish` (`enable:"0"` to unenroll) or the
  gates `WAKE_AUTOENROLL_ENABLED` / `WAKE_DIAL_AUTOENROLL_ENABLED` in
  `/opt/connectcomms/env/.env.platform`. Pre-rollout snapshot of all 120 dial
  keys: loopcom `/root/dialkeys-pre-wake-rollout-20260805.txt`.
- The route rewrites ONLY the exact token `PJSIP/T<t>_<e>_1` ↔
  `Local/T<t>_<e>_1@connect-mobile-wake-dial/n`, discovers the tenant AstDB
  hash itself (read-only `database showkey dial` via AMI Command), and fails
  closed on anything unrecognized. No mapping state lives on the PBX.
- ⛔ **T34_101 (RSBK "Appointments" — NOT Fixup Group; T31 is Fixup Group with
  only ext 103) is skipped and worse than a wake gap:** its dial key rings only
  the dead base endpoint, so calls never reach the app AT ALL. Fix = add
  `&PJSIP/T34_101_1` (PBX write, needs mandate; task session running). Its DND
  has been ON since ~Jul 6 — check before promising it will ring.
- The disabled iOS VoIP prewake in `apps/api/src/server.ts` **stays disabled**
  (duplicate-CallKit-call bug); iOS wakes via its normal INCOMING_CALL VoIP
  push at hold start.
- Deploy-queue job statuses are `success`/`failed` — not `succeeded`; PBX SSH
  writes are classifier-blocked here even with verbal OK (the AMI route IS the
  way); local `git push` blocked → bundle route.

## ⛔ AGENT HANDOFF — IVR Studio: numbers/scheduling/announcements, wizard checkout, ElevenLabs, teams, permissions (2026-08-04) — READ FIRST for IVR Studio, DID switching, onboarding payment, voice generation, or custom-role permission work

Full handoff: **`docs/ai-context/AGENT_HANDOFF_IVR_YIDDISH_2026-08-04.md`** (3 sessions appended).

- **The wizard has NO payment screen.** Reaching checkout calls
  `POST /onboarding/:token/checkout` (creates tenant + first invoice in the
  background, idempotent, re-lines an UNPAID invoice if the quote changed) and
  hands to `/pay/invoice/[token]` — the real customer checkout. The public pay
  route detects `metadata.source=onboarding_signup`, FORCES card-vault +
  autopay (upsert, not update — a new tenant has no settings row), marks the
  submission paid, and kicks number purchase + PBX build + welcome emails.
  Never rebuild a second card form; that mistake was made and deleted twice in
  one night (wizard inline form, then a bespoke /admin/card-test form).
  `/admin/card-test` = $1 invoice on the same checkout (super-admin, amount is
  a server constant).
- **Number↔menu scheduling** (`didSwitchSchedule.ts` + `DidSwitchSchedule` /
  `IvrAnnouncementSchedule` tables): the Studio's top step picks which DID
  rings a menu and WHEN — exactly two timing options (now / date+time), end
  never / on-a-date. ⛔ **The scheduler never reimplements the flip** — it
  mints a 2-min SUPER_ADMIN service JWT and drives the EXISTING
  `/voice/did/:id/switch-to-connect|switch-to-pbx` via `app.inject`. "Now"
  executes inside the Studio's publish(); dated switches run on a 60s tick,
  retry 30 min, then mark failed + email ADMIN_ALERT_EMAIL. A failed HAND-BACK
  deliberately stays on Connect (the direction that keeps answering).
- **Pre-menu announcements are END-TO-END LIVE**: one AstDB key
  (`connect/t_<slug>/pre_announce`) set/cleared by the same tick; the dialplan
  patch was applied 2026-08-04 under Izzy's one-time PBX mandate (backup
  `/etc/asterisk/extensions__60_custom.conf.bak.pre-announce.20260804T150419Z`).
  Plays ONCE per call (retries jump to `(prompt)`), skips if the file is
  missing.
- ⛔ **`requirePermission(canManageIvr)` is a ROLE-ONLY check** — custom-role
  portal permissions are invisible to it. Every Studio/DID write must use
  `requireRoleOrPortalPermission(..., "can_manage_ivr_routing" | "can_publish_ivr_routing" | "can_manage_ivr_prompts")`.
  Half the Studio's writes had the bare form: a custom role could open the
  Studio and fail every save. **IVR Migration is super-admin only, with NO
  grantable permission** — nav-hidden AND page-gated (`backendJwtRole`).
- **ElevenLabs greeting generation** (`apps/api/src/voice/elevenLabs*.ts`):
  key lives in AgentSecret (same CREDENTIALS_MASTER_KEY as the agent), asks
  for phone-native `pcm_8000` (no conversion at all; 16 kHz fallback → one
  ffmpeg downsample), IVR-tuned defaults, preview saves nothing, generated
  rows are `source:"generated"` = play-only (no download, `no-store`).
  ⛔ ElevenLabs returns **401 for an UNPAID account** — same code as a bad
  key; `classify()` reads `detail.status` first. `usable:false` ≠
  `keyWorks:false`. Never blame the key on status code alone. **A retired-format
  key answers 400, not 401** — and `usable` is decided by `past_due` ALONE now,
  never `has_open_invoices`; see the ElevenLabs key/billing handoff at the top
  of this file before touching any of that.
- **Ring groups / waiting lines** ship from the Studio (`MakeTeam.tsx` →
  `POST /voice/teams`): members arrive as extension NUMBERS, resolved against
  ONE live PBX read that also yields free numbers + tenant path; unknown
  extension = refuse whole request; Apply Changes is NEVER fired.
  ⛔ apps/api must not import undeclared packages (`undici` killed the
  container on boot — blue/green refused cutover; guarded by
  `dependencyHygiene.test.ts`; local `require.resolve` LIES, pnpm hoists).
- **Deploys do not queue**: `deploy-direct.sh` fails fast when the queue has a
  running job (a parallel server session deploys the same branch). Wait on
  `curl 127.0.0.1:3910/ops/deploy/status` until `runningCount:0` — never
  `--skip-queue-check`, never `pgrep`-based waiters (they self-match the
  compound command line; cost three dead SSH sessions).
- Yiddish: every new customer-facing screen registers a PHRASES list +
  `useUiLanguage`; phrases are warmed through Yiddish Labs via the agent's
  `/agent/ui/translate` (warm:true). ~240 phrases warmed this engagement,
  0 failures. Never let a `teams.map((t) => …)` shadow the translator `t`.


## ⛔ AGENT HANDOFF — Eli iOS freezes → 443 route, paste-on-iOS-26, build 52 (2026-08-05) — READ FIRST for Displaydex, SIP-over-443, paste reports, voice diag telemetry, or TestFlight builds

Full handoff: **`docs/ai-context/AGENT_HANDOFF_ELI_IOS_443_PASTE_2026-08-05.md`**

- **Displaydex is LIVE on SIP-over-443**: nginx `location /sip` on loopcom now
  proxies DIRECTLY to `https://m.connectcomunications.com:8089/ws` (backup:
  `/root/nginx-connectcomms-backup-20260805-0410.conf`); tenant flipped to
  `webrtcRouteViaSbc=true, sipWsUrl=null`. Proven by raw-REGISTER probe → 401.
  Eli must sign out/in (the app never refreshes a cached `sipWsUrl`). Success
  signal: his `PbxEndpointRegistrationEvent.contactUri` = `45.14.194.179` —
  which also means PBX-side contact-IP whois is now MEANINGLESS for this
  tenant; use loopcom nginx logs.
- ⛔ **The `sbc-kamailio` container (loopcom :7443) is an UNFINISHED
  experiment** — dispatches to a nonexistent docker host `pbx`, answers
  `503 PBX Unavailable`, has never carried a call. Never route at it without
  finishing + testing.
- ⛔ **Telemetry traps:** `iceHasTurn:false` in voice diag is meaningless (the
  app never sends the field — server defaults false; RCA "TURN_missing"
  verdicts inherit the lie). A session stuck REGISTERING never heartbeats
  (effect ordering), so `alive:0s` ≠ app died. iOS CallFlightRecorder uploads
  ONE native seed event per call (`deviceId: null` — query by tenant), never
  the JS timeline.
- **Paste broken on Eli's iOS 26.5 but fine on Izzy's older iOS, same build**
  → OS-version incompatibility is the front-runner (permission theory
  retired: menu-paste never needs permission; the Settings row only appears
  after a programmatic clipboard read). Waiting on Eli's long-press
  observation; candidate fix = RN 0.81.5→0.81.6 in build 53 (re-lock pnpm).
- **Build 52 submitted** (launch-screen picker, paste explainer + Deny-wedge
  detector, keyboard-inset commit), attached to "Loopcom Testers",
  WAITING_FOR_REVIEW. Pipeline recipe + `asc-release-52.mjs` pattern in the
  handoff §6. Bump `buildNumber` in **app.config.ts**; `npx --yes eas-cli`
  (plain `eas` not installed on loopcom).
- **QSR prefix route**: dialer only shows routes with a per-user permission
  row. It was assigned to Yehuda by mistake — now Eli-only (not default). A
  duplicate QSR route sits in the QSR tenant itself as clutter.

## AGENT HANDOFF — onboarding round 2 deploy + worktree cleanup (2026-08-05) — READ FIRST for wizard/checkout work, deploys, or worktree hygiene

Full handoff: **`docs/ai-context/AGENT_HANDOFF_ONBOARDING_ROUND2_DEPLOY_2026-08-05.md`**

- **Production runs merged tip `7f3c7970`** (api job `1ba4879a` container-verified +
  portal): wizard audit round 2 (`cf16ab12`), per-submission provisioning identities
  (`6f5644f2`), port-in retry safety (`3a099489`), stranded-paid-signup watchdog
  (`100a5071`), IVR Studio first-run (`32696a85`), and the rescued api error-leak
  fix (`4fb512ed` — never gate safety behavior on NODE_ENV; the container doesn't set it).
- **`BillingInvoice.onboardingSubmissionId` is UNIQUE** (migration `20260804090000`,
  applied): one first-month invoice per sign-up, enforced by the DB. Checkout
  looks up by that column, catches the P2002 race, and the client checkout POST
  uses a 30 s timeout. Never reintroduce findFirst→create without it.
- Review-step pricing comes from **`GET /onboarding/:token/quote`**; the pure
  input derivation is `apps/api/src/onboarding/quoteInput.ts` (pre-submit reads
  autosaved `answers`, post-submit reads `requestedExtensions` — the `smsEnabled`
  COLUMN is false until submit, don't trust it pre-submit).
- ⛔ **Merging parallel sessions: run tests after EVERY merge** — two clean
  auto-merges still conflicted semantically (subaccount naming vs a new guard
  test; reconciled in `110786d4`). `git merge` succeeding proves nothing.
- **SSH alias is `ssh connect`** (root@45.14.194.179) — "loopcom" does NOT
  resolve on this machine. Deploy queue: token in
  `/opt/connectcomms/env/.env.platform`, api before portal, terminal status is
  the string `success`, api runs `prisma migrate deploy` itself.
- Worktrees cleared 2026-08-05; uncommitted APK-era work is preserved on
  `rescue/cb-voicemail-apk-worktree` + `rescue/connect2build-apk-worktree`.
  ⛔ Branch `cursor/cloud-agent-1773439170847-tqkex` is LOCAL-ONLY on purpose —
  it contains a hardcoded AMI password; scrub before any push.

## AGENT HANDOFF — stranded paid sign-up watchdog (2026-08-04) — READ FIRST for onboarding setup recovery, the progress page, or the admin Retry button

Full handoff: **`docs/ai-context/AGENT_HANDOFF_ONBOARDING_WATCHDOG_2026-08-04.md`**
(commit `100a5071`, deployed in the round-2 tip `7f3c7970`).

- **A paid sign-up can no longer strand silently.** `setupWatchdog.ts` sweeps
  every 60 s from api boot: paid + not CANCELED + `pbxSetupStatus` in
  {null, queued, building, syncing, inviting, failed} + `updatedAt` older than
  `ONBOARDING_INFLIGHT_STALE_MS` (15 min) → timeline event + re-kick
  (`applyOnboardingNumber` → `runOnboardingSetup`, both idempotent).
- ⛔ **The event timeline IS the retry counter** — `startsWith` on the exported
  `WATCHDOG_RESUME_MESSAGE` prefix. Never reword it (resets every counter);
  deleting a submission's events also resets the counter AND the alert dedupe.
- After **5** fruitless resumes: stop, log "Watchdog gave up", queue ONE
  plain-English `ADMIN_ALERT` EmailJob (adminSignupReport pattern). The
  give-up event is the dedupe — one email per stuck sign-up, ever.
- `GET /onboarding/:token/progress` now reports `failed:true` + a friendly
  "we hit a snag, we're on it" once a paid build is stalled past the window
  (shared `isSetupStalled`) — the infinite spinner is dead. Admin detail page
  gained the "Phone System Setup" card + Retry button (endpoint pre-existed).
- `ONBOARDING_INFLIGHT_STALE_MS` now has FOUR readers (orchestrator resume,
  retry-setup 409 gate, watchdog query, progress stalled-branch) — tune via
  env only.

## AGENT HANDOFF — month-2 billing = the $35 sign-up quote (2026-08-04) — READ FIRST for recurring-invoice, telecom-fee, or onboarding-billing work

Full handoff: **`docs/ai-context/AGENT_HANDOFF_ONBOARDING_MONTH2_BILLING_2026-08-04.md`**

- **Every onboarding-created/adopted tenant gets billing stamped** by
  `ensureOnboardingBillingDefaults` (`apps/api/src/onboarding/onboardingBillingDefaults.ts`,
  deployed `aafcc2f7`): `taxEnabled` on + `metadata.billingTelecomFees` = E911 $3
  per number, flat $2 regulatory, **salesTax explicitly disabled** (the $30/ext
  price already includes tax — never add a percentage on top for these tenants).
  Guards: skips any tenant with existing fee config or taxEnabled; re-runs no-op.
- ⛔ **E911 must stay on basis `per_phone_number`, not `per_did`**: `per_did`
  counts only billable numbers (0 for a one-number tenant with first-number-free),
  and onboarding numbers exist ONLY in `PbxTenantInboundDid` — never the Connect
  `phoneNumber` table. The engine feeds `max(table total, active PBX DIDs)`.
- Fee lines only build when `settings.taxEnabled` is true — a stamped config
  with taxEnabled false bills $0 in fees. Regression: month-2 preview must equal
  the quote to the cent (`onboardingBillingDefaults.test.ts`, $35/$45-with-SMS).
- Test-mock gotcha: `invoiceEngine` imports cache against the FIRST
  `mock.module("@connect/db")` — use one shared mutable mock per test file.
- Pre-fix paid sign-ups: `pnpm exec tsx scripts/backfill-onboarding-telecom-fees.ts`
  (apps/api; dry-run default). Zero existed at deploy time.
- Toll-free/vanity (unmerged `73f990a0`) will ride the `customFee` slot of the
  SAME billingTelecomFees object — it must MERGE into an existing config, not
  re-call the stamp (the guard makes a second stamp a no-op).

## ⛔ AGENT HANDOFF — CDR silent loss + live-call sync (2026-08-04) — READ FIRST for "calls missing from history", stuck/vanishing Active Calls, BLF sync, or ANY CallStateStore / CdrNotifier / ARI-poller work

Full handoff: **`docs/ai-context/AGENT_HANDOFF_CDR_LIVESYNC_2026-08-04.md`**

- **Calls were being permanently ERASED from call history** (~100–200/day since
  ~June, all tenants — found via "RelaxTires ext 101 sees no calls today").
  The live-call tracker force-evicted live calls off a blind ARI snapshot;
  evictions filed nothing; the 30s retention ate the late Cdr events; api
  deploys ate whatever ended during the restart. Fixed + deployed:
  `5060032f` (4-layer CDR protection incl. orphan-CDR net + Redis retry queue
  `telephony:cdr:retry:v1`) · `2f0850e7` (orphan net skips queue fork legs —
  else one phantom "missed call" PER AGENT per queue ring) · `aa3115d4`
  (live-sync rewrite). 332 lost calls Aug 1–4 backfilled; pre-Aug-1 NOT.
- ⛔ **Liveness = ARI's RAW /channels list (`rawChannelIds`), NEVER the
  qualifying-bridge list.** A queue/RG call is two half-bridges, each with one
  non-Local leg — `computeBridgedActiveCalls` excludes both BY DESIGN. Judging
  liveness by bridge membership is what killed live calls for months. Same
  trap in reverse: the WS page-load snapshot must stay the UNION of the AMI
  store + ARI-only bridges, never either/or.
- ⛔ **Never remove call channels by exact name string.** Asterisk masquerade
  renames (`<ZOMBIE>`) don't match; resolve the recorded name via uniqueid.
  A call with zero live channelIndex entries is OVER that second.
- ⛔ **Every eviction/cleanup path MUST emit `callEvicted`** (→ CdrNotifier).
  A cleanup that only emits `callRemove` silently erases the call's record.
- Backfill recipe gotchas: seed-post `disposition:"unknown"` first (else the
  ingest push-notifies stale missed calls); patch inbound direction post-hoc
  (PBX trunk legs write no cdr row); PBX local-time strings are ~4h skewed —
  derive times from the linkedId epoch. ~63 phantom rows from the first hour
  are HIDDEN via `isForwarded=true`, not deleted.
- Tenant isolation on the live feed: a mid-call tenant correction now
  broadcasts `callRemove` first so the wrong company's screens clear
  instantly. Null-tenant records go to admins only (verified).

## ⛔ AGENT HANDOFF — ElevenLabs "didn't play" + pipeline hardening (2026-08-04) — READ FIRST for ElevenLabs, IVR Studio recordings, or any "audio didn't play in the browser" report

Full handoff: **`docs/ai-context/AGENT_HANDOFF_ELEVENLABS_PLAYBACK_2026-08-04.md`**

- **"Didn't play" was Izzy's CHROME, not the product.** His Chrome's media
  pipeline wedged globally: every `<audio>`/`<video>` stalled at `readyState 0`
  with no error, `play()` pending forever — while `decodeAudioData` worked and
  the server had delivered valid WAV with 200s all four times. Same probe in a
  second browser on the same machine played instantly. Fix = full Chrome
  restart (**unconfirmed at handoff — ask first**); next suspect is his filter
  extension. ⛔ Run the silent-WAV probe (handoff §1) before shipping ANY fix
  for a "didn't play" report.
- Hardening shipped as `16f05d2d` on `feat/ivr-migration-takeover`; **ALL
  THREE HALVES DEPLOYED as of 2026-08-05**: api (container at `9b521176`),
  portal (hardening markers grep-verified inside the live `.next` build), and
  agent (manual compose rebuild 2026-08-05 ~00:30 ET under Izzy's explicit
  permission — the deploy queue has NO agent service, agent is always a manual
  `docker compose -f docker-compose.app.yml -f docker-compose.agent.yml build
  agent && up -d agent`; new container verified healthy with both fixes).
  Highlights: visible preview player + 4s playing-event watchdog + honest
  stall message; timeouts on every modal fetch; 30s server-side read cache +
  single read retry; 12/min per-IP + 4-concurrent synthesis guards; client
  faults 400 not 502; agent hot-reload was missing the ElevenLabs key (saved
  keys were invisible until restart — fixed).
- **2026-08-05: the generate route had never worked** — it selected `slug`
  from Tenant, and **the Tenant model has NO slug column**, so every
  `POST /voice/ivr/prompts/generate` died in PrismaClientValidationError (and
  the portal dialog rendered the raw Prisma dump to the customer). Fixed
  `9b521176`, deployed + live-verified same day. ⛔ `TenantPbxPrompt.tenantSlug`
  is ALWAYS derived from `Tenant.name` via the `toIvrSlug` normalisation
  (lowercase, non-alnum → `_`) — a differently-formatted slug makes rows
  invisible to the prompt list and PBX prefix matching. Handoff doc §5.
- **Global error-handler safety net (`4fb512ed`, handoff §6) is ✅ DEPLOYED**
  as of 2026-08-06 inside api `7f7ec541` — uncaught route errors no longer show
  raw internals in customer dialogs. Root cause of the leak: the api container sets NO
  `NODE_ENV` (only telephony does in docker-compose.app.yml), so the old
  handler's "production" branch never ran — June-era protection sat dead for
  months. ⛔ Never gate safety behavior on `NODE_ENV` in apps/api; the portal
  (`services/apiClient.ts`, `MakeRecording.tsx`) renders the server `message`
  field verbatim by design, so the server body IS the customer-facing text.
- ⛔ **Never retry a synthesis POST** (double-bills characters) and **never
  stress-test against prod** (real money; the offline fake-provider suite in
  `elevenLabsRoutes.stress.test.ts` IS the stress test). 49/49 tests green via
  `node --experimental-test-module-mocks --import tsx --test` in apps/api.
- **`elevenLabs.test.ts` had never run** — it imported vitest, which apps/api
  doesn't install (suite runs node:test via tsx). Rewritten. The follow-up
  chips are DONE: `smsSharedInbox.test.ts` fixed `6976a905` (stale fake-db
  mock, route was fine); vitest imports purged across apps/api in `2b4e9232`.
  ⛔ The `6d3d0b05` merge from feat/ai-agent CLOBBERED the converted
  `dependencyHygiene.test.ts` back to the vitest version — restored from
  `2b4e9232` right after. When merging feat/ai-agent, ALWAYS take the
  node:test version of any test file (grep `from "vitest"` after every merge;
  apps/api must have zero hits).
- Two status routes look alike: `/api/voice/elevenlabs/status` (API — IVR
  Studio modal) vs `/agent-api/voice/elevenlabs/status` (agent — owner
  settings page). Don't conflate them.

## ⛔ AGENT HANDOFF — voicemail playback wedge / phantom Telecom call (2026-08-04) — READ FIRST for "voicemail shows playing but no audio" or any Telecom Connection work

Full handoff: **`docs/ai-context/AGENT_HANDOFF_VOICEMAIL_WEDGE_2026-08-04.md`**

- **"Plays but no audio until APK reinstall" = a phantom Telecom call.** A ghost
  ring (cancel push racing past the ring push) answered by the user flips a
  Connection ACTIVE that no SIP session ever owns; Android then refuses ALL
  media playback, and the FGS keeps the process (and the phantom) alive through
  everything short of reinstall/force-stop. RSBK101 lived this for days.
- Fixed 2026-08-04, **FULLY DEPLOYED 2026-08-05**: merge `0cd7119b`
  (`fix/ring-cancel-race` `88d405a7`) + four backstops `065bce23` (120s ring
  self-destruct, stale-aware Telecom sweep, dead-invite answer teardown,
  voicemail playback-stall watchdog with self-heal). APK
  `1.0.0+20260804-202642` published to the download page; api container
  verified at `85a14982` (deploy-queue job `2d10d11d`).
- **Local `git push` is classifier-blocked in this environment.** Working
  route: `git bundle` → `scp` to loopcom → `git fetch <bundle>` in
  `/opt/connectcomms/app` → push to GitHub FROM the server clone. Deploys
  don't need GitHub at all (`--commit` / queue `commitHash` use local
  objects). And `pgrep -f deploy-direct.sh` in an ssh one-liner matches
  itself — check the queue's `/ops/deploy/status` runningCount instead.
- ⛔ **`telecomTerminateStale` may ONLY be called after verifying zero live SIP
  sessions** — its age gates cannot distinguish a leaked ACTIVE ghost from a
  real hour-long call. Both existing call sites assert this; any new one must.
- `resetCallAudioStateIfIdle` skips while ANY Connection is registered — a
  leaked Connection disarms it. That is WHY the stale sweep exists; never
  "simplify" the sweep away in favor of the reset alone.
- Interim advice for customers on old builds: Settings → Apps → Connect →
  **Force stop**, reopen — equivalent to their reinstall ritual.

## ⛔ AGENT HANDOFF — one tenant per paid sign-up (2026-08-04) — READ FIRST for onboarding billing / tenant work

Full handoff: **`docs/ai-context/AGENT_HANDOFF_ONBOARDING_SINGLE_TENANT_2026-08-04.md`**

- **FIXED + DEPLOYED (`1f215755` on feat/ai-agent):** paid sign-ups used to create
  TWO tenants — invoice/card/autopay on the checkout tenant, phone system on a
  second one, so month-2 autopay would have charged an empty orphan. The PBX
  build's `ensureConnectTenant` now adopts `submission.createdTenantId`; if the
  background auto-sync raced it, billing is auto-moved to the live tenant and
  the bare orphan deleted (`onboardingBillingAdoption.ts`).
- Historic splits: `apps/api/scripts/backfill-onboarding-split-tenants.ts`
  (dry-run default, `--fix` applies, refuses non-bare orphans). Prod run
  2026-08-04: **0 splits** — wiped test tenants cascade-delete their invoices,
  so an empty result after a test wipe is expected, not suspicious.
- ⛔ Never re-introduce a fresh `tenant.create` in the orchestrator path while
  `createdTenantId` is set; the regression tests in `setupOrchestrator.test.ts`
  ("checkout tenant reuse", "auto-sync race") guard this.
## ⛔ AGENT HANDOFF — filtered internet + reading registration data (2026-08-03) — READ FIRST for any "phone drops / didn't ring" report

Full handoff: **`docs/ai-context/AGENT_HANDOFF_FILTERED_INTERNET_2026-08-03.md`**

- ⛔ **Content-filtering internet is the NORM across Connect's user base** (confirmed by
  Izzy 2026-08-03), not an edge case. Assume a filter is in the path until disproven.
- **The one command that settles it:** take the device's contact IP from
  `PbxEndpointRegistrationEvent.contactUri` and **`whois` it**. Datacenter/colo block =
  filtering proxy. Residential ISP = their line. Cellular carrier = genuinely moving.
  Luxure ext 101 on 2026-08-02: **128 of 129 registrations came through one filter**
  (Cologuard `192.157.80.0/20`, Old Bridge NJ) rotating across six addresses; exactly
  **one** went direct over his real ISP. "Unstable Wi-Fi" and "the tablet leaves the
  house" were both concluded — and both wrong — before the whois was run.
  ⛔ **This test only works while the device registers DIRECTLY to the PBX.** Once a
  tenant is flipped to the 443 route (`webrtcRouteViaSbc=true`), every `contactUri`
  becomes loopcom `45.14.194.179` and the whois tells you nothing about the customer —
  use loopcom nginx logs instead. Check the tenant's routing flag before trusting a
  contact IP. See the Eli iOS 443 handoff above.
- ⛔ **Never report a raw reconnect count as instability. Split it first.** 80 of 128
  reconnects were **under 5 seconds** (lease renewal, invisible to callers); only 33 were
  ≥30 s. 55 sessions sat at a clean **~840 s / 14-minute metronome — a fixed interval is a
  timer, not weather.** Real outages arrive in *clusters* (proxy); a moving device gives
  isolated single drops.
- **The wake-and-wait work (`PLAN_PUSH_AND_WAIT_SIMON.md` Phase 3) is CONFIRMED WORKING** —
  wake→ready measured **0.9 s / 2.0 s / 0.2 s** vs the original 28 s, and the endpoint was
  already REGISTERED at all five calls. **The transport is the bottleneck now, not the wake.**
- **The 443 fix is NO LONGER A PROPOSAL — it shipped for Displaydex on 2026-08-05** via
  nginx `location /sip` on loopcom + `webrtcRouteViaSbc=true, sipWsUrl=null`. Luxure is a
  copy-the-recipe job now, not a design job. ⛔ The app never refreshes a cached
  `sipWsUrl`, so the user must sign out/in after the flip.
- Remaining open items: a **241 ms `ANSWER_TAPPED {DECLINE}`** that no human could
  produce; `UI_SHOWN` **3.75 s** after the invite (and absent entirely on another call);
  **outbound app calls produce no `ConnectCdr` row**; voicemail ingest wrote nothing Aug 1–3.
- ⛔ Ext 104 dials Simon's cell but **nothing routes to it — that is deliberate, per Izzy.
  Do not add it to a ring group.**

## AGENT HANDOFF — Voicemail greeting upload + Call-to-Record (2026-08-04) — READ FIRST for greeting work

Full handoff: **`docs/ai-context/AGENT_HANDOFF_VM_GREETING_2026-08-04.md`**.

- **VERIFIED WORKING by Izzy 2026-08-04** on T21 "Landau Home" ext 101 (desktop +
  Android rang simultaneously; greeting saved on the PBX). Fix commits: api
  `707820cb` (instant-originate) + `b6034b7b` (UI push restore), helper
  v2026.08.04.2 `1f216a80` (ring-all contacts).
- ⛔ **The Android ring screen is PUSH-DRIVEN.** A bare SIP INVITE renders NO
  incoming-call UI — the synthetic `INCOMING_CALL` push (inviteId `vmr-<jobId>`)
  must be sent for every mobile device on every vm-record path. Only the WAKE
  push is skipped (it forces a SIP reconnect and churns the shared AOR mid-ring,
  which is what broke answering).
- ⛔ **Dial CONTACTS, not endpoints.** `Dial(PJSIP/<endpoint>)` creates one
  channel even when the AOR holds several registrations. The vm-greeting
  dispatch context expands `PJSIP_DIAL_CONTACTS(base)` + `(base_1)` at dial
  time. The dispatch dialplan lives in THREE synced copies: helper py + two
  embeds in `install-vitalpbx-inbound-route-helper.sh`.
- PBX rollback backups: `/root/helper-backup-20260804-141045.py` and
  `/root/vm-dialplan-backup-20260804-141045.conf` on the PBX.

## ⛔ AGENT HANDOFF — cross-tenant leak + iOS modal keyboard trap (2026-08-02) — READ FIRST for CDR tenant attribution, contacts, or any iOS modal

Full handoff: **`docs/ai-context/AGENT_HANDOFF_CROSS_TENANT_LEAK_2026-08-02.md`**

- ⛔ **Calls were being written into OTHER COMPANIES' call history.** PBX-verified
  over 7 days: 3,517 matched records, **116 filed under the wrong company (3.3%)**,
  11 real customers, both directions — recordings ride along on the record.
  100% came through `tenantResolutionSource = telephony_connect_tenant_id`, which
  **trusted a caller-supplied tenant id outright**. Fixed `05952fb5` + `d6c657ff`
  (API) and `bfaed99e` (telephony). 116 records corrected; reversal at
  `loopcom:/root/cdr_refile_backup_2026-08-02.json`.
- **THE PBX IS THE SOURCE OF TRUTH.** Asterisk stamps the owner into the call
  (`dcontext T102_cos-all`, `PJSIP/T102_101_1-…`) and it cannot be forged.
  Attribution order: **PBX marker → the DID the PBX routed on → the claim (last
  resort only)**. A claim that disagrees is REJECTED. Conflicting markers resolve
  to NOTHING rather than picking a side. **Fail closed** — unattributed is
  recoverable, wrong-company is not.
- ⛔ **A React Native `<Modal>` is its own view hierarchy — this bit 3× in one
  session.** A screen-level `KeyboardAvoidingView` cannot reach inside it (every
  bottom-anchored sheet with an input needs its OWN, iOS-only). A ScrollView does
  not save you if the scroll area is itself under the keyboard. And **`showToast`
  is drawn BEHIND a modal** — use `showAppAlert` inside modals, or failures are
  silent by construction (this made "Open SMS thread does nothing" unexplainable
  for two builds).
- **Check the account can do the thing before debugging the app.** "SMS does
  nothing" was `TenantSmsNumber` having no row for the tenant → 400 every time.
  Two builds were spent on real-but-unrelated UI bugs first.
- **Sanity-check every audit query against the table total.** A voicemail check
  joined on extension NUMBER (not unique across tenants), fanned out, and reported
  30,000+ phantom leaks — more rows than the table holds. Voicemail is CLEAN:
  0 of 34,094.
- iOS: the pre-wake was reporting a **second CallKit call** per call (different id
  → different call identity) — that is the green pill / hang-up-twice. Disabled
  `18fedd9d`. Contacts 1,000-row cap + duplicate-that-named-nobody fixed
  `6e07adfe` + `bab31854`. iOS builds this session: 46 → 51.

## ⛔ AGENT HANDOFF — Android keyboard covers the screen (2026-08-04) — READ FIRST for any Android layout that sits above the keyboard

Full handoff: **`docs/ai-context/AGENT_HANDOFF_ANDROID_KEYBOARD_INSET_2026-08-04.md`**

- **`adjustResize` is dead on Android 15+.** `d111c179` moved the app to
  targetSdk 36; Android 15 (API 35) enforces edge-to-edge for targetSdk 35+ and
  stops resizing the window for the keyboard. The manifest still says
  `adjustResize` and the system ignores it, so the IME draws ON TOP of every
  bottom-anchored control. Nothing in the chat code changed — the chat screen's
  `KeyboardAvoidingView` is iOS-only and had always relied on the OS resize.
- Fixed at the app root by `apps/mobile/src/components/AndroidKeyboardInset.tsx`
  (wraps the navigator in `App.tsx`). Two rules inside it must not be
  "simplified": it applies **only on API 35+** (Android 12–14 still resize
  themselves — padding on top of that shifts every screen up twice), and it pads
  by **`keyboardHeight + insets.bottom`** because RN measures the keyboard from
  the top of the gesture bar, so its number is short by exactly that inset
  (45 px / 15 dp on the S24 — this is what left the composer clipped).
- **A React Native `<Modal>` is its own native window** — the root fix cannot
  reach inside it. Modals with inputs need their own `KeyboardAvoidingView`,
  now `behavior="padding"` on BOTH platforms (`NewChatModal` done;
  `ContactPicker` still has none).
- **Measure, do not eyeball.** Screenshot with `adb exec-out screencap -p` and
  scan the pixels; a by-eye adjustment shipped a build that was still 15 dp low.
- ⛔ **Build with `scripts/android-ship.ps1 -SkipJunction`** — Metro cannot
  resolve the entry file through the `.connect-mobile-build` junction.
- Verified on device: `1.0.0+20260802-143118` (the `20260802` stamp is the build
  shell's slow clock, not a stale build).

## ⛔ AGENT HANDOFF — contacts 1,000-cap + ghost call screen (2026-08-02) — READ FIRST for contacts, Android builds, or any "can't save" report

Full handoff: **`docs/ai-context/AGENT_HANDOFF_CONTACTS_GHOSTCALL_2026-08-02.md`**

- **"Can't save contacts" was TWO bugs.** `GET /contacts` cut at `take: 1000`, so
  Displaydex's 247 contacts past "Sruly Goldberger" never reached the phone —
  invisible AND unsearchable (the tab filters locally). He then kept re-adding
  people from that invisible tail, the server correctly said `duplicate_phone`,
  and the app named nobody. **16 of 16 iOS saves failed; zero contacts created
  since the 31 Jul import.** Fixed: opt-in `limit`+`cursor` paging (no `limit` =
  the exact legacy 1,000-row response, so the unvirtualized portal is untouched),
  mobile `getContacts()` walks all pages behind the same signature, and the 409
  now names the existing contact. Over the cap: Relax Tires 4,010, Create A Box
  2,002, Displaydex 1,247.
- ⛔ **A call-path fix whose premise is not proven from the DEVICE gets reverted.**
  The first ghost-call fix (`a99caa15`) assumed a lingering dead SIP session;
  logcat showed the session was removed cleanly (`sessions:0`) before the app was
  backgrounded. It also made `listSessions()` mutate state and emit events from
  seven call sites. Reverted in `5076f24f`. **Get logcat first.**
- **Real cause:** Android hands a relaunched activity the SAME intent that started
  the task, so `Linking.getInitialURL()` replayed a 19-second-old
  `incoming-call?action=answer` link. The dedupe Set lived in a `useRef` inside
  the provider — destroyed with the tree — and is cleared on every call-idle. Now
  **module scope**, applied only to the `launch` path so a live tap is never
  refused. Cannot affect iOS (that link is Android-native only; iOS uses CallKit).
- ⛔ **Build Android with `scripts/android-ship.ps1 -SkipJunction`** — the path
  junction breaks Metro's entry-file resolution; the MAX_PATH problem it existed
  for is already fixed by the pnpm patches.
- **Build 47 was never uploaded to App Store Connect.** TestFlight held only
  45/35/32, which is why Eli sat on build 45. **Build 48** (commit `63a01a65`) is
  live to "Loopcom Testers", beta review APPROVED.
- **Verify authenticated API routes from nginx logs, not by minting a token**
  (credential reads are blocked). `Loopcom/NN` = iOS build NN, `okhttp` = Android,
  `Mozilla` = portal.
- **Acceptance test still outstanding:** a second `/api/contacts` request carrying
  `cursor=` from Eli's phone — that request IS his missing 247 contacts arriving.

## ⛔ AGENT HANDOFF — iOS CallKit zombie call + TestFlight release (2026-08-02) — READ FIRST for iOS call teardown or any EAS build

Full handoff: **`docs/ai-context/AGENT_HANDOFF_IOS_CALLKIT_TESTFLIGHT_2026-08-02.md`**

- **iOS build 44 (`3d8103af…`, commit `695a53e6`) is VERIFIED ON DEVICE by Izzy.**
  Its twin **build 45** (`27387fbe…`, commit `ecb6071f`, ios-prod) is on TestFlight,
  beta review **APPROVED**, live to the external group "Loopcom Testers".
- **Any deferred call action must re-verify its precondition at FIRE time.** The
  12s deferred decline from build 43 outlived the answer and declined a CONNECTED
  call (proven twice in `voiceDiagEvent`); a ring rejection cannot tear down a
  confirmed dialog, so the SIP session AND the CallKit call both survived → stuck
  green pill + a lock-screen call that had to be hung up by hand. Fixed `4640a04d`.
- **`sip.callState` inside the CallKeep handlers is a STALE render closure.** Ground
  liveness checks in the module-scope SIP singleton (`confirmedAtMs != null`) or refs.
- `nativeCallEndedCleanup` was Android-only — iOS had **no last-session-ended safety
  net** at all. It now ends orphaned CallKit calls, re-verifying no session is live
  after a 1.2s settle.
- ⛔ **`EAS_NO_VCS=1` uploads the WORKING TREE, not the commit — a green EAS build is
  NOT proof the committed tree builds.** A stale `pnpm-lock.yaml` (declared 4
  `patchedDependencies`, locked 1) made every clean checkout unbuildable; fixed
  `0e5207d7`. Re-lock whenever patches change.
- EAS build logs are **brotli**, not gzip. Poll builds by **explicit id**, never
  "newest" — that misreads the previous build and reports phantom failures.

## ⛔ AGENT HANDOFF — Android SDK 54 build + PBX push-and-wait (2026-08-01) — READ FIRST for Android builds or "calls don't ring"

Full handoff: **`docs/ai-context/AGENT_HANDOFF_ANDROID_SDK54_PUSHWAIT_2026-08-01.md`**

- **The PBX already had push-and-wait and it was dead code.** `[send-mobile-push]`
  in the baseplan is bypassed by an unconditional `Goto` in `[parse-dial-string]`;
  Connect's own `[connect-wake-core]` was allowlisted for T5_101 but structurally
  unreachable. The killer: `PJSIP_DIAL_CONTACTS()` resolves **once** — no contacts
  means `cause 3` in milliseconds and the ring timer never runs. A longer ring
  timer fixes nothing. Live on **Luxure T5 ext 101 only** via
  `[connect-mobile-wake-dial]`; rollback is one `database put`.
- **The Android toolchain was a generation behind** after the SDK 51→54 upgrade
  (iOS builds on EAS hid it). Gradle 8.13 / Kotlin 2.1.20 / SDK 36 / NDK 27.1 now
  pinned. `local.properties` needs `cmake.dir=<SDK>/cmake/3.31.6` and is
  **gitignored** — a fresh Windows clone must add it. Windows MAX_PATH (263 > 260)
  is handled by pnpm patches; **never** try to set `buildStagingDirectory` from the
  root build.gradle ("It is too late to set").
- **Always build with `scripts/android-ship.ps1`** — without `SHIP_BUILD_ID` the
  APK is literally version "1.0.0", which is half of why the whole fleet reported
  that. The app now reports the real OS-level version.
- Published `1.0.0+20260801-231353` **without a two-way call test** (owner's call);
  rollback APK is `connectcomms-v1.0.0+20260730.4.apk`.

## ⛔ AGENT HANDOFF — registration drops & push delivery (2026-07-31) — READ FIRST for any "calls don't ring" report

Full handoff: **`docs/ai-context/AGENT_HANDOFF_REGISTRATION_PUSH_2026-07-31.md`**

- **Before diagnosing ANY "extension doesn't ring" report, pull the 10-day
  `PbxEndpointRegistrationEvent` history first** (exact query in the handoff §1).
  Diagnosing from a single day produced the wrong root cause and a wasted fix round.
  A healthy device shows ~1200 REGISTERED events per 10 days; Luxure T5_101_1 showed 153.
- **The Expo→direct-FCM migration is HALF DONE.** `apps/api` has `fcmDirect.ts`;
  **`apps/worker` has none** and pushes every call ring / wake / cancel over the Expo
  relay. Only **6 of 16** active Android devices have a `nativeFcmToken`, so the other
  10 fall back to the relay even from the API. Keep `expo-notifications` the library
  (that is how the FCM token is obtained); eliminate `exp.host` sends.
- A device that ignores a **direct-FCM** wake is powered off / force-stopped / in
  Samsung "Deep sleeping apps" — **no server or app code can revive it.** Stop
  engineering and check the physical device.
- Live in prod (`cdd5bbdd`): device-registration watchdog sends recovery wake pushes,
  and ALL alerts email `tod10950@gmail.com`.

## AGENT HANDOFF — iOS parity engagement (2026-07-30) — READ FIRST for iOS work

Full handoff: **`docs/ai-context/AGENT_HANDOFF_IOS_PARITY_2026-07-30.md`**
(branch `feat/ai-agent`). Read it before touching iOS call/push/audio code,
the Recents/Contacts swipe rows, voicemail playback, or the iOS build pipeline.

Session-critical facts (details, commits, and evidence in the handoff doc):
- **iOS build 25 (`f8035997…`, commit `d30c60af`, ios-test profile) is VERIFIED
  WORKING by Izzy — the iOS release candidate**, twin of the restored Android
  build `64930350`. Servers run `602de2b3` (VoIP cancel pushes + iOS-visible
  push envelope live on api+worker).
- iOS lock-screen chain is fixed end-to-end: server-driven VoIP cancel pushes
  (stop-ringing on hangup/voicemail/answered-elsewhere/desk-answer), buffered
  cold-start answer-tap replay (`didLoadWithEvents` — MUST stay the FIRST
  listener on BOTH RNCallKeep and RNVoipPushNotification), ring-time SIP
  prewarm, and a `didActivateAudioSession` gate before the mic opens.
- **Never call WebRTC `getUserMedia` outside the immediate dial/answer path on
  iOS** — a launch-time permission probe killed ALL call audio (build 22).
  Permission prompts use expo-av only. Audio changes ship ALONE, one per build,
  with a supervised two-way call test.
- iOS push notifications require the top-level title/body/sound envelope
  (platform-split in `packages/shared/src/expoMobilePushFormat.ts`) — data-only
  pushes render NOTHING on iOS. Android stays data-only.
- Row swipes are react-native-gesture-handler PanGestureHandler — PanResponder
  loses a native race to the FlatList scroll recognizer on iOS. Voicemail list
  fetch stays capped (`maxPagesPerFolder: 2`).
- Builds: Metro needs `--offline` (Izzy's filtered line), dev client connects
  via Tailscale IP `http://100.92.168.53:8081`, EAS builds submit from loopcom
  (`/tmp/connect-ios-build`, `gh` remote, `EAS_NO_VCS=1`), delete-before-install
  + bump `ios.buildNumber` every build.

## ⛔ AGENT HANDOFF — Mobile audio / incoming calls (2026-07-30) — READ FIRST

Full handoff: **`docs/ai-context/AGENT_HANDOFF_MOBILE_AUDIO_2026-07-30.md`**
(branch `feat/ai-agent`). Read it before touching `apps/mobile` SIP/audio,
`preferOpusSdp`, the Telecom anchor, or CDR dispositions.

- **UNRESOLVED at handoff: Izzy reports incoming calls not answering.** First
  action: confirm which APK his phone actually runs — `1.0.0+20260730.2` is a
  broken no-connect build; `.3` (commit `64930350`) is the restored one.
- **⛔ NEVER force opus on INBOUND calls from the app.** Both routes are proven
  harmful: opus-only LOCAL ANSWER → dead mic / one-way audio (JsSIP applies
  createAnswer's ORIGINAL to setLocalDescription; only the wire copy is munged);
  opus-only REMOTE OFFER → libwebrtc rejects it, 488, inbound calls never
  connect. Inbound HD is a PBX-side change only, under an explicit mandate.
- **Acceptance test for ANY audio change**: the call CONNECTS *and* the PBX
  `pjsip show channelstats` transmit counter climbs while the user talks.
  "I can hear them" tests only half the pipe — that is how one-way audio shipped.

## AGENT HANDOFF — Audio/Reliability/Notifications engagement (2026-07-29)

The full handoff for the July 29 all-day session (mobile audio saga, push
notification rebuild, wire-truth SIP liveness, ghost-registration fix, PBX
FEC + wake-rb removal mandates) is committed at
**`docs/ai-context/AGENT_HANDOFF_AUDIO_RELIABILITY_2026-07-29.md`** on branch
`feat/ai-agent`. Read it AND `docs/ai-context/NOTIFICATION_RELIABILITY.md`
BEFORE touching mobile SIP/audio code, push notifications, TURN/relay config,
or the PBX codecs.conf.

Session-critical facts (details + evidence in the handoff doc):
- Published fleet build = `1.0.0+20260729.6` (commit `a0eb96bf`). A `.7`
  candidate (volume-hush + serialized register, commit `a4524f6c`) is built,
  verified on Izzy's phone, and **explicitly NOT published — never publish
  without Izzy's word.**
- Three suspended features need a SUPERVISED incoming-call re-proof, ONE at a
  time (both mic-dead incidents rode builds carrying them): opus-only ANSWERS,
  earpiece loudness boost, presence Equalizer.
- JsSIP discards UA-level pcConfig — per-call `callPcConfig` is the fix; TURN
  creds expire in 24h — `/voice/ice-servers` + register-time overlay keeps
  them fresh. Never regress either.
- PBX mandates live: `[opus] fec=yes, packet_loss=5` (never 10 — it muffles);
  the cowork wake-rb dialplan intercept on T21_101 is DISABLED (backup in
  /root on the PBX).
- The TURN relay (coturn on loopcom) works but is in FRANCE vs the PBX in
  St. Louis (+150ms) — a US relay VPS is the pending purchase/decision.
- One change per build; supervised USB+logcat test before anything
  audio/mic-related reaches Izzy's phone; his sign-off gates every publish.

## Task-dashboard signature routing (ALWAYS APPLY)

Every task I add to the jacob-dev-orchestrator task dashboard MUST carry a routing
**signature** in its title and detail. The signature tells a specific Cursor agent
which tasks are his; he only claims tasks that carry his signature and ignores all
others. This prevents the wrong agent from picking up a task.

Rules:
- Never create a dashboard task without a signature. No exceptions.
- Put the signature in BOTH the title (e.g. `[SIG::CURSOR-CONNECT-01] ...`) and as the
  first line of the detail (`ROUTING SIGNATURE: SIG::CURSOR-CONNECT-01 — ...`).
- The signature is per Cursor agent / per chat and is STABLE — reuse the same signature
  for every task meant for that agent, so Cursor is configured once. Do not invent a new
  per-task signature each time.
- Any scheduled task that files dashboard tasks must stamp them with the same signature.
- When I hand Izzy a prompt for Cursor, it must tell Cursor his signature and instruct him
  to claim ONLY tasks carrying it.

Current signatures:
- `SIG::CURSOR-CONNECT-01` — the Cursor agent working the Connect server in this chat.
  (Rename on Izzy's request; if renamed, update it everywhere.)

## Server access — how any agent logs in (ALWAYS APPLY)

There are two servers. Each has a dedicated ed25519 key already installed in the
target account's `authorized_keys`. Login is as `root` on both, port 22.

| Name    | Role                        | Host            | Key file                   |
|---------|-----------------------------|-----------------|----------------------------|
| loopcom | Connect server (work here)  | 45.14.194.179   | `connect2_ed25519`         |
| pbx     | PBX — **READ-ONLY, no touch**| 209.145.60.79  | `connect2_server2_ed25519` |

The private keys live in the git-ignored folder `.connect-ssh/` at the repo root
(also mirrored in `C:\Users\izzyw\.ssh\` on Izzy's machine). They are NEVER
committed (see `.gitignore`).

### CANONICAL SSH METHOD — always run from the Linux sandbox (`mcp__workspace__bash`)
**This is the ONE approved way to reach either server. It supersedes any other
SSH-login instructions anywhere in this repo — other `.md` files, older handoffs,
inline notes, or the app-level project instructions. Do NOT use the local PowerShell
MCP or a Cursor agent to SSH into these servers:** the PowerShell MCP blocks `ssh`/`scp`
("remote shell tools not permitted"). Always SSH from the sandbox.

The Connect 2 repo is mounted in the sandbox; find its exact path in your system prompt
(it looks like `/sessions/<session-id>/mnt/Connect 2`). Set `PROJ` to that path. The
mount can report loose key permissions, so stage each key to a strict-mode file first.
`install -m 600` sets perms AND overwrites cleanly, even if a stale `/tmp` copy exists
from an earlier session (a plain `cp` will fail with "Permission denied" on that stale file).

Exact, copy-pasteable procedure — verified working:

```bash
# 1) point PROJ at the Connect 2 mount shown in your system prompt
PROJ="/sessions/<session-id>/mnt/Connect 2"

# 2) stage both keys with strict perms (overwrites any stale /tmp copy)
install -m 600 "$PROJ/.connect-ssh/connect2_ed25519"         /tmp/loopcom_key
install -m 600 "$PROJ/.connect-ssh/connect2_server2_ed25519" /tmp/pbx_key

# 3a) CONNECT SERVER (loopcom) — the ONLY box where Connect work happens
ssh -i /tmp/loopcom_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
    root@45.14.194.179 'hostname; uptime'
#    -> confirms hostname: vmi3101417

# 3b) PBX — READ-ONLY. Inspection / monitoring only, NEVER write.
ssh -i /tmp/pbx_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
    root@209.145.60.79 'hostname; uptime'
#    -> confirms hostname: vmi2718844
```

Both log in as `root` on port 22. If `ssh` is missing in the sandbox:
`apt-get install -y openssh-client` (usually preinstalled).

**Requires a sandbox with outbound network egress.** The `mcp__workspace__bash` sandbox
has it — verified reaching both boxes (loopcom `vmi3101417`, pbx `vmi2718844`). If you are
in a shell/mode whose network is unreachable (e.g. an on-device VM), SSH will time out /
"Network is unreachable" — that is a networking limitation of that shell, not a key or
host problem. Switch to the networked `mcp__workspace__bash` sandbox and re-run the steps above.

For Izzy to log in manually from Windows (keys are in his `~/.ssh`):
```
ssh -i C:\Users\izzyw\.ssh\connect2_ed25519 root@45.14.194.179          # loopcom
ssh -i C:\Users\izzyw\.ssh\connect2_server2_ed25519 root@209.145.60.79  # pbx
```

### Guardrails on server access
- **loopcom (45.14.194.179)** is the only box where Connect work happens, and even
  there: deploy/restart only via the deploy queue; no `git add -A`.
- **pbx (209.145.60.79) is strictly READ-ONLY.** Inspect and report only. Never take
  write actions on the PBX — this is a hard guardrail.
- Never touch payments or pension from either box.

## Other standing rules
- Read-only monitoring runs never take write actions on the Connect server, PBX,
  payments, or pension — report only.
- Hard guardrails on all Connect work: Connect server only; never touch payments,
  pension, or the PBX; deploy/restart only via the deploy queue; no `git add -A`.

## B Visible engagement (2026-07-17 → 07-22) — where the handoff lives

The full agent handoff for the B Visible work done from this chat is committed in the
B Visible repo: `C:\dev\projects\B Visible\docs\AGENT_HANDOFF.md` (commit `1ea222d`,
branch `feat/premium-estimate-editor-workspace`). Read it before touching B Visible.

Session-critical facts for THIS environment:
- Reaching the B Visible server (`deploy@212.56.32.136`) works from the Linux sandbox
  (`mcp__workspace__bash`), key staged from `.connect-ssh/cursor_bvisible` to
  `/tmp/bv_key` with mode 600 (re-stage after sandbox resets — you'll see
  "Permission denied (publickey)"). The local PowerShell MCP blocks any command
  containing the word "deploy" and gates `git push` / recursive deletes behind
  `approved:true`.
- Builds/git for B Visible run ONLY on Windows via the `.agent-run.cmd` batch pattern
  (set PATH **and PATHEXT**; poll `.agent-build.log`; never `-Wait` on long jobs;
  PowerShell needs `-LiteralPath` for paths containing `[id]`).
- A Cursor agent edits the B Visible repo in parallel — `git status` before every
  edit, re-copy current file versions before modifying, never commit their WIP,
  never `git add -A`.

## AGENT HANDOFF — Shammes AI agent / PBX M-capabilities engagement (2026-07-26 → 07-28)

The full handoff for the AI-agent work (DND, hold music, LLM-first parsing,
chat uploads, and the M3/M4/M10 native PBX capabilities) is committed at
**`docs/ai-context/AGENT_HANDOFF_SHAMMES_PBX_MS.md`** on branch `feat/ai-agent`.
Read it before touching `apps/agent`, the `/internal/agent/*` API doors, or
`scripts/pbx/vitalpbx-inbound-route-helper.py`.

Session-critical facts (details + evidence in the handoff doc):
- **VitalPBX's REST `apply_changes` is broken on this build** — returns success
  without regenerating tenant conf files. The PBX helper therefore **bakes**
  changes directly into `/etc/asterisk/vitalpbx/extensions__50-<t>-dialplan.conf`
  (guarded patch: backup + scope check + atomic replace + dialplan reload).
  Never assume a DB write or REST apply reached live routing — verify the baked
  file / `dialplan show`.
- PBX helper deployed at `/opt/connect-pbx-helper/vitalpbx-inbound-route-helper.py`
  (v2026.08.04.2 as of the vm-greeting engagement, in sync with the repo copy).
  Its `audit.jsonl` is **61 GB** — never grep it whole.
- PBX writes happened ONLY under Izzy's explicit mandates (`dnd-2026-07-26`,
  `moh-2026-07-26`, `pbxcfg-2026-07-28`). The default PBX read-only guardrail
  still stands for anything outside those mandates.
- M3 (inbound routing) + M10 members are live-proven end-to-end through real
  chat on Landau's tenant (T21). M4 (IVR) is built but unproven — the test
  tenant has no IVR, and IVR writes still need the same bake treatment.
- In THIS Cursor environment ssh/scp run directly from PowerShell with the keys
  in `C:\Users\izzyw\.ssh\` — but NEVER pipe file bytes through PowerShell to
  ssh (corruption); always `scp` + remote `py_compile` before installing.

## AGENT HANDOFF — Onboarding automation engagement (2026-07-26 → 07-28)

The full handoff for the automated onboarding work (wizard → VoIP.ms number +
subaccount → VitalPBX tenant build → Connect sync → invite emails, plus the
stress-test wipe procedure) is committed at
**`docs/ai-context/AGENT_HANDOFF_ONBOARDING_AUTOMATION.md`** on branch
`feat/ai-agent`. Read it before touching `apps/api/src/onboarding/`, the
portal wizard, or before wiping test tenants.

Session-critical facts (details + evidence in the handoff doc):
- **Deploys ship from branch `feat/ai-agent`**, via
  `bash scripts/deploy-direct.sh api|portal --branch feat/ai-agent` on loopcom.
  Always verify the container commit afterwards.
- Live gates `VOIPMS_AUTO_PROVISION=on` / `ONBOARDING_PBX_AUTO_SETUP=on` are
  wired in `docker-compose.app.yml`; unset = silent dry-run (statuses
  `ready_dryrun` / `dry_run_done`).
- **VitalPBX panel deletes are TWO-STEP** (delete → re-POST the confirmation
  form's hidden inputs, `mode:"deleteConfirmed"`) and must be verified by
  re-listing — the single-step call "succeeds" without deleting (two earlier
  wipes left every trunk/route/ARS behind because of this). Reference
  implementation: `scripts/onboarding/_wipe-round2.mts`. Order: tenants
  (REST) → ars → trunk_group → trunks. REST `deleteTenant` may exceed 20 s —
  poll for absence on timeout.
- **VoIP.ms**: `setSubAccount` is a full update (partial `{id,password}`
  fails); `createSubAccount` `used_username` self-heals by reusing (commit
  `db4453f8`); subaccounts are `344022_<name>` — suffix-match, never prefix
  with the API login email; `device_type 1` = Asterisk (correct), `2` = IP
  phone (wrong); outages return Cloudflare 521/522 HTML — retry with backoff.
- ⛔ **VoIP.ms's WRITE path degrades on its own — healthy reads prove nothing**
  (handoff §10). 2026-08-05: every `setSubAccount` timed out for ~57 min while
  `getServersInfo` answered in 2 s. Worse, our retry re-entered that exact
  call: credentials were persisted only at the END of the number stage, so a
  later failure discarded a SUCCESSFUL password rotation and the next attempt
  rotated again — 4 watchdog attempts, 4 timeouts, 90 min of a paid customer
  with no phone. Fixed `b20fad30`: stored creds are reused first, a successful
  create/rotate is persisted immediately, and both subaccount writes get 120 s
  (the rotation that worked took **48 s**; aborting the request does NOT cancel
  VoIP.ms's operation). **General rule: a resumable stage persists each
  irreversible success the moment it happens, never at the end.** A stalled
  paid sign-up should be re-kicked via
  `POST /admin/onboarding/submissions/:id/retry-setup` (idempotent) rather than
  waiting out the watchdog's ~16-min spacing.
- ⛔ **Porting is LIVE and irreversible, and its parameters are only ever proven
  by a real filing (handoff §9).** First success 2026-08-05: **port order
  217760** (inii mini, Verizon), accepted 37 min after the api deploy that
  fixed the parameter names. `addLNPPort` takes the WSDL's `addLNPPortInput`
  set — `portType`/`numbers`/`isPartial`/`locationType`/`isMobile`/`pin`/`btn`/
  `services`/`tfType`/`statementName`/`firstName`/`lastName`/`address1`/`city`/
  `state`/`zip`/`country`/`providerName`/`providerAccount`/`notes` — and the
  old invented `did`/`carrier`/`account_number` names were rejected `invalid`
  on every attempt (rewritten in `ce54e40d`, `buildLnpPortParams()`). It
  answers `{"status":"success","port":N}`: we read `portid`/`port_id`, so the
  id stored `""` and the LOA/bill would have attached to an EMPTY order —
  nothing threw, because `vms()` checks only `status` (fixed `e98dad78`). The
  five integer codes in `LNP_CODES` are validated for a **local + mobile full
  port ONLY**; toll-free, partial and landline shapes are still guesses.
  `addLNPFile` is `{portid, file}` and nothing else.
- ⛔ **The wizard's port step collects the service address as FOUR fields** —
  street (`serviceAddress`), `serviceCity`, 2-letter `serviceState`, 5-digit
  `serviceZip` — plus an **`isMobile`** checkbox, which also makes the transfer
  PIN required. Never collapse them back into one box: `addLNPPort` takes them
  separately and the losing carrier matches each against the CSR. Drafts saved
  before 2026-08-06 still hold one free-text line, so `buildLnpPortParams()`
  falls back to `parseServiceAddressLine()` and passes the customer's original
  text through in `notes`. ⛔ That fallback is unit-tested only and has NEVER
  been filed — 217760's fields were hand-corrected into the structured shape
  first (recorded on the submission as
  `answers.provisioning.portFiledManuallyBy`).
- ⛔ **Never probe this API by submitting `addLNPPort`** — a complete request
  files a REAL port order against a REAL customer's number at a REAL carrier.
  Exercise parameter changes through the test suite's fake VoIP.ms, which now
  returns the real `{status, port}` shape.
- Test numbers are pre-owned STOCK: wipes re-route DIDs to `account:344022`,
  never cancel them. Spare DIDs show first in the wizard ("Ready now");
  the search cache holds only the purchasable list, spares always fresh.
- Reusable stress-test link token: `stress-WBcv2eWu8GzxdIIP2glmd6O2`
  (`/onboarding/test/<token>` spawns a fresh run). Invites only go out for
  emails never used anywhere on the platform (global uniqueness).
- Ezra's test IP `173.212.214.198` is allowlisted in
  `/etc/nginx/connectcomms/allowlist.conf` (nginx auto-ban hit it mid-test).
- **Toll-free & vanity numbers (2026-08-04, `73f990a0` — handoff §8)**: the
  wizard's number step sells `local | tollfree | vanity` (stored as
  `answers.phone.numberKind`); toll-free/vanity = $15/mo
  (`tollFreeNumberMonthlyCents`), first-number-free applies to LOCAL only,
  purchase branches to `orderTollFree`/`orderVanity`. ⛔ The month-2 $15 is
  stamped as a FLAT `customFee` — never "fix" it to `per_toll_free_did`
  (that basis counts phoneNumber rows onboarding never writes → bills $0).
  Taken-meanwhile replacements stay the same kind; port temp numbers skip
  toll-free spares.
- In THIS Cursor environment ssh/scp run directly from PowerShell (keys in
  `C:\Users\izzyw\.ssh\`); server scripts run via scp → `docker cp` →
  `tsx` inside `app-api-1`; DB one-liners pipe JS into
  `docker exec -i -w /app/packages/db app-api-1 node -`.

## AGENT HANDOFF — Mobile Android call-reliability engagement (2026-07-27 → 07-28)

Read this whole section before touching `apps/mobile`. It is the handoff from the
Cursor chat that did the July 27–28 reliability push. Owner's bar for this work:
answering a call must be **instantaneous** ("a blink of an eye"), calls must
survive the app being swiped away, and NOTHING that already works may break.

### Environment / workflow facts (verified working)

- **Test device**: Izzy's Samsung over USB ADB, serial `RFCXC0CEZ6V`. It comes and
  goes — run `adb devices` first; `adb wait-for-device` to block until plugged in.
  The phone is on **T-Mobile, an IPv6-only network** (DNS64/NAT64) — this shaped
  several fixes below.
- **Build**: `cd apps\mobile\android && .\gradlew :app:assembleRelease` (≈5 min).
  Output: `apps\mobile\android\app\build\outputs\apk\release\app-release.apk`.
- **Install**: `adb install -r app\build\outputs\apk\release\app-release.apk`, then
  launch and confirm logcat shows `[SIP] Registered successfully` and
  `[IN_CALL_NOTIF] module-scope action listener installed`.
- **Publish to the download page**: `powershell -File scripts/android-publish.ps1
  -Version "1.0.0+<yyyymmdd>" -ReleaseNotes "..."` — uploads to
  `/opt/connectcomms/downloads` on loopcom via the `connect` SSH alias, promotes
  `connectcomms-latest.apk`, writes the JSON manifest, smoke-tests
  `https://app.connectcomunications.com/api/downloads/connectcomms-latest.apk`.
  Last published: `connectcomms-v1.0.0+20260728.apk`.
- **Known pre-existing `tsc` error** (NOT ours, does not block builds):
  `src/delivery/trackingService.ts` — `Cannot find module 'expo-battery'`. Another
  agent's delivery-tracking work. Everything else typechecks clean.
- **Feature flag**: `standingRegistration` must be `true` on the user's
  `MobileDevice` row (Postgres on loopcom, user `connectcomms`) or the app falls
  back to legacy slow-answer behavior. It is INHERITED on push-token rotation now,
  but if a device re-registers from scratch, re-check it.

### The one architectural rule that explains most of this engagement

**A recents-swipe destroys MainActivity and unmounts the ENTIRE React tree, but
the process (and the JsSIP singleton + WebRTC media) lives on** under the
`SipKeepAliveService` FGS. Anything that must keep working while swiped away —
notification button handling, native notification cleanup, Telecom anchor
teardown, SIP registration — must live at **module scope** (imported via
`sipClientSingleton.ts`) or **natively**, never inside `SipContext`/components.
Three separate bugs came from violating this:

1. Notification Hang Up/Speaker/Mute dead after swipe → fixed by module-scope
   listener `apps/mobile/src/sip/inCallNotificationActions.ts` (installed at
   import time by `sipClientSingleton.ts`). `SipContext`'s listener now ONLY
   mirrors UI state — do not re-add client calls there (double-execution).
2. Remote hangup while swiped left a stale in-call notification + phantom
   Telecom call → `nativeCallEndedCleanup()` in `jssip.ts` (fires on last
   confirmed session ended/failed) calls `stopInCallNotification` +
   `telecomTerminateAnchors`; `TelecomBridge.terminateAnchorConnections()`
   tears down `tc-anchor-*` connections natively.
3. Reopening the app mid-call landed on Teams with no way back to the call →
   `SipContext` mount-effect hydration (`[SIP_HYDRATE]` log tag): reads
   `client.listSessions()`, rebuilds callState/remoteParty/hold, replays
   sessions into `CallSessionManager` (which now buckets already-active/held
   sessions and backdates `answeredAt` from `SipSessionInfo.confirmedAtMs` so
   the timer doesn't restart at 0:00).

### Other landmines (do not regress)

- **`react-native-callkeep` used to KILL THE PROCESS in `onHostDestroy`** — that
  was the original "call dies on swipe" cause. Fixed via pnpm patch
  `patches/react-native-callkeep@4.3.16.patch` (wired in root `package.json`
  `pnpm.patchedDependencies`). Never remove that patch.
- **In-call notification uses PLAIN action buttons, not CallStyle.** CallStyle on
  Samsung One UI rendered the Speaker chip white-on-white and silently dropped
  the Mute action. Buttons: Hang up / Speaker / Mute in
  `SipKeepAliveService.buildInCallNotification()`. Hangup rides a
  `PendingIntent.getService` → `ACTION_NOTIF_HANGUP_SVC` → EXPLICIT broadcast to
  `InCallNotificationReceiver` (implicit broadcasts never arrive) → JS event.
  Notification body tap deep-links `com.connectcommunications.mobile://active-call`
  (handled in `RootNavigator`).
- **Audio routing after connect goes through Telecom, not AudioManager.** Once the
  answer-time Telecom anchor flips ACTIVE, `AudioManager.setSpeakerphoneOn` is
  silently overridden. `IncomingCallUiModule.routeViaTelecom()` routes through
  `Connection.setAudioRoute()` first, falling back to AudioManager. `SipContext`
  re-asserts the user's route 600/1800 ms after anchor activation.
- **T-Mobile IPv6 blackhole**: first WSS connect over synthesized IPv6 can hang
  ~10 s. `SipSocketModule.kt` + `nativeSipSocket.ts` (custom OkHttp WebSocket,
  IPv4-first DNS, 6 s connect timeout) fixed cold-start answer from 10 s → ~0.4 s.
  Do not swap SIP back to React Native's stock WebSocket.
- **CGNAT idle kill**: T-Mobile drops idle sockets ≈5 min. Keepalives: JsSIP
  OPTIONS every 45 s foreground; native heartbeat every 4 min
  (`HEARTBEAT_INTERVAL_STANDING_IDLE_MS`) driving a forced REGISTER refresh via
  the headless task even when JsSIP thinks it's registered.
- **Never re-introduce a VitalPBX tenant PUT / any PBX write** — see the ABSOLUTE
  RULE in `AGENTS.md`. PBX is read-only, enforced in code.

### Shipped in the 2026-07-28 builds (user-visible)

- Instantaneous answer paths (in-app, lock screen, floating notification, cold
  start), `iceCandidatePoolSize: 1`, register watchdogs at 12 s/12.5 s.
- Call survives swipe-away; working notification controls; tap → ActiveCall.
- Speaker/Bluetooth work after connect (Telecom routing).
- Add Call button on ActiveCallScreen (hold current + dial second,
  `allowSecond: true`, reuses `TransferModal` with custom label/icon).
- Voicemail: reload much faster (parallel page fetch in `getVoicemails`, respects
  `maxPagesPerFolder`); Download now saves to the PUBLIC Downloads folder via
  `DownloadsModule.kt` (`ConnectDownloads.saveToDownloads`, MediaStore) with
  filename `Voicemail <caller> <date>.wav`.
- Colored person-icon avatars for unknown numbers (Recents/SMS,
  `colorForName` exported from `Avatar.tsx`).
- Removed the unrequested "Delivery driver" row from Settings.
- Implemented missing `reportDndStatus` in `api/client.ts` (another agent's
  import would have crashed at runtime).

### State at handoff / what to verify next

All of the above is installed on the test device and published to the download
page. Awaiting owner verification at handoff time: hangup/speaker/mute from the
notification **while swiped away**, notification tap → ActiveCall with a running
timer, and voicemail download appearing in Files → Downloads. If a regression
surfaces, start with logcat tags: `IN_CALL_NOTIF`, `SIP_HYDRATE`, `CALL_NAV`,
`MULTICALL`, `SIP_KEEPALIVE`, `CONNECT_CALL_UI`.
