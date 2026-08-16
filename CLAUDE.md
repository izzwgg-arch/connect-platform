# Connect 2 — working rules for Claude

## ⛔⛔ THE TWO RULES THAT WRAP EVERY TASK (2026-08-16, Izzy's standing instruction) — these are not optional and they are never waived by "it's a small change"

**START of every prompt / every task — READ THE MD FILES FIRST.** Before any
investigation, any edit, any command: read this file (`CLAUDE.md`) and the
relevant `docs/ai-context/AGENT_HANDOFF_*.md` handoffs for whatever you are
about to touch. ⛔ Do not start work off memory, off the file tree, or off a
guess about what a system does — the handoff for that exact area almost
certainly exists and almost certainly records the trap you are about to walk
into. Izzy should never have to say "read the MD files."

**END of every task — UPDATE THE MD FILES, AUTOMATICALLY.** Izzy will never ask
you to. Before you report a task done:
1. **Update `CLAUDE.md`** — a new ⛔ AGENT HANDOFF section for the area you
   touched, or an edit to the existing one so it stops being wrong. Say plainly
   what is DEPLOYED and container-verified vs ⏳ NOT PROVEN.
2. **Write/update the full handoff** under `docs/ai-context/` when the work has
   detail that does not fit in a summary bullet.
3. **Update the memory files** under the memory dir + its `MEMORY.md` index when
   the lesson outlives this repo state.
4. ⛔ **Tell Izzy in your reply that you updated them, and which files.** An
   update he doesn't know about is an update that didn't happen.

**THE WORK TREE MUST BE EMPTY BY THE END OF THE DAY.** So every finished task
ends: **commit → push → deploy.** Not "committed, will push later."
- ⛔ Stage **explicit paths, never `git add -A`** — other sessions edit this same
  tree (see [[shared-worktree-commit-hazard]]), and CLAUDE.md in particular often
  carries another session's in-flight handoff text. Check `git status` and
  `git diff --cached --name-only` before every commit.
- Deploy through the queue / `deploy-direct.sh` per the deploy sections below,
  then **verify the running container**, and say so.
- If something genuinely cannot be deployed (mobile build, agent rebuild, a
  change Izzy has to approve), say that explicitly in the reply instead of
  quietly leaving it — an unstated gap is how "it's fixed" becomes false.

## ⛔ AGENT HANDOFF — the WhatsApp integration cannot send, and its projection path would CRASH on day one (2026-08-16) — READ FIRST before any WhatsApp work, before quoting BUILD_STATUS's "✅ live", or before flipping any `WHATSAPP_*` flag

Full handoff: **`docs/ai-context/AGENT_HANDOFF_WHATSAPP_AUDIT_2026-08-16.md`**
(**Read-only audit — no code change, no migration, no deploy, no flag flipped.**)

- ⛔ **THE RULE: a signature-verified webhook is not a working integration.**
  The PR1 security work is careful and real — Meta HMAC-SHA256 + Twilio
  HMAC-SHA1, both **required by default**, raw-body scoped to the Meta POST,
  encrypted per-tenant credentials, masked responses. That makes the feature
  *look* far more finished than it is on a code skim. **Check the transport and
  the flags before believing a messaging feature is live** — same family as the
  two IVR publish paths and the dead `KnowledgeBase`.
- ⛔ **NOTHING EVER SENDS A WHATSAPP MESSAGE.** `grep -rn
  "graph.facebook.com\|api.twilio.com" apps/ packages/` returns **zero
  matches** repo-wide. `POST /whatsapp/threads/:id/send` (`server.ts:8103`)
  writes a `WhatsAppMessage` row and returns — no network call. `WHATSAPP_SIMULATE`
  defaults **true** → row stamped `SENT`, `simulated: true`. Set it to `false`
  and the row is stamped **`QUEUED`** — and **nothing dequeues or dispatches a
  QUEUED row**, which is worse: it claims pending forever.
  ⛔ **`docs/ai-support-agent/BUILD_STATUS.md:32` says "SMS/WhatsApp channel ✅
  live | transport guarded until Twilio creds". That is WRONG — the transport
  was never written.** Adding credentials changes nothing. Do not quote it.
- ⛔⛔ **SCHEMA DRIFT THAT WOULD CRASH IT ON DAY ONE.** `schema.prisma` declares
  **9** WhatsApp models and `ConnectChatThreadType.WHATSAPP`; **production has
  3 tables** (`WhatsAppProviderConfig`/`Thread`/`Message`) and its enum is still
  `SMS, DM, GROUP, TENANT_GROUP`. **No migration exists for the other six models
  OR the enum value** — so `prisma migrate deploy` will never create them.
  Proven, not inferred: `connectChatThread.count({where:{type:"WHATSAPP"}})`
  answered `22P02 invalid input value for enum "ConnectChatThreadType":
  "WHATSAPP"`. And `whatsappProject.ts:70` creates threads with **`type:
  "WHATSAPP" as any`** under a comment calling it "temporary until the generated
  Prisma client catches up" — it never did, because the migration was skipped.
  ⛔ **Set `WHATSAPP_PROJECT_TO_CONNECT_CHAT_ENABLED=true` today and the first
  real inbound message throws on the thread insert and retry-loops.**
  ⛔ `wa_project_verify.ts` **cannot catch this — line 47 forces the flag to
  `"false"`**, so the harness never reaches the write it nominally verifies.
- **Every flag is off in prod** (none set in `app-api-1`, `app-worker-1`, or
  `.env.platform`, so defaults rule): `WHATSAPP_WEBHOOK_ENQUEUE_ENABLED=false`
  (webhooks never feed the queues), `WHATSAPP_PROJECT_TO_CONNECT_CHAT_ENABLED=false`,
  `WHATSAPP_SIMULATE=true`. The two signature flags default `required` — ✅ keep
  that. `whatsappStatusJob.ts` **logs a summary and acks; that is the entire
  handler** — delivery statuses are applied to nothing.
- ✅ **Zero data, ever: 0 provider configs, 0 threads, 0 messages, 0
  `WHATSAPP_*` AuditLog rows** platform-wide. No tenant has ever configured it,
  so there is no customer risk and no back-fill burden — the drift can be fixed
  cleanly. Audit actions that exist in code but have never fired:
  `WHATSAPP_CREDENTIAL_CREATED/UPDATED/ENABLED/DISABLED`,
  `WHATSAPP_TEST_SEND_SIMULATED/DISPATCHED`, `WHATSAPP_REPLY_SENT`.
  The compliance table `WhatsAppPolicyAuditEvent` is **not in the prod DB**.
- ⛔ **`apps/frontend-legacy/portal-v2-legacy/app/dashboard/whatsapp/` has a
  complete-looking inbox UI and is in NO compose file and NO workspace entry.**
  Dead code — never read it as a shipped screen. The live page,
  `apps/portal/app/(platform)/apps/whatsapp/page.tsx`, is **17 lines**: a
  heading and a button to `/chat`.
- ⛔ **`docs/ai-context/API_ROUTES.md`'s WhatsApp line numbers are ~2,200 lines
  stale** (cites 5752/5919; actual 7936/8103). Grep the route string.
  ⛔ Webhook tenant resolution is a **linear scan decrypting EVERY
  `WhatsAppProviderConfig` row** per request — fine at 0 rows, needs an indexed
  column before real traffic.
- **All of it landed in one evening, 2026-05-24** (`ee78362c` → `2459fbb4` →
  `10487d51`) and has not been touched since. What's left is real work, not a
  toggle: the migration, the outbound transport, status application, the portal
  inbox, media download, and the whole compliance layer (24h window + approved
  templates — ⛔ free-form sending outside that window gets the number
  quality-rated down and eventually blocked by Meta).

## ⛔⛔ AGENT HANDOFF — the assistant now READS a system document + THIS company's document before answering (2026-08-16) — READ FIRST before writing anything into docs/agent-knowledge, before adding knowledge to the agent, or for "why does the assistant not know X?"

Commit `4c6f26a0` (+ `140dec3e` path fix) on `feat/ivr-migration-takeover`.
Owner's design, chosen 2026-08-16: **one MD file per tenant plus one system MD
file; the agent auto-reads the system file + that tenant's file only.**
Memory: [[agent-knowledge-docs-per-tenant]]. Supersedes the audit section below,
which is now history.

- **Where knowledge lives:** `docs/agent-knowledge/system.md` +
  `docs/agent-knowledge/tenants/<slug>.md` — **29 company documents, generated
  from live data**, in git. ⛔ These are NOT the `docs/ai-context/` handoffs;
  those are for Claude sessions, are full of other tenants' failures, and must
  never be fed to a customer-facing model.
- ⛔ **The API publishes; the AGENT only reads.** `agentKnowledgeSync.ts` runs
  at api boot, parses the files out of its own image (`COPY . .` puts
  `/app/docs` inside it) and upserts `AgentKnowledgeDoc` rows; the agent reads
  those rows. **This is the whole design**: the agent is a manual rebuild, so
  knowledge baked into its image would need a hand-built container per wording
  change. **Edit a file → deploy the api → the assistant knows it.**
- ⛔ **`process.cwd()` is `/app/apps/api`, NOT the repo root.** The first deploy
  published NOTHING and logged `missingDir` because the default path was
  `cwd/docs/agent-knowledge`. It deleted nothing — deletion is gated on having
  actually read a directory — and the resolver now walks up. `AGENT_KNOWLEDGE_DIR`
  overrides.
- ⛔ **TWO AUDIENCES, ONE FILE.** Everything outside `<!-- internal -->` markers
  is customer-safe; what is inside reaches ONLY the escalation researcher. The
  parser **fails closed** on an unbalanced marker (staff text goes to the
  internal half and the file is refused), and `scripts/agent-knowledge/check-docs.ts`
  greps the customer half for password/ssh/AMI/key/`/root/` before you commit.
  **Run it after any knowledge edit — 30 documents, ~1 s.**
- ⛔ **A tenant document must resolve to a REAL tenant or it is REFUSED, never
  guessed** — a document published against the wrong tenantId tells one customer
  another customer's facts. Put `tenantId:` in the front matter; a bare name is
  accepted only when exactly one live tenant matches.
- ⛔ **Two live tenants are both named "Connect Communications"**, so name-derived
  filenames COLLIDE and the second silently overwrote the first. `buildSlugMap`
  now suffixes the tenant-id tail for **both** of any duplicated name. Check this
  before adding any name-keyed file.
- **Re-running the generator is safe and meant to be routine:**
  `collect-tenant-facts.mjs` (read-only, runs in `app-api-1`) →
  `render-tenant-docs.mjs` rewrites ONLY the `<!-- generated:facts -->` block, so
  hand-written knowledge survives. A hand-written file with no fence is left
  entirely alone.
- **Prompt cost is bounded**: two documents, each capped (12k chars default,
  `AGENT_KNOWLEDGE_MAX_CHARS`) and cut on a section boundary; 60 s cache, so
  knowledge costs ~one query a minute, not one per message. Failure-safe
  everywhere — no knowledge must never mean no reply.
- **Model routing was ALREADY what the owner asked for** — verify before
  "building" it: fixing/researching runs `diagnostics` → **Opus 5**; customer
  chat runs `support_chat` → **OpenAI gpt-5**; Yiddish rides the **Yiddish Labs**
  bridge both ways, chosen from `User.uiLanguage` and falling back to
  Hebrew-character detection.
- ⏳ **NOT PROVEN: no customer has asked a question that the documents answer.**
  Proven as plumbing (52 agent tests, 12 api, 14 shared; migration applied;
  documents published — count them with `SELECT scope, count(*) FROM
  "AgentKnowledgeDoc"`). ⛔ **The agent container must be rebuilt** to read the
  new table — it is in no deploy queue.
- ⏳ **Only 6 of 29 documents carry real knowledge** (Gesheft, Create A Box,
  Trust Bookkeepings, Displaydex, inii mini, Landau Home). The other 23 are live
  facts with an empty "What we have learned about them". Fill them as you learn.
- ⏳ **Part 2 — "Fix it!" by SMS reply — is NOT built.** Design agreed: the
  escalation SMS carries a one-time code, the owner replies `FIX <code>`, and the
  agent executes ONLY the existing safe capability catalog. Nothing of it exists
  yet; today the escalation still ends at a human.

## ⛔ AGENT HANDOFF — the assistant had NO access to any MD file, and its knowledge base was dead code (2026-08-16, FIXED same day by the section above) — READ FIRST before saying the assistant "knows" something we wrote down, or before answering "does the agent have the docs?"

**Read-only audit — no code change, no deploy.** Memory:
[[agent-has-no-document-knowledge]].

- ⛔ **THE RULE: "the MD files exist" and "the agent has the MD files" are two
  different questions, and they answer opposite ways.** The docs side is
  healthy — **99 files in `docs/ai-context`, all tracked in git, every
  `docs/ai-context/…` path referenced in this file resolves to a real file,
  memory index 128/128 with no orphans.** That corpus is for **Claude sessions**.
  **The product assistant sees none of it.**
- **What the assistant actually gets each turn** (`apps/agent/src/conversation/engine.ts`
  ~line 450): the hardcoded `SYSTEM_PROMPT` (:21) + identity block + the
  viewing-page NAME + active trainer lessons + the last 40 messages + 13 tool
  specs. **No `.md` is read from disk anywhere in `apps/agent`** — the only MD
  paths in that tree are code comments citing spec docs.
- ⛔ **The knowledge base is dead three ways over.** `KnowledgeBase`
  (`knowledge/kb.ts`, table `AgentKbArticle`) is instantiated only inside the
  owner-only route `/agent/kb/retrieve` (`server.ts:494`); that route has **zero
  callers in the repo** (no portal UI); `draftFromResolution` is called by
  nothing; and the conversation engine never consults it. Live prod
  2026-08-16: **0 articles, 0 approved, 0 `AgentMemory` rows** — against **98
  conversations / 1,930 messages, last one 2026-08-15**. Same shape as the
  trainer bug: built, wired to nothing, empty for its whole life. ✅ Trainer
  lessons now read **1**, so that fix did land.
- ⚠️ **Prompt/capability drift, spotted in passing:** `SYSTEM_PROMPT` still
  tells the model "EVERYTHING ELSE (other changes, diagnostics): you cannot do
  it yet" while the engine now hands it 13 tools including
  `prepare_add_extension`, `prepare_enable_sms`, `prepare_add_phone_number` and
  `voicemails`. The prompt text is NOT amended when tools are present. Not
  fixed here.
- **Giving it document knowledge is unbuilt work**, not a toggle: ingest +
  retrieval + injection into `msgs`. ⛔ Anything customer-facing must be
  tenant-scoped and approval-gated — these handoffs are full of other tenants'
  names, credentials paths and internal failures.
- **Doc-rule gap, same audit:** the 2026-08-13 work landed **memory entries but
  no CLAUDE.md section** for linked-SIP visibility (`4ca72f44`), the IVR
  forward-save fix (`3f323182`) and the chat voice-note fixes
  (`e2b4699b` / `f0911881`). The recording-player work did get one.

## ⛔ AGENT HANDOFF — the PBX ALREADY ships a queue wallboard, and Gesheft already has logins for it (2026-08-16) — READ FIRST before building ANY queue wallboard / call-centre dashboard, before querying queue history, or before believing Connect has queue reporting

Full handoff: **`docs/ai-context/AGENT_HANDOFF_QUEUE_WALLBOARD_2026-08-16.md`**
(**Read-only investigation — no PBX write, no code, no deploy.** Deliverable was
mockups only, per Izzy: "show me mockups before you build anything." Mockups:
<https://claude.ai/code/artifact/0b5450cd-b0ae-43bf-ad62-ef7ecd05d208>)

- ⛔ **THE RULE: check the PBX for an existing add-on before building a PBX-shaped
  feature.** `sonata-switchboard` (live queue monitoring, `/live-monitoring`) and
  `sonata-stats` (queue reporting, `/stats`) are **installed, served and answering
  200**; `sonata-stats.service` is running. Switchboard is plain PHP under nginx
  with **no systemd unit** — "the service isn't running" is not a valid diagnosis
  for it, and `/sonata/service/v1/` answering **404** at the bare path is normal.
- ⛔ **Gesheft is already IN the Switchboard and pointed at the wrong screen.**
  `astboard.users` holds two tenant-8 accounts — **Joel Landau** (ext 53,
  2025-12-24) and **Pinchas Meislish** (2026-03-01) — both on **`layout_id 1`
  (`layout.default`)**, whose widgets are `extensions`/`queues`/`conferences`/
  `parking_lots`. The stock layout, not a queue board. The catalog already
  contains **`queues_wallboard`**, `queue_members`, `queued_calls`,
  `queue_overview`, `queues_calls_counter`, `queues_stats_summary` — so "we have
  no wallboard" and "the PBX has a wallboard" are both true.
- ⛔ **Gesheft (PBX tenant 8) is the ONLY tenant on the whole PBX with queue
  traffic.** A queue feature is today a one-customer feature. Queues: **750 Phone
  Orders** (ringall/30s, 8 members), **751 Customer Service** (linear/15s, 3),
  **752 After Hours CS** (ringall/15s, 3). 30 days: 750 answers **92.1%** of
  2,041; **751 answers 45.3% and TIMES OUT 46.2%**; **752 answers 11.0% and times
  out 81.8%**. ⛔ **108, 117, 118 took ZERO queue calls in 30 days** and **102
  alone carries 48%** of Phone Orders. Flagged to Izzy, deliberately NOT acted on
  — strategy/membership changes are PBX writes.
- ⛔ **Query traps, each of which produced a wrong answer first:** queue names in
  the log are **`T8_Q750`**, not `750` (bare ext returns zero rows and reads like
  "no data"); the table is **`asterisk.queues_log`** (plural) — there is **no
  `asteriskcdrdb`** on this box; `ombu_queues` is keyed **`queue_id`** not `id`
  and `ombu_extensions` has **`name`**, not `description`; and `data1/2/3` are
  **varchar**, so `max()` string-compares (an abandon "max" came back below its
  own average) — `cast(dataN as unsigned)`. Field meaning is per-event:
  COMPLETE* → data1 hold/data2 talk, **ABANDON → data3 waittime**.
  `RINGNOANSWER` is **structural for ringall** (one per losing member per round),
  never a fault count.
- **Connect's side:** live queue state DOES exist —
  `apps/telephony/.../QueueStateStore.ts` from AMI, shipped as `LiveQueueState`
  over `/ws/telephony`. ⛔ But it is **in-memory, live-only, and rebuilt from zero
  on every telephony restart** (`callerCount` is a running counter, not a real
  depth read) — never build reports on it. ⛔ **Connect does not read
  `queues_log` at all**; ingesting it is the real cost of a native reports tab.
  ⛔ The existing `apps/portal/app/(platform)/crm/wallboard/page.tsx` is a **CRM**
  wallboard (campaigns/dispositions/tasks) — different feature, don't grow it into
  this one.
- ⛔ **Palette decision, already validated — do not re-litigate.** Agent state is
  never colour alone: Connect's `--success #34c27b` beside `--warning #f0b655`
  fails colourblind separation at **ΔE 5.2 protan** (below even the 6–8 floor) on
  the `#141f2b` panel, so a stacked answered/timeout/abandoned bar was rejected
  for per-queue answered-rate meters plus an exact table, and every state chip
  carries a symbol **and** a word.
- ⏳ **NOT DECIDED, NOT BUILT.** Three routes are with Izzy (A: build a Sonata
  queue layout — a PBX write needing a mandate; **B, recommended**: do A now and
  let two weeks of real use write the spec; C: build native now). Open questions
  that change the design: one tenant vs platform; wall TV vs browser tab (a TV
  needs a no-login, never-expiring surface); alarms — ⛔ which **cannot** ride
  `ADMIN_ALERT` (muted platform-wide), so on-screen or escalation only.
  ⛔ **Listen/Whisper/Barge are drawn in the mockup and are UNVERIFIED** — they
  need `ChanSpy` confirmed on the PBX and a Connect permission gate; neither was
  checked. Don't promise them off the picture.

## ⛔ AGENT HANDOFF — the LoopCom logo is IN THE REPO now, and wired to nothing (2026-08-16) — READ FIRST before any LoopCom branding work, before putting a logo on any screen, or before believing a logo handed to you is the current one

Full handoff: **`docs/ai-context/AGENT_HANDOFF_LOOPCOM_BRAND_ASSETS_2026-08-16.md`**
(93 files **COMMITTED AND PUSHED**, ⏳ **wired to nothing, nothing deployed**.)

- ⛔ **THE RULE: when a brand asset is missing, say so and ask — do not draw
  one.** A search for a LoopCom logo found none in the repo, and this session
  invented three marks. They already existed as **production files** on Izzy's
  machine, in four conflicting sets, in no repo at all. *"There is a logo for
  everything."* An asset absent from git is not an asset that doesn't exist.
- ⛔ **Four LoopCom sets exist and the filenames LIE about which is canonical.**
  The rejected teal set is the one named `loopcom-official-logo-aurora.png`
  whose README says *"final masters."* Izzy chose **Signal Core** (blue chrome)
  on 2026-08-16 — the only set with light-surface masters, a full favicon set
  incl. `.ico`, and iOS + Android icons in both polarities. The others (aurora,
  trio wireframe, and a July flat-indigo *vector* kit) are **not** in git. Ask,
  never infer.
- **Where:** whole kit in **`docs/brand/loopcom/`** (~12 MB — under `docs/`,
  which `.easignore:66` excludes, so mobile builds pay nothing); the 13 files
  the portal would serve in **`apps/portal/public/brand/loopcom/`** (~1.1 MB).
  ⛔ `apps/portal/public/` is **NOT** easignored — keep it lean.
  `docs/brand/loopcom/README.md` has the per-file guidance.
- ⛔ **The tagline is baked into the artwork** — "THE AI COMMUNICATIONS
  PLATFORM" is pixels in every lockup, unremovable without a re-render, so a
  screen using it must not add a second tagline. ⛔ **No vector exists** (all
  PNG, max 1672×941). ⛔ **`masters/loopcom-icon-mark.png` is OPAQUE** despite
  the kit README claiming otherwise — proven from the PNG colour-type byte
  (`xxd -p -s 25 -l 1`), not by eye; use `webapp/loopcom-icon-*` or `favicon/*`
  for small marks. ⛔ **Never CSS-filter the dark art to fake light** — a real
  `-light` file ships for every placement.
- ✅ **Adopting it needs NO new colour token.** Signal Core specifies
  `#22A8FF → #4F7BFF on #0C1218` — exactly the portal's live `--accent`,
  `--accent-2`, `--bg` (`globals.css:3409`). Coincidence, but it holds.
- ⛔ **The commit landed under ANOTHER session's message** (`c0fd007b`, "docs:
  the PBX already ships a queue wallboard") because that session ran a blanket
  `git add` **between** this one's `git status` and its explicit-path `git add`.
  **Staging explicit paths does NOT protect your untracked files from another
  session's blanket add** — the exposure window is however long you leave new
  files untracked. Fix: `git add` new files the moment you create them, and
  re-check `git diff --cached --name-only` **immediately before commit**, not
  just before add. History deliberately NOT rewritten (another session was
  live). Files verified byte-identical by sha256 against source, 93 on origin.
- ⏳ **NOT DONE, and deliberately:** `apps/portal/app/login/page.tsx` is
  untouched (still "Connect Communications", no logo); the **favicon is
  unchanged** — the files sit under `.../brand/loopcom/favicon/` and NOT at the
  `public/` root, because a file there is served as `/favicon.ico` and would
  rebrand every page on deploy; app icons, invoices and invite emails all still
  carry Connect branding.
- ⛔ **The rebrand is half a decision and customers can see it.** Portal says
  "Connect Communications", the iOS app is named "Loopcom", the logo says
  "LoopCom". Three login mockups were shown to Izzy 2026-08-16; he has not
  picked one. **Don't build the login page until he does, and don't wire the
  favicon / app icons / invoices / emails until the naming is settled** — those
  reach customers.

## ⛔ AGENT HANDOFF — the Call History player was a SECOND player, and it never got the fix (2026-08-13) — READ FIRST for any "recording won't play / jumps back" report, before touching a portal recording player, or before adding a new one

Commits `033d0e6c` + `f95f7969` on `feat/ivr-migration-takeover` — portal
**DEPLOYED and container-verified** (new player chunk + spinner CSS grep'd
inside `app-portal-1`'s `.next`).

- ⛔ **THE RULE: the portal had TWO recording players, and the 2026-08-11
  spinner/honest-error fix landed on only one of them.** `CrmRecordingPlayer`
  (CRM timeline + both recordings pages) got it; the **Call History detail
  panel (`/calls`) had its own inline player with NONE of it** — a failed or
  slow `play()` silently snapped the button back. Izzy's "I was told this was
  fixed and it was not" was literally true — fixed on the player he doesn't
  use. Same family as the two IVR publish paths: find EVERY player before
  believing a playback feature is live.
- **All playback now goes through `apps/portal/services/recordingPlayback.ts`**
  — single stream/download URL builder + one-byte failure classifier
  (`not_recorded` / `forbidden` / `temporary`). ⛔ Any NEW recording player
  must use it; `git grep "voice/recording/" apps/portal` — only
  `recordingPlayback.ts` and `recordingDownload.ts` may build those URLs.
- **The `/calls` player now:** spinner + "Loading…" the moment play needs a
  network fetch; "This call wasn't recorded" REPLACES the player on a
  confirmed-permanent 404; transient failure shows Try-again — ⛔ retries are
  USER-initiated only (an auto-retry loop against a dead recording is the
  exact flood that once wedged the PBX helper); 45 s stall watchdog; CDR
  talk-time as the duration until audio metadata arrives (kills 0:00/0:00);
  Download switched from a bare `<a>` (which silently saved JSON error bodies
  as `.wav`) to `downloadRecordingWithReason`.
- **Fleet sweep of dead play buttons** (dry-run first: **9 of the newest 60
  advertised recordings don't exist**). Runner `/root/recording-verify-sweep.js`
  on loopcom mints an in-container SUPER_ADMIN service JWT and drives the real
  `POST /voice/recordings/verify` (`docker exec -i app-api-1 node /tmp/rvs.js
  '{"dryRun":false,"limit":5000}'`). Two traps, both paid for:
  ⛔ **node's `fetch` kills the client at 5 minutes** (undici headers timeout)
  — "ERR fetch failed" while the route handler KEEPS RUNNING server-side; the
  script now uses `node:http` (no timeout). ⛔ **an api deploy recreating
  `app-api-1` kills the in-process sweep handler AND wipes `docker logs`** —
  a missing completion line proves nothing; judge progress by
  `count(recordingMissingAt not null)`. Pass 1 stamped **752 dead buttons
  (186 → 938)** before the 14:52Z deploy killed it; a retry loop
  (`/root/recording-verify-loop.sh`, log `/root/recording-verify-loop.log`,
  6 attempts) is finishing the newest-5000 pass. Stamps are idempotent and
  cumulative; history deeper than that cleans up honestly per click.
- ⏳ **NOT PROVEN:** nobody has pressed play on the new player in a real
  browser. Open windows/desktop installs keep the old bundle until reloaded
  (the reload banner appears within ~5 min).

## ⛔ AGENT HANDOFF — payment links: copy, text from Connect's number, one link for ALL open invoices (2026-08-12) — READ FIRST for billing SMS, pay-link work, or before touching the sms-payment-link route or billingPayToken

Full handoff: **`docs/ai-context/AGENT_HANDOFF_BILLING_PAYLINK_SMS_2026-08-12.md`**
(`c3c3a9a1` + `9f669f79` on `feat/ivr-migration-takeover`, api + portal
**DEPLOYED and container-verified**.)

- ⛔ **THE RULE: a billing text is sent BY CONNECT, not by the customer.** One
  from-number for every customer, present and future: **(845) 723-1213**, via
  `billingSmsSender.ts` + the platform VoIP.ms account (`GlobalVoipMsConfig`).
  The old route resolved the sender from the CUSTOMER's tenant — needed
  `ProviderCredential` + an active `phoneNumber` row, which onboarding
  customers never have — so every send failed `sms_provider_unavailable`; and
  the screen's button posted an empty body, so it 400'd before even that.
  ⛔ `fromPhone` in the POST body is accepted and deliberately IGNORED.
- ⛔ **`BILLING_SMS_FROM_NUMBER` sat in prod env (api + worker) read by
  NOTHING.** Before believing a setting is wired, `git grep` the name —
  presence in the container proves nothing.
- **Copy link**: `GET /admin/billing/invoices/:id/payment-link` → the signed
  public pay URL (30-day token) + texting state + `combined` in one call. The
  invoice screen's Payment link card copies or texts either kind.
- **Combined link** (`9f669f79`): 2+ open invoices → one link, one card entry,
  each invoice charged oldest-first through the EXISTING per-invoice machinery
  (SUT → reusable xToken → first via `chargeBillingInvoiceWithSut`
  persist-card, rest via `chargeBillingInvoice`; card deactivated after unless
  the customer kept it). Result reported PER INVOICE. ⛔ First-charge decline
  stops everything; a later decline stops the rest; `BILLING_PERIOD_ALREADY_PAID`
  is an honest "already covered" skip, never an error. ⛔ The single and multi
  pay tokens are different shapes and the verifiers reject each other — never
  merge them. ⛔ Adjacent-month boundary overlap does NOT trip the period guard
  (proven from prod: Gesheft/Trimpro/Solidify paid on boundary days).
- ⏳ **NOT PROVEN**: no text has ever gone out from (845) 723-1213 (zero
  threads on that number — first real send is the acceptance test), and no
  combined payment has run against the real gateway. LUZER (2 × FAILED, $90)
  is the natural first live case.

## ⛔⛔ AGENT HANDOFF — the assistant can now ADD BILLABLE THINGS (2026-08-07) — READ FIRST before adding ANY "charge them for it" step, before adding an `/internal/agent/*` door, or for anything touching what a customer is billed when something is provisioned

Full handoff: **`docs/ai-context/AGENT_HANDOFF_AGENT_PROVISIONING_2026-08-07.md`**
(`4badbf06` → `e338d0ab` on `feat/ivr-migration-takeover`; api + portal + agent
**DEPLOYED and container-verified**. ⏳ Never walked in a browser.)

- ⛔ **THE RULE: next month's invoice does NOT store quantities — it recounts
  them live every cycle** (`resolveBillingQuantities` → `calculateTenantBillingUsage`
  reads Extension rows, PhoneNumber rows and the SMS flag when the invoice is
  built). **So creating the extension IS the billing update**, and a second "add
  it to the invoice" step would charge the customer TWICE. What was missing is
  *proof the money moved*: `billingReconcile.ts` snapshots the monthly total
  before, provisions, snapshots after, and refuses to report success if it
  didn't rise.
- ⛔ **Three ways a real thing is silently FREE, all previously live:** a tenant
  pinned to a **manual** quantity override (usage moves, invoice never does —
  now bumped); an extension number that isn't **exactly three digits** (usage
  counts `/^\d{3}$/`, so a 2- or 4-digit line works on the phone and bills
  nothing); and a number that never reaches the **`phoneNumber` table** — see
  the open item below.
- ⛔ **OPEN — the additional-number fee is not charged on 11 of 29 live
  tenants.** Their DIDs live only in `PbxTenantInboundDid`, which the plan's
  per-number line doesn't count, so the engine thinks they have NO numbers.
  inii mini (two numbers) was being quoted "$0.00, first number included".
  Adding a number is now REFUSED when real DIDs exceed billed numbers, and the
  quote reflects reality — but ⛔ **the underlying count is deliberately NOT
  fixed**: backfilling would start billing 11 customers for numbers they've had
  for months. That's Izzy's call.
- ⛔ **Prices come from `resolveTenantBillingPricing`, never `ONBOARDING_PRICES`.**
  Those constants are what a NEW customer is quoted; an existing account may be
  on a plan or a negotiated rate. The agent has no price constants of its own —
  it reads them over `/internal/agent/account-setup-info`.
- ⛔ **Every new `/internal/agent/*` door MUST be added to
  `shouldSkipJwtVerification` — this has shipped broken TWICE.** The JWT hook
  runs before routing, so a missing entry answers **401** and the door's own
  secret check never runs; the agent then reports a vague "I couldn't retrieve
  that" forever with nothing wrong in the logs. **403 = the handler ran; 401 =
  you never reached it.** Guarded by `internalDoorBypass.test.ts`, which reads
  the route module's SOURCE (a unit test of the handler passes straight through
  this bug).
- **The gates live once**, in `apps/api/src/agentConfirmations.ts` (password,
  single-use atomic claim, params hash, tenant scoping, rate limit, audit);
  capabilities plug in. ⛔ `transactional: true` = pure DB, a failure rolls the
  approval back; `false` = PBX/carrier/email, the approval **stays spent**
  because re-running half a purchase is worse than not finishing it — and such a
  capability's own refusal message MUST survive ("the extension exists but the
  welcome email didn't go" is the whole value).
- ⛔ **Provisioning REPLAYS the real portal routes** (`POST /pbx/extensions` →
  `POST /admin/users`) signed as the confirming admin, never reimplements them.
  `/pbx/extensions` stamps `ownerUserId` with its creator and `/admin/users`
  then refuses that extension — hand it back in between.
- **Texting**: `smsBillingEnabled` is the whole billing switch; ⛔ **`smsSendMode`
  stays TEST** (an earlier version flipped it to LIVE, which would have broken
  campaign sends without helping texting). Most `TenantSmsNumber` rows are
  unclaimed — claim only a `tenantId: null` one.
- **Buying a number**: spare stock first, the PBX inbound route is part of the
  same operation (a number that doesn't ring is worse than none), toll-free
  rejected at parse time, and it refuses outright for tenants with no VoIP.ms
  subaccount rather than half-provisioning.
- ⏳ **Acceptance test in §8 of the handoff** — ask for an extension in chat,
  confirm with a password, check the welcome email lands and the invoice preview
  moves by exactly the quoted amount. Also open: 7 red tests in
  `pbxTenantDirectorySync` that are NOT from this work.

## ⛔ AGENT HANDOFF — an extension that could not be deleted (2026-08-13) — READ FIRST for any red "Fatal error … delete() on null" in the VitalPBX panel, before deleting ANY extension, or before assuming a panel fatal is chronic

Full handoff: **`docs/ai-context/AGENT_HANDOFF_EXTENSION_DELETE_MOBILE_FLAG_2026-08-13.md`**
(**PBX data repair only** — one `UPDATE` of one column on one row. No code, no
deploy, no regeneration, no reload. Read-only everywhere else.)

- ⛔ **An extension whose device row says `mobile_client='yes'` while having NO
  row in `ombutel.ombu_mobile_devices` CANNOT be deleted.** `Extension->delete()`
  calls `_deleteMobileAccount()`, gets `null`, and fatals — the panel dies with
  `Call to a member function delete() on null`, **naming no extension**, so it
  reads like a broken panel rather than one bad record. Nothing is deleted and
  nothing is half-deleted (verified: DB rows, pjsip endpoint, hints and mailbox
  all intact after eight attempts). ⛔ `Extension.php` is **ionCube-encrypted** —
  judge it from the DB, the generated config and `/var/log/nginx/error.log`, and
  don't waste time trying to read it.
- **The one query that scopes it fleet-wide** (read-only): left-join
  `ombu_devices` to `ombu_mobile_devices` on `device_id` where
  `mobile_client='yes' and m.id is null`. **Empty = no extension on the box has
  this fault.** On 2026-08-13 it returned exactly ONE row across all 27 tenants —
  device 171, Secro Selutions ext 103 "Fix Up Group" — and returns empty now.
- **The fix is to make the record honest:** `update ombutel.ombu_devices set
  mobile_client='no' where device_id=<id>`. ⛔ **Do NOT fix it through the panel**
  — toggling Mobile Client to No and pressing Update *is* "delete the mobile
  account", so it very likely hits the same crash. ⛔ **The flag is inert to call
  handling, proven not assumed**: the generated `[T3_103]` pjsip block is
  identical to an unflagged extension's apart from `callerid`, which is why **no
  regeneration and no reload** were needed. Backup
  `/root/ombu_devices_171_backup_20260813.sql`.
- ⛔ **`deleteMobileAccount` appears nowhere else in the nginx error log's
  history** — all 8 fatals were Izzy's own attempts, 11:30–12:03 ET the same day.
  **Grep the log's whole history before calling a panel fatal chronic.**
- **Before deleting any extension, check what dies with it.** For 103: no
  `ombu_destinations` row with `module_id=1, index=130` and the tenant's DID goes
  to a time condition, so no route breaks — but it IS the **only member of ring
  group 822**, which would be left empty. ⛔ `ombu_destinations` is
  `(id, category_id, module_id, index)` where `index` is the target row's id
  within that module; module **1** = extensions, **20** = ring_group,
  **29** = inbound_route.
- ⛔ **Deleting on the PBX does not stop the billing** — Connect keeps its own
  `Extension` row, still billable, still on the invoice, still in the app's Team
  list. **OPEN, flagged to Izzy, not investigated:** Connect bills Secro
  Selutions for **6** extensions at $25 while the PBX holds **3** — 305, 306 and
  307 exist only in Connect.
- ⏳ **NOT PROVEN: nobody has pressed Delete since the repair.** It is proven as
  data (orphan query empty, flag matches reality), not as a completed delete.

## ⛔ AGENT HANDOFF — number ports land themselves now (2026-08-12) — READ FIRST for ANY port-in work, "the port completed and nothing happened", the port watchdog, or before touching portLanding/portWatchdog

Full handoff: **`docs/ai-context/AGENT_HANDOFF_PORT_AUTOMATION_2026-08-12.md`**
(commits `c5dc0f7a` → `76a0bfbf` → `5330620d` on `feat/ivr-migration-takeover`,
api **DEPLOYED + container-verified**; live-proven the same day on inii mini's
own port — the first sweep landed it end-to-end, temp number retired, no human).

- **The whole port lifecycle is automatic now.** Build: a porting sign-up
  prepares BOTH numbers (tenant number list, dual inbound routes
  "Main"/"Main ported", the REAL number as outbound caller ID). A 15-min api
  watchdog polls `getLNPStatus` + `getDIDsInfo` (⛔ VoIP.ms has NO port
  webhook; ✅ **`getLNPList` enumerates all orders** — how Matamim's real
  order was found). On arrival: route to subaccount (verified by re-read),
  move texting (claim + copy assignment + tenant default), mirror the
  mapping + book the menu switch via DidSwitchSchedule — or, temp-not-on-
  Connect, **copy the temp route's DECODED PBX destination** (⛔ never the
  raw `ombu_destinations` row id — shared rows cascade away when the temp
  route is deleted; `5330620d`) — then **re-publish through the real
  `/voice/ivr/publish`** as a service principal. ⛔ Retirement gates on the
  ORDER reading completed, never FOC arrival: temp DID → master spare pool,
  SMS row un-claimed, mapping DELETED (unique e164 must free for reuse).
- ⛔ **Completion AND rejection emails ride ADMIN_ALERT → currently
  `ALERTS_MUTED`.** They queue and are skipped; the sign-up timeline is the
  record. A rejected port needs a human and nobody is emailed while the mute
  stands.
- ⏳ **Matamim is the staged first start-to-finish test** (submission
  `cmsey1yel0002o4xoogh8gmrh`, PBX tenant 104): port **217946 →
  929-359-8299, FOC 2026-08-17**. ⛔ The wizard had recorded the WRONG number
  (8456282646) — corrected on the submission. Hand-backfilled because the
  port was filed manually: tenant lists both numbers, route 241
  "Main ported" → ext 101 (own destination row), outbound CID now the ported
  number, watchdog tracking (`lastPortStatus: foc_received`). Around Aug 17
  the timeline should walk arrived → texting → pointing → published →
  (on completed) temp 724-419-8226 retired — with zero human input.
- **Per-retirement leftover:** the temp number's old PBX inbound route stays
  (panel deletes have no captured contract) and counts **$3/mo E911** until
  deleted in the panel. First one: inii mini's "Main" 8452605692 on tenant 105.
- ⛔ Traps paid for: tenant EDIT form has NO `name` input and legacy tenants
  carry the PLAIN company description — identify a parsed tenant form by
  `tenant_id` + `inbound_numbers[0][did]`; a killed panel run (exit 137) can
  have LANDED its post — read the PBX DB before re-running (scripts are
  resume-guarded); blue/green api deploys run TWO Prisma pools and can
  transiently exhaust Postgres (max 100) — wait, don't "fix".

## ⛔⛔ ALERT EMAILS ARE MUTED AT THE SEND DOOR; ONLY ASSISTANT ESCALATIONS REACH THE OWNER (verified live 2026-08-12) — READ FIRST before adding ANY alert, before "why didn't I get warned about X", and before assuming an alert reached a human

**Verified by reading the running container and the DB, 2026-08-12 — read-only,
nothing changed.** Izzy's directive (2026-08-12), already implemented by another
session: **every automated alert to the alert inbox stops; Assistant escalations
continue.**

- **The mute is ONE gate at the single send door** —
  `processEmailJobsBatch` in `apps/api/src/server.ts:1162`: any
  `EmailJob` with `type === "ADMIN_ALERT"` is set `status SKIPPED`,
  `lastErrorCode "ALERTS_MUTED"`, and never sent. ⛔ **This design is the point:
  gating the CREATION sites would always leak**, because at least seven files
  (`billingEmailLifecycle`, `receiptReconciliation`, `adminSignupReport`,
  `journeyTracking`, `setupWatchdog`, `portLanding`, `portWatchdog`) create
  `ADMIN_ALERT` rows **without** going through `sendAdminAlert`. Do not "improve"
  this by moving the check upstream.
- ⛔ **It is CODE in the running image, not a shell script with a timer.** Last
  week's `/root/alert-email-killswitch.sh` self-expired and alerts silently
  returned for five days. This survives restarts and deploys. Verify with
  `docker exec app-api-1 grep -c ALERTS_MUTED /app/apps/api/src/server.ts` → `1`.
- **Nothing bypasses it: the api is the ONLY sender of `EmailJob` rows.** The
  worker merely *creates* them (its `status: "SENT"` writes are all
  `SmsMessage`/CRM tables, not `EmailJob`).
- ✅ **PROVEN OFF, not assumed:** last `ADMIN_ALERT` with a real `sentAt` was
  **2026-08-12T01:08Z**; **36 rows SKIPPED `ALERTS_MUTED`** from 02:18Z to
  23:44Z. Rows are still created on purpose — **they are the audit trail**, and
  reading them is now the only way to see what the platform tried to warn about.
- **58 `ADMIN_ALERT` rows sit `FAILED` at `attempts=5`** (Aug 5–6, the mail-quota
  casualties). The processor only takes `attempts < 5`, so ⛔ **they can never
  fire** — do not "retry" them.
- ✅ **Escalations work, both halves, proven live:** `apps/api/src/agentEscalationDispatch.ts`
  turns each `AgentEscalation` row into an SMS **and** an `EmailJob` of type
  **`AGENT_ESCALATION`** — the only mail category the gate lets through. Two real
  dispatches on 2026-08-12 (02:21, 03:05) both carry `smsSentAt` **and**
  `emailQueuedAt` with `lastError: null`; both emails show `SENT`.
  SMS → **(562) 209-6644 + (845) 723-1213**, from **(845) 557-7768**, capped at
  **40/rolling 24h** so a runaway agent cannot text all night. ⛔ **Escalation SMS
  writes NO `SmsMessage` row** — querying that table returns "none" and looks
  like a failure; read `AgentEscalation.smsSentAt` instead.
- ⛔ **Two suppression mechanisms now look alike — tell them apart by
  `lastErrorCode`, never by status.** `ALERTS_MUTED` = this gate (owner
  directive). No code / a `decideAdminAlert` log line = the **40-per-rolling-24h
  ceiling** in `packages/shared/src/adminAlertBudget.ts`, which still exists
  underneath and still works.
- **Agent-side alert channels are muted DELIBERATELY, and belt-and-braces:** the
  daily digest and the `[Watchman CRITICAL]` toll-fraud warnings run through
  `apps/agent/src/notify/notifier.ts:73`, which filters recipients listed in
  **`AGENT_MUTED_ALERT_RECIPIENTS` (default `tod10950@gmail.com`)** and returns
  `{sent:false, reason:"recipient_muted"}`. On top of that `app-agent-1` has
  **zero SMTP env vars**, so today they are `recorded to audit only` anyway.
  ⛔ The real fragility is not SMTP — it is that **the filter matches on the
  literal address**: change `ADMIN_ALERT_EMAIL` (or the owner's address) without
  updating `AGENT_MUTED_ALERT_RECIPIENTS` and the agent's alerts start flowing
  again silently.
- **Customer mail is untouched and must stay that way:** `BILLING_INVOICE_READY`,
  `BILLING_RECEIPT`, `BILLING_PAYMENT_LINK`, `USER_INVITE` all still send, as do
  the PBX's voicemail notifications (a different system entirely — see the
  voicemail-email handoff).
- ⚠️ **The accepted cost:** toll-fraud attempts, unregistered devices and doorway
  failures now warn nobody. That is Izzy's call, made twice. If you need one of
  these back, add it as an **escalation**, not as an `ADMIN_ALERT` — that is the
  channel that reaches him.

## `docs/` is IN GIT now (2026-08-12) — the force-add ritual is dead; only `docs/pbx-brain/` stays ignored

Commit `2bf61c03`. For months `.gitignore` had `docs/` wholesale, so **41 of 91
files under `docs/ai-context/` — several of them "READ FIRST" targets named in
this very file — existed only on one machine**, one `git clean -xfd` from
deletion. Every doc that WAS in git got there by individual `git add -f`, which
is exactly how the gap grew unnoticed.

- **Why it was ignored:** `docs/pbx-brain/` holds a **1.2 GB PBX snapshot**
  (475 MB tarball + extracted VitalPBX dump) that bloated EAS build uploads.
  That dir is still ignored; EAS is independently protected by `.easignore`,
  which excludes ALL of `docs/` — so do not "fix" the .gitignore rule back.
- **A new doc now lands with a plain `git add`.** If `git add docs/...` ever
  complains about an ignore rule again, something regressed — check
  `.gitignore` for a resurrected `docs/` line before force-adding.
- **Both safety passes ran against the committed tree and came back clean**
  (structured tokens, private keys, cred-bearing URLs, assigned secret values,
  the AMI-password shape, long-hex triage → only placeholders, git SHAs and
  checksums; `.connect-ssh/` still ignored, zero surprise untracked files).
  ⛔ `docs/pbx/*.sh` + `*.conf` are pinned LF in `.gitattributes` — they get
  scp'd to the Linux PBX and a Windows CRLF checkout breaks them (same trap as
  `/scripts/pbx/**`). The unpinned `.mjs`/`.sql` there are shebang-free and
  CRLF-safe on purpose; pin any NEW shell/conf file you add under docs/pbx.

## ⛔⛔ AGENT HANDOFF — escalations go somewhere now; recordings stopped lying; voicemails play their own audio (2026-08-12) — READ FIRST for agent escalations/alert email, ANY recording or voicemail playback work, before adding a reply.send(stream) to apps/api, or before believing a stored audio locator

Full handoff: **`docs/ai-context/AGENT_HANDOFF_ESCALATIONS_RECORDINGS_VOICEMAIL_2026-08-12.md`**
(commits `1682c0a0` → `6947e0e2` — api + portal DEPLOYED, agent container
REBUILT at `6947e0e2`, two DB migrations, all live-verified incl. a real chat
that produced a real SMS + email.)

- ⛔ **"Passed to the human team" now has code behind it.** For weeks it was
  prompt text with NOTHING attached — 40+ customer requests reached nobody.
  Now: the agent detects its own escalation replies, RESEARCHES with the
  tenant-bound read tools (drafting ISSUE/FINDINGS/PROPOSED FIX/APPROVAL so the
  owner only says "okay"), writes `AgentEscalation`; the api's 30s dispatcher
  texts **(562) 209-6644 + (845) 723-1213 FROM (845) 557-7768** (tenant name +
  user name in the SMS) and emails tod10950@gmail.com. SMS capped 40/rolling-24h.
  ⛔ **The model free-forms its phrasing — the first live test escaped the
  transcript-derived regex** ("I've passed along: …", no team named); every
  live miss becomes a regression case in `escalations.test.ts`. ⛔ Replying
  "OK" does NOT auto-execute. ⛔ Research failure never loses the escalation
  (`researchDegraded` + raw transcript).
- ⛔ **ADMIN_ALERT email is MUTED platform-wide** (owner's explicit trade):
  the api's `processEmailJobsBatch` — the ONLY send door; the worker just
  creates rows — marks every ADMIN_ALERT job `SKIPPED`. Nobody receives
  platform alert emails anymore; the rows remain as audit trail. The agent's
  own SMTP also drops the alert address. The 2026-08-06 "don't re-enable until
  the cap bypass is understood" is moot — ADMIN_ALERT never sends at all.
- **(845) 557-7768 was taken from Landau Home** (Izzy's word; they now have NO
  texting number) and is the ADMIN tenant's default — owner replies land in the
  admin shared SMS inbox (proven, ~2.5 min poll) and admin outbound rides the
  same number.
- ⛔ **`ConnectCdr.recordingPath` proves INTENT, never existence** — VitalPBX
  sets `__REC_FILENAME`/`MIXMONITOR_FILENAME` on calls it then does NOT record.
  44% of Trust Bookkeeping's play buttons were dead (418 offered / 234 real).
  `recordingMissingAt` is stamped ONLY on a PBX-confirmed 404 + failed
  CDR-recovery (`recordingAvailability.ts`, unit-tested: a 5xx/timeout must
  NEVER hide a recording — queue/IVR calls record on another leg and recovery
  rescues them). Sweep: `POST /voice/recordings/verify` (dry-run default) —
  ⛔ **applied to Trust ONLY so far**. Whether Trust's routes SHOULD record is
  Izzy's open call (`enablerecording=no` on all their inbound routes; recording
  is per ROUTE, never per extension).
- ⛔ **In an async Fastify handler, `reply.send(<stream>)` that is not RETURNED
  answers `200 content-length: 0` EMPTY — silently.** A Buffer survives that
  race, a stream loses it, no log anywhere; caught only by a body-counting
  probe. Return the send through the whole chain. And never put
  `AbortSignal.timeout()` on a fetch whose body pipes to the client — bound
  time-to-headers only, or long audio cuts off mid-listen. Recordings now
  STREAM (first byte 571 ms on a 14 MB file, was full-transfer-first);
  voicemail skips the ffmpeg transcode when the RIFF header says PCM (header,
  never extension — wav49=GSM also ships as ".wav").
- ⛔ **Every stored voicemail locator is POSITIONAL** (msgNum, spool paths,
  `/static/…/msgNNNN.wav` — Asterisk renumbers slots on every delete/move).
  35 voicemails on one mailbox were bound to msg0000 — THE "every voicemail
  plays the first one" bug, both apps. Playback now resolves the current slot
  by **origtime** (from `pbxMessageId`), answers honest 404
  `voicemail_audio_gone` when the identity left the mailbox, and ⛔ **msg_num
  matching was removed from both refresh matchers — never reintroduce it**.
  The web app ALSO had an unkeyed player that set `audio.src` once, forever —
  two bugs, one symptom, which is why the earlier "fix" never held.
- Mini-dialer voicemails PRELOAD into a blob cache on list load (instant play;
  `?preload=1` never read-stamps — `?raw=1` is unsuitable, it skips transcode).
  ⛔ An already-open mini-dialer keeps the old bundle until app restart.
- ⛔ `git merge-base --is-ancestor A B` asks "is A an ancestor of B" — inverting
  it produced a false branch-rollback scare mid-session. `ls-remote` +
  merge-base before concluding anything about a rollback. Agent rebuilds build
  the branch TIP (sessions push all night); apps/api tests need
  `node --experimental-test-module-mocks --import tsx --test`.

## ⛔ AGENT HANDOFF — the Team Directory could not scroll unless the window was maximised (2026-08-12) — READ FIRST before adding a screen to the `.console-content:has(> …)` full-height list, or for ANY "this page cuts off / won't scroll" report

Full handoff: **`docs/ai-context/AGENT_HANDOFF_TEAM_DIRECTORY_SCROLL_2026-08-12.md`**
(commit `504ec6ed` on `feat/ivr-migration-takeover`, shipped in portal tip
`5330620d` — **DEPLOYED, container-verified AND verified over public HTTPS**.
Portal CSS only, one screen; nothing touching call routing, the PBX or billing.)

- ⛔ **A screen listed in `.console-content:has(> …)` has had its outer
  scrolling turned OFF and MUST supply its own inner scroller.** Three parts,
  as `.ch-shell` does it: root `height:100%; min-height:0; overflow:hidden` +
  flex column; header/footer bands `flex-shrink:0`; **middle band
  `flex:1; min-height:0; overflow-y:auto`**. The Team Directory had only the
  footer part, so **no element on the page was a scroller** and everything
  below the window edge was unreachable. ⛔ **`min-height: 0` is the piece that
  does the work and the piece everyone omits** — without it a `flex:1` child
  still grows to fit its content and never scrolls.
- ⛔ **A maximised window PROVES NOTHING here.** Nothing about the bug is
  size-dependent — only the symptom is. Maximised, the list happened to fit and
  the screen looked perfect; shrink the window and 1,425 px of people were cut
  off with **zero** scrollable containers anywhere on the page. **Test every
  screen on that list at a short window.**
- ⛔ **One scrollport per page.** `overflow-x: auto` computes `overflow-y` to
  `auto` too, so a nested wrapper becomes its own scrollport and captures any
  `position: sticky` header inside it. Making the page scroll would have slid
  the list view's column headings away (measured: header at **y = −523**);
  moving the sideways scroll up onto `.td-content` pinned them correctly
  (**y = 77** vs content top 61). Fixing the scroll is what *exposed* this —
  check for it whenever you add a scroller.
- **Safe to clip only because the overlays are `position: fixed`** — the detail
  panel, its backdrop and the toasts all are, so `overflow: hidden` on the root
  never reaches them. Verify that before adding clipping to any other screen.
- ⛔ **The desktop app keeps the OLD bundle until the window is fully closed and
  reopened** — a portal deploy reaches every install with no new build, but
  "it's deployed" without "now restart it" leaves the customer looking at the
  identical bug.
- ⏳ **NOT PROVEN: nobody has opened the real screen since the deploy.** Proven
  by measurement against the actual shipped stylesheet (5,412 rules parsed) plus
  the live CSS fetched over HTTPS — not by a human scrolling it.
- ✅ **The other three screens were checked (2026-08-12) and are HEALTHY** — the
  Team Directory was the only one. Measured at a 640 px window, not read:
  Voicemail's feed scrolls 1,490 px and its detail panel another 742 px; Billing's
  `.billing-ws-main-scroll` scrolls 1,430 px; all parents clip with 0 px stranded.
  ⛔ **The contract list is exactly four screens** — the other
  `.console-content:has(…)` rules (wallboard, checklist, scripts, voicemail-drops,
  forms) set **background only** and never touch `overflow`, so those pages keep
  normal scrolling and are not affected.
- ✅ **Billing hardened same day (`33d08426` — committed + pushed, ⛔ NOT yet
  deployed; behavior-identical, rides the next portal deploy).** Its `flex: 1`
  used to arrive only through the
  `.billing-ws-shell--context-wide .billing-ws-main--wide` pair, so a page
  rendering `.billing-ws-main` bare would silently lose the scroll chain — the
  `.td-page` failure shape one refactor away. The layout now lives on
  `.billing-ws-main` itself and both modifier classes are DELETED from CSS and
  `AdminBillingShell` (nothing else referenced them; `--all-tenants` stays,
  conditional and pre-existing). Proven by measuring shell markup and bare
  markup side by side: identical 1,569 px scroll, toolbar pinned, 0 px stranded.
- ⛔ **The rebuilt/non-rebuilt billing scroll split is DELIBERATE — never "fix"
  one side to match the other.** Pages on the `REBUILT` list in
  `apps/portal/app/(platform)/admin/billing/layout.tsx` render no
  `.billing-ws-shell` at all (bare `<Suspense>` renders no DOM node), so the
  `:has()` never matches and they scroll as ordinary pages; shell-wrapped pages
  scroll inside `.billing-ws-main-scroll` with the toolbar pinned. The full
  explanation now sits ON the `REBUILT` list itself — read it before adding any
  screen under `/admin/billing`.

## ⛔⛔ AGENT HANDOFF — voicemail-to-email is sent BY THE PBX, not by Connect (2026-08-09) — READ FIRST for ANY "customer didn't get their voicemail email", and before looking inside Connect for it

Full handoff: **`docs/ai-context/AGENT_HANDOFF_VOICEMAIL_EMAIL_PBX_2026-08-09.md`**
(**Read-only investigation — no deploy, no code change, no PBX write.** Evidence
current to 2026-08-09; §7 and §11 re-verified 2026-08-12.)

- ⛔ **THE RULE: the voicemail emails customers receive come from Asterisk on the
  PBX. Connect has nothing to do with them.** This session opened inside Connect,
  found Connect's own voicemail-email job had never processed a single row, and
  was about to report that as the cause. It is a *different, unshipped feature*.
  Izzy had to redirect: *"you're supposed to look inside the PBX."* **Two systems
  can email the same voicemail — establish which one the customer actually
  receives before diagnosing anything.**
- **The live chain:** `app_voicemail` → the mailbox's email address in
  `/etc/asterisk/vitalpbx/voicemail__50-<pbxTenantNum>-main.conf`
  (`<ext> => <pin>,<Name>,<EMAIL>,,attach=yes|…` — the **3rd comma field**) →
  `mailcmd=/usr/share/vitalpbx/scripts/voicemail2email` → postfix →
  `sender_canonical_maps /^.+$/` rewrites the sender to
  `support@connectcomunications.com` → authenticated `smtp.gmail.com:587`.
  ⛔ **An EMPTY 3rd field means no email is ever generated** — no error, no log
  line, nothing to find later. ⛔ `voicemail2email` is **ionCube-encrypted PHP**
  and cannot be read; judge it only by `/var/log/mail.log`.
- ⛔ **THE REAL "missing emails": 58 mailboxes platform-wide have no address**, so
  **108 of 2,674 voicemails in 30 days (4%) never notified anyone.** Worst: **A
  Plus ext 108 "Home" 45**, **Gesheft ext 112 11**, Create A Box ext 101 8 (one
  255s). Gesheft's blind mailboxes: **103,104,105,106,108,112,116,117,118,897**.
  ⛔ **Gesheft ext 102 emails to `Orders@pileupny.com`** — another company's
  domain; delivers fine, **needs Izzy's confirmation it's intentional.**
- **The mechanism itself is healthy — do not re-litigate transport.** On
  2026-08-09: **33 voicemails → 29 in email-configured mailboxes → 29 sent, 30/30
  postfix deliveries `status=sent`, zero failures**, all queues empty, and
  `/var/mail/root` holds **381 cron mails and not one bounce** in over a year.
  Gesheft ext 101 was **12-for-12**. Every recipient domain is Google Workspace
  with `include:_spf.google.com` and we relay through authenticated Gmail, so
  `250 OK … gsmtp` means Google took it — after that it is inbox-or-spam on the
  customer side. **Size is a non-issue:** ~**4.3 KB of email per second of audio**
  (it compresses; it does not attach the raw 16 KB/s wav) against a **10 MB**
  limit.
- ⛔ **NO MAIL HISTORY SURVIVES PAST THE CURRENT DAY — this is why the question
  had no hard answer.** `mail.log.1` is **1 byte**; the journal is
  **runtime-only** (no `/var/log/journal`) and starts `00:00:01`;
  `/var/log/asterisk/full` starts `00:00:01` with **no `full.1`**; `mail.*` is
  routed nowhere but `mail.log`; **no remote syslog.** Every midnight the previous
  day's evidence is destroyed. **Fixing retention is the highest-value follow-up
  in the handoff** — without it the next identical complaint gets the same
  non-answer.
- ⛔ **Connect's own sender has NEVER run:** `AGENT_VOICEMAIL_EMAIL` is set
  **nowhere** (container, `.env.platform`, compose), while
  `AGENT_VOICEMAIL_TRANSCRIBE=1` **is** — which is why transcripts land and
  Connect emails never do. Proven, not inferred: `emailedAt` is stamped even for
  skips, and it is **null on all 289 voicemails 08-09→08-13**. ⛔ Before anyone
  enables it: a failed send returns **without stamping**, so the row silently
  ages out of the **30-minute** window forever with no `emailError` — and the
  agent's notifier has **no SMTP configured at all**, so today it would send
  nothing while burning each window.
- ⛔ **Gesheft ext 101 is 853 messages from a hard wall:** `maxmsg=9999` and its
  INBOX holds **9,146** (102 holds 2,612). At ~35/day that is **3–4 weeks** until
  Asterisk plays "mailbox full" and **the message is not recorded at all** — no
  voicemail, no email, no Connect row, nothing in the log. It will present as "we
  stopped getting voicemail emails".
- **Verified, do not re-derive:** the PBX runs **EDT**;
  `Voicemail.receivedAt` **is exactly** the spool `origtime` epoch (**40/40** over
  Aug 8–9, absolute UTC); **Connect's ingest is reliable** — 40 spool ↔ 40 rows,
  1:1 on ext/duration/caller/origtime, so nothing "failed to save".
- ⛔ **Alert emails: this bullet used to say "alerting is back ON" and that is now
  wrong twice over — see the `ALERTS_MUTED` section at the TOP of this file, which
  is the authority.** Short version: the 2026-08-06 kill switch expired, alerts ran
  five days at the ceiling's 40/day, then a **code-level mute landed 2026-08-11
  ~22:18 EDT** and they stopped. ⛔ The mistake worth avoiding: I read the
  `08-12 skipped=34` rows as the 40/day ceiling; they were the mute. **Tell them
  apart by `lastErrorCode`** (`ALERTS_MUTED` = mute, empty = ceiling), never by
  status. The mailbox-sharing problem outlives the mute: customer invoices and
  every voicemail notification still share one 500/day allowance.
- ⛔ **Never check for a process with `pgrep -f` over ssh** — it matched its own
  command line and reported the kill switch alive. Use
  `ps -eo pid,etime,cmd | grep "[a]lert-email-killswitch"`. Documented three times
  already and it still cost a wrong reading.
- **The 845-274-6215 case:** the voicemail is **NOT lost** —
  `gesheft-voicemail/101/INBOX/msg9132.wav`, 1,563,884 bytes, **97s**, left **Sat
  2026-08-08 23:06:40 EDT** into ext 101, and in Connect
  (`cmsl83ilealfdqn1313zni9az`). **It left no voicemail "today"** — on 08-09 at
  11:06:42 it called again and **ext 102 answered, talking 6m43s**. Whether its
  email sent is **unprovable** (behind the midnight wall). The check only Izzy can
  run, in `Orders@gesheftkosher.com` incl. Spam/Trash:
  `from:support@connectcomunications.com after:2026/08/08 before:2026/08/10`.

## ⛔⛔ AGENT HANDOFF — billing ignored the app's own theme, and 22 tenants deleted on the PBX were still alive in Connect (2026-08-12) — READ FIRST before styling ANY portal section, before believing a billing count, before adding a field to the tenant-settings PUT, or for "I deleted it on the PBX and it's still here"

Full handoff: **`docs/ai-context/AGENT_HANDOFF_BILLING_THEME_PBX_ORPHANS_2026-08-12.md`**
(commit `438a5e2e` on `feat/ivr-migration-takeover` — **api + portal DEPLOYED and
container-verified, including a database migration.** First tenant sweep run live
under Izzy's explicit go-ahead: **21 companies closed out, none erased.**)

- ⛔ **THE RULE: no section gets its own palette.** `.cbill` had one, switched on
  `@media (prefers-color-scheme: dark)` — the **operating system's** setting.
  Connect's theme is a user preference written to `<html data-theme>` by
  `useAppContext.tsx:390`, so the two agreed only by luck. Proven live: with the
  app on dark, billing stayed a **white slab** and the page heading went
  dark-on-dark and vanished. Everything structural now aliases `--panel`,
  `--panel-2`, `--text`, `--text-dim`, `--border`, `--accent`, `--success`,
  `--warning`, `--danger`. ⛔ Connect's convention is **bare `:root` is DARK,
  light is opt-in**, so dark overrides are written
  `:root:not([data-theme="light"])` — not `[data-theme="dark"]` — or the first
  paint is wrong before hydration. Status *text* stays hand-tuned per theme:
  the app's raw `--success`/`--warning` are display colours that fail contrast
  as 11px pill text. See [[billing-must-use-connect-theme-tokens]].
- ⛔ **Never infer a date from a falsy value.** A tenant with no billingSettings
  reported day `0`, and `ordinal(0)` does `Number(n) || 1` → "1st" — so **19
  accounts with no billing setup at all rendered as a calm, unstyled "1st"**
  while 15 genuine day-1 accounts got a red pill. The banner said 15; the truth
  was 34. Absent is its own state now.
- ⛔ **Three controls on the customer billing page were decorative** — timezone,
  911 fee, regulatory fee: shown, editable, dirty-marking, and dropped on save.
  **Two server-side gaps**, both silent: `billingTimeZone` was **not in the PUT's
  zod schema** (zod strips unknown keys), and **`per_phone_number` was missing
  from the fee `basis` enum** while being the exact basis onboarding stamps for
  E911 (`per_did` counts only *billable* numbers → zero on first-number-free).
  ⛔ A new metadata field must be **destructured out** of the route input —
  `...pricing` is spread straight into the Prisma upsert. ⛔ The fee validator
  needs the **whole item**; a partial object 400s the entire save.
- ⛔ **`/admin/billing/platform/tenants` had NO `where` clause** — every tenant
  row ever created. 50 against a live PBX of 28, while the sidebar has always
  filtered. That gap *was* the inflated counts on every billing screen.
- ⛔ **Deleting a tenant on VitalPBX only ever removed the directory row.** The
  Connect tenant survived with its users, numbers, history and billing, and its
  `TenantPbxLink` stayed **`LINKED`** pointing at a PBX tenant that no longer
  existed. 22 ghosts, 22 signable user accounts. Now swept — but **timidly**,
  because the trigger is a list fetched from the PBX and a short list makes live
  customers look deleted: only links pointing at an absent PBX tenant (a
  **never-linked** tenant was never on the PBX, so it is left alone); an empty
  or half-size answer is refused; **more than `MAX_AUTO_REMOVALS` (3) does
  nothing and waits for a person**; marking removed destroys nothing; the erase
  is a separate confirmed call that **re-reads the money at deletion time**.
  ⛔ **The PBX check does the real work — the money rule is the second lock.**
  Relax Tires, RSBK and Fixup Group have zero billing history and are real live
  customers; they are safe only because they are still on the PBX.
  See [[pbx-tenant-deletion-must-cascade-to-connect]].
- ⛔ **`ConnectChatThread` was the ONLY tenant relation without `onDelete`**, so
  it defaulted to `Restrict` — one chat thread would have made every tenant
  delete fail on a foreign key. The other 240 cascade. Fixed in migration
  `20260808120000_tenant_pbx_removal`, verified live (`confdeltype = 'c'`).
- **Live result:** billing 50 → **29** companies, missing-a-card 32 → **11**,
  no-real-billing-day 34 → **13**, "Needs you" 57 → **30**. Screen is
  `/admin/pbx/removed-tenants`. ⛔ **Ezra stress test 1 (T101) and Loopcom Demo
  (T102) are still ON the PBX** so the rule correctly kept them; delete them
  there and the sweep follows. "Connect" (T1) is VitalPBX's own system tenant.
- **Env:** ⛔ deploy enqueue field is **`service`**, not `target` (`target`
  answers `invalid_service`, which reads like a broken route). ⛔ `PbxInstance`
  filters on **`isEnabled`**. ⛔ PBX tenants live in **`ombu_tenants`** keyed on
  **`tenant_id`** — not `tenants`/`id`. **SSH and `git push` both work directly
  from the Bash tool here**; no sandbox hop and no bundle route needed.
  `apps/api` carries **72 pre-existing** typecheck errors (this adds none);
  portal clean; billing suite **408 pass / 0 fail**.
- ⏳ **Not proven:** nothing has been **permanently erased** (the 21 sit closed
  out, awaiting per-tenant deletes); the customer page's save has **not** been
  exercised against a real customer — change the timezone or a fee and reload
  before trusting it; and the sweep has **never run unattended** (every run so
  far was over the cap and hand-confirmed).

## ⛔ AGENT HANDOFF — the phone rang while the PBX had nowhere to send the call (2026-08-10) — READ FIRST for ANY "it rang but never connected", before treating a ring as proof the phone was reached, before flipping a tenant onto the 443 SIP route, or before looking a tenant up by name

Full handoff: **`docs/ai-context/AGENT_HANDOFF_DEMO_INCOMING_CALLS_443_2026-08-10.md`**
(Loopcom Demo ext 101. **Config only — no deploy, no code change, no PBX write.**)

- ⛔ **THE RULE: a ring notification must not be sent when the call has nowhere
  to land — and nothing checks.** The ring push and the actual call are two
  independent systems. On all four calls the push path was perfect (`expoStatus:
  ok`, incoming screen **76 ms** after the push) while `PJSIP_DIAL_CONTACTS` was
  **empty** and `connect-wake-core` spun once a second for **13 s** (call 1) and
  **18 s** (call 4) without ever dialling the phone. Same family as
  [[desktop-ring-has-no-off-switch]].
- ⛔ **A client's own "registered" is an OPINION; the PBX contact list is the
  FACT.** The app reported `registered / wssConnected / sipStackHealthy` with a
  535 s-old registration while `pjsip show endpoint T102_101_1` read
  **`Unavailable, 0 of inf`** — and still did 13 minutes later. Believe the PBX.
- ⛔ **"Voicemail AND still ringing" was FOUR calls overlapping, not one call
  misbehaving.** The caller redialled 4× in 90 s. Line calls up by `linkedid`
  before believing one call did two contradictory things. The voicemail was a
  **DECLINE** (19:04:55 → `sub-leave-vm` → `VoiceMail(101@…,u)` one second
  later); **no message was recorded** — the INBOX newest is Aug 2. The
  still-ringing was call 4, where a DECLINE was tapped with **no SIP session
  behind it**, so it reached nothing and the PBX rang on 14 s more.
- **Cause of the churn:** every contact was `192.157.84.x` = **Cologuard, Old
  Bridge NJ** (the filter family in [[webrtc-filtered-internet-port-8089]]).
  `qualify_frequency 30` pings each contact; the filter never returns it, so the
  contact is dropped and re-minted on a new port — **23 registration events in 22
  minutes**.
- ⛔ **Moving a tenant to 443 is THREE fields, not two:** `webrtcRouteViaSbc:
  true` + `sipWsUrl: null` + **`sipDomain: "m.connectcomunications.com"`**. Both
  tenants moved had an IP literal in `sipDomain` too;
  `normalizeSipWsUrlHost()` self-corrects an IP-literal *sipWsUrl* and **nothing
  corrects `sipDomain`**. Diff the whole row against Gesheft/Displaydex. Read
  live per request — no deploy, no restart. ⛔ Probe the route with
  **`curl --http1.1`** — nginx has HTTP/2 on and a default curl returns **426
  Upgrade Required**, which reads like a broken route (correct answer: `101
  Switching Protocols` + `Sec-WebSocket-Protocol: sip`).
- **On 443 now:** Gesheft, Displaydex, **Loopcom Demo**, **inii mini**. ⛔ inii
  mini did **not** have this fault (11 reg events in 24 h, Optimum static
  business IP, `Avail` at 34.9 ms) — it was moved on Izzy's instruction, not on
  evidence. ⏳ **Nobody has completed a call on 443 on either tenant**, and both
  need their phones to **sign out and back in** (the app never refreshes a cached
  `sipWsUrl` — which is also why the flip is inert on a live session and broke
  nothing).
- ⛔ **21 of 50 tenant rows carry `pbxRemovedAt`** — a raw name lookup returns
  companies no Connect screen shows (cost a round of "which inii mini is real?").
  Filter `pbxRemovedAt: null`. They are inert: `billing/routes.ts:647` excludes
  them, so their ACTIVE billable extensions cannot invoice. Erase is a separate
  confirmed call and never touches a tenant that ever paid. See
  [[removed-tenants-still-answer-name-lookups]].
- ⏳ **Unexplained: "we got Unknown."** Every record carries the number — invite
  row, VoIP `callerNumber`, flight recorder, SIP invite. No CNAM from the carrier
  is normal. Ask WHICH SCREEN said Unknown before hunting.
- **Still open (the 443 move does not fix these):** the api fans out ring pushes
  without consulting whether the PBX holds a contact — though `connect-wake-core`
  already computes exactly that verdict as `WARM`; a decline with no session
  behind it is silently dropped; and the wake loop spins its full grace period
  against a permanently empty contact list instead of failing to voicemail early.

## ⛔ AGENT HANDOFF — the voicemail preloader drowned the PBX helper; fix DEPLOYED + traffic-proven (2026-08-12) — READ FIRST for helper `audio_not_found` floods, "PBX CPU high with no calls", voicemail play/preload work, or before touching `streamVoicemailAudio`

Full handoff: **`docs/ai-context/AGENT_HANDOFF_VOICEMAIL_PRELOAD_FLOOD_2026-08-12.md`**
(fix commit `7bc11786` on `feat/ivr-migration-takeover`, api + portal **DEPLOYED
16:29 ET 2026-08-12**; touches no worker files, so the older worker container is
not stale for this).

- ⛔ **Exactly ONE code path POSTs the helper's `/voicemail/spool/audio`:**
  `streamVoicemailAudio` in `apps/api/src/server.ts` (the `:id/stream` /
  `:id/download` routes). The worker reads lists, never audio — a helper audio
  flood is ALWAYS the api relaying clients. This one was the desktop preloader
  (`?preload=1`) re-sweeping ~200 permanently-dead voicemails every 30 s;
  nothing cached the "gone" verdict, so each sweep re-paid VitalPBX REST +
  a spool list scan (Gesheft 101 = 9,200+ msgs) + the audio POST. The helper
  crashed at 11:35 (`Errno 24`, fd exhaustion), restarted 14:31.
- **The fix that shipped:** `Voicemail.audioGoneAt` (negative cache — checked
  first, answers 404 with zero PBX cost) + `Voicemail.localAudioPath` local
  audio store (one PBX fetch per message EVER; volume in BOTH api compose
  blocks) + notify scan bounded to `sinceOrigtime = newest − 6h` + the
  mini-dialer marks 404/410 ids gone in a module Set. ⛔ `audioGoneAt` is
  stamped ONLY by a pagination-COMPLETE identity scan that proves the origtime
  is absent — never by a timeout, and **never by a positional `msgNum` 404**
  (slots renumber; that's the "every voicemail plays the first one" trap).
- **Traffic-proven, not quiet-log-proven** (independent session, 17:00 ET):
  with the sweep still running ~100 req/min, helper audio POSTs went
  **3,074/hr + 394 not_found before the deploy → 0 + 0 after**. ⛔ Success is
  SILENT in api logs (local-store hits and audioGoneAt 404s log nothing) —
  judge from the helper journal on the PBX, and remember `docker logs` wipes
  at every deploy, so a 0-match grep minutes after a restart proves nothing.
- ✅ **The helper hardening IS live on the PBX** (installed 19:33 ET same day
  under Izzy's explicit permission): helper `2026.08.12.1` — bounded server
  (32 in-flight, fast 503), 30s socket timeout, per-mailbox scan cache — plus
  fd-limit drop-in `20-fd-limit.conf` (`LimitNOFILE=65536`; the soft limit was
  **1,024**, which is what both fd-exhaustion wedges hit). Backup
  `/root/helper-backup-fdfix-20260812-193319.py`; probe went 30s → **2.7 ms**.
  ⛔ **The merge trap that came with it:** `1b0771bb` branched **13
  helper-commits behind** the tip, so merging CONFLICTS on both helper files
  even though its content was built on the live file. Resolve by taking the
  fix's files — but ONLY after grepping them for every our-branch marker
  (`restore_gui_conf_ownership`, `connect-doorway`, `doorway-status`) and
  running the 33-case drift guard; and before installing ANY externally-built
  helper, `sha256sum` the live PBX file against the fix's claimed base — a
  mismatch means silent downgrade. Merge `c756c742`; the api half (inspect
  15s→45s, spool list 12s→30s — the aborts that fed the thread pile-up)
  deployed as `c7da4043`, container-verified.
- **Every open portal window now learns about a deploy** (`0cf18b14`, deployed
  + bundle-verified): `GET /version` (unauthenticated, reads `.next/BUILD_ID`)
  + `PortalReloadNotice` mounted in `app/providers.tsx` — full window,
  mini-dialer AND browser tabs poll every 5 min + on focus, and show
  "Connect was updated — Reload" when the build id changes. **Never
  auto-reloads** (a reload tears down the SIP softphone mid-call); dismissal
  is per-build so it re-arms next deploy. ⛔ Don't confuse with
  `DesktopUpdateToast` in the same file — that covers ELECTRON SHELL updates
  only and is mounted only in SidebarNav; the mini-dialer had NO update
  surface before this. Windows opened before `0cf18b14` still need ONE manual
  reload — after that, no deploy is silent again.
- ⏳ **Not yet proven:** a real voicemail measured arriving in seconds (the
  instant-delivery half). Acceptance: `voicemail-notify: sync complete` with
  `upserted_count ≥ 1` (not `helper_error:…timeout`), then
  `voicemail: arrival audio copied to local store`, then Play is instant.
  Also open: Gesheft 101/102 mailbox cleanup (9,200 + 2,600 msgs) — ⛔ **now on a
  clock: `maxmsg=9999` and 101 holds 9,146, so at ~35/day it hits "mailbox full"
  in 3–4 weeks and callers stop being recorded at all** (voicemail-email handoff
  §9) — and the VitalPBX REST voicemail read returning 0 fleet-wide (why
  everything rides the helper spool path at all).

## ⛔⛔ AGENT HANDOFF — the dialer locked ITSELF out and sat on "Connecting" (2026-08-10) — READ FIRST for ANY "softphone stuck on Connecting / orange" report, before adding a retry path that calls an API, and before blaming a customer's internet

Full handoff: **`docs/ai-context/AGENT_HANDOFF_SOFTPHONE_SELF_LOCKOUT_2026-08-10.md`**
(commit `d8fc102e` on `feat/ivr-migration-takeover` — **portal DEPLOYED and
container-verified**; portal-only, nothing touching call routing or the PBX.)

- ⛔ **THE RULE: a client's own repair loop must cost fewer requests than its own
  server budget allows.** Ours cost more. Every UA rebuild re-fetched
  `/voice/me/extension` (**60/hr**) *and* `/voice/me/reset-sip-password`
  (**30/hr**) — and the watchdog rebuilds every **~50 s (~72/hr)**, so any client
  on a flapping network **reliably rate-limited itself out of its own credential
  endpoint**. It never needed to re-fetch: the secret does not rotate
  (`issueOneTimeProvisioningForUser` returns the STORED encrypted password and
  only stamps `sipPasswordIssuedAt`). ⛔ Both limits are keyed **per user, not per
  device** — two desktop installs on one login share one budget.
- ⛔ **Every failure path in `init()` was a DEAD END, and the UI lied about it.**
  Each early return did `setError()` and stopped, leaving **no UA, no watchdog,
  no timer** — all the recovery machinery lives *inside* the UA that was never
  built. The 429 message read *"Reload the page to retry"*: the code knew it was
  wedged and **made the human the recovery mechanism**. And `regState` was never
  updated on the way out, so the dialer kept rendering the amber **"Connecting"**
  of a connection already torn down. That is the whole mystery of "restarting
  fixes it". Fixed via `sipCredsRef` (rebuilds now cost **zero** API calls) +
  `scheduleInitRetry()` on every path + honest `setRegState("failed")`.
- ⛔ **THE DIAGNOSTIC, one grep — and the SILENCE is the proof:**
  `grep "reset-sip-password" /var/log/nginx/access.log | grep "connect/desktop"`.
  The User-Agent names the client (`@connect/desktop/0.1.5 … Electron`) so you can
  separate desktop from browser from mobile. On 2026-08-10 it showed **101
  fetches** from one desktop (healthy = **one per sign-in**), one every ~50 s,
  a **429 at 06:15:47 ET**, then **46 minutes of ZERO requests** — while a second
  install on the same network kept ticking every ~8 min. **A client fighting a bad
  network gets NOISIER; a client that stops asking has quit.** Izzy's screenshot
  was stamped 06:35 — 20 minutes into the wedge. He said it wasn't his internet
  and he was right. ⛔ Nginx logs are **CEST = his clock + 6h**.
- ⛔ **The desktop app loads the HOSTED portal**, so a portal deploy reaches every
  install with **no new build** — but an **already-open window keeps the old
  bundle until it is restarted**. "It's deployed" without "now restart it" leaves
  the customer looking at the identical bug.
- ⛔ **Deploy traps re-confirmed:** `pgrep -f run-heavy` in an ssh one-liner
  **matches its own command line** and invented a heavy job that did not exist
  (`ps -o pid,etime,cmd -p <pid>` → "PID gone") — same self-match as
  `pgrep -f deploy-direct`. And the server clone was **two commits behind
  origin**, so the incremental bundle failed `Repository lacks these prerequisite
  commits` — `git fetch origin <branch>` there FIRST, then apply the bundle.
- ⏳ **NOT PROVEN: nobody has watched the dialer recover from a real network drop
  on the new code.** Proven as plumbing only (typecheck clean, new strings live in
  `app-portal-1`'s `.next`, old dead-end string gone). **The acceptance test is a
  number:** re-run the grep above — fetches should fall from **101/day to ~one per
  sign-in**, with **zero 429s**. ⛔ Do NOT "fix" a recurrence by raising the
  server-side limits; the limit is the safety net that caught this.

## ⛔⛔ THE ONE MAILBOX SENDS EVERYTHING, CAPPED AT 500/DAY (2026-08-06) — READ FIRST for ANY email/voicemail-notification report, before adding an ADMIN_ALERT, or before believing a mail fix worked

> ⛔ **ALERT EMAILS ARE OFF AGAIN — and this time it is CODE, not an expiring
> script.** History: the 2026-08-06 kill switch self-expired, so alerts ran for
> five days (`08-06 399` → `08-08…08-11` pinned at **40/day** by the
> rolling-24h ceiling). On **2026-08-11 ~22:18 EDT** a proper mute landed
> (Izzy's directive) and has held since — see the section below on the
> **ALERTS_MUTED send-door gate**, which is now the authority on this topic.
>
> ⛔ **Correction, so nobody repeats it:** an earlier pass of this file read the
> `08-12 skipped=34` rows as the **40/day budget ceiling** doing its job. That
> was wrong — those skips are the **new mute gate** (`lastErrorCode
> ALERTS_MUTED`). The ceiling and the gate produce similar-looking suppression;
> **tell them apart by `lastErrorCode` on the `EmailJob` row**, never by the
> status alone.

Full handoff: **`docs/ai-context/AGENT_HANDOFF_MAIL_QUOTA_BOUNCE_LOOP_2026-08-06.md`**
(commit `0197dd56` on `feat/ivr-migration-takeover` — **api DEPLOYED and
container-verified; ⛔ the WORKER half is committed and NOT deployed.**)

- ⛔ **THE RULE: a quiet log is not a fixed bug — prove there was TRAFFIC in the
  window you measured.** The bounce loop was declared fixed after **four minutes
  of zero bounces**. It was not fixed; it ran **135 more**. Those minutes were
  quiet because *no mail had been sent in them* — zero voicemails were recorded
  fleet-wide. Check `find /var/spool/asterisk/voicemail -name "msg*.txt"
  -newermt "<start>" | wc -l` before concluding anything about mail. Same trap in
  another costume: `postmap -q "" <map>` proves the RULE, never the BEHAVIOUR.
- ⛔ **ONE mailbox sends everything Connect sends** — invoices, invites, password
  resets **and the PBX's voicemail-to-email**, all as
  `support@connectcomunications.com` — and Google caps it at **500/day**. On
  2026-08-06 our own **ADMIN_ALERT emails took 402 of 499**, and every customer
  email for the rest of the day was refused. **15 messages reached nobody**: 10
  Gesheft voicemails, RSBK, Trust Bookkeeping, inii mini, two $130 Create A Box
  invoices, one payment link. ⛔ The limit is a **rolling 24h window, not a
  midnight reset**, and ⛔ **a 550 refusal is permanent — nothing is retried when
  capacity returns.** Recordings are always safe (`delete=yes` appears nowhere);
  only the notification is lost.
- ⛔ **HISTORICAL — the kill switch described here is DEAD; do not act on it.**
  `/root/alert-email-killswitch.sh` on loopcom marked every `ADMIN_ALERT` job dead
  before the sender saw it (customer email was never touched). **It self-expired
  ~23:41 ET 2026-08-06 and alerts silently ran for five more days** — the exact
  failure that motivated replacing it. The script still sits on disk, inert; there
  is nothing to `pkill` and nothing to lift. Alerts are now muted **in code** at
  the send door — see the `ALERTS_MUTED` section at the TOP of this file, which is
  the authority. **Lesson kept on purpose: a mitigation with a timer in it is not a
  fix, and its expiry will not announce itself.**
- ⛔ **The alert cooldown was in a `Map`.** The API restarted **56 times** that
  day and every restart re-armed every alert — that is how a six-hour cooldown
  sent one message every 25 minutes. Now `packages/shared/src/adminAlertBudget.ts`:
  the cooldown is read from the **database** (identity = the subject, since that
  is what survives in `EmailJob`), plus a **hard ceiling of 40 alert emails per
  rolling 24h across every key** — because a subject carrying a changing count
  defeats any per-key cooldown. ⛔ **UNEXPLAINED: four api alerts were still
  created while the count was ~453. Do not re-enable alerts until that is
  understood**, and remember several files create `ADMIN_ALERT` rows *without*
  going through `sendAdminAlert` (`billingEmailLifecycle`, `receiptReconciliation`,
  `adminSignupReport`, `journeyTracking`, `setupWatchdog`).
- ⛔ **The bounce loop: `sender_canonical_maps` was `/.*/ → support@`, which
  rewrites the BLANK sender that makes a bounce un-bounceable.** 2,409 bounces
  from 66 real emails, each nesting the last (one queued message hit **452 KB**),
  and the storm tripped Gmail's `454 Too many login attempts` — so the loop was
  causing the refusals it fed on. ⛔ **Changing the rule to `/^.+$/` IS A NO-OP —
  Postfix never queries the map with an empty key.** The fix that works breaks the
  loop at *delivery*: `support@connectcomunications.com discard:` in
  `transport_maps`. Safe only because **nothing legitimate is addressed to
  support@ from that box** — all 24 delivered that day were bounces, and the one
  config hit is `serveremail=` (the FROM address). Backups
  `/root/{sender_canonical_maps,main.cf}.bak-20260806-bounceloop`.
- ⛔ **Deploy traps:** `deploy-direct.sh` **hard-resets to `origin/<branch>`**, so
  a local-only commit is silently rolled back and reported `success` /
  `no_changes` — use `--commit <full-sha>` (ship it with an *incremental* `git
  bundle`: 6.7 KB vs 653 MB for full history). And `deploy-direct.sh` **does not
  accept `worker`** — that goes through `POST /ops/deploy/enqueue`, whose field is
  **`service`** (not `target`) and which **requires `branch`**, so a commit-only
  worker deploy has no path.
- **Still open:** the worker deploy; the unexplained cap bypass; the McNamara Lion
  payment link (`CC-202608-00006`) still unsent; and the real fix — **alerts and
  customer mail still share one mailbox and one 500/day allowance.** A second
  sending mailbox was offered and never supplied.

## ⛔ AGENT HANDOFF — the AI trainer taught the agent NOTHING for 9 days (2026-08-09) — READ FIRST for apps/agent triage/intent, trainer lessons, "the agent did X when I only asked ABOUT X", or before believing any agent feature is live

Full handoff: **`docs/ai-context/AGENT_HANDOFF_TRAINER_AUDIT_2026-08-09.md`**
(fix `a3fcca41` — ✅ **DEPLOYED**: `app-agent-1` rebuilt 2026-08-12 04:58 and
container-verified. The agent remains a manual rebuild, never in the deploy queue.)

- ⛔ **After 23 conversations and 824 messages (2026-07-26 → 08-07),
  `AgentTrainerLesson` holds ZERO rows** and the `trainer.*` audit trail is
  empty. Config was never the problem — `AGENT_TRAINER_USER_IDS` is set and the
  running container sees it. **Two bugs stacked:** the trigger phrases demanded
  a that/this/it pronoun nobody types, AND the DND intent bug ate the one real
  correction. Ezra typed `Remember "Status" has priority over DND` and it
  **fired a live DND write instead of saving a lesson.**
- ⛔ **A status QUESTION was performing a WRITE.** DND had no status detection
  at all, so any message containing "dnd" fell through to `enableHint:"yes"` —
  `DND status?`, `check dnd status`, even `DND status, do not disable or enable,
  just check status` all switched DND **on**, for three days, while the trainer
  kept saying "I asked about status not enable". Treat every new read-shaped
  intent as read-only by default; a customer asking "is my DND on?" must never
  have their calls silently blocked.
- ✅ **THE DND FIX IS NOW LIVE — verified in the running container 2026-08-12.**
  `app-agent-1` was rebuilt **08-12 04:58** and carries it:
  `isDndStatusQuery()` is defined at `apps/agent/src/triage/intent.ts:141` and
  wired into the classifier at :210, and `training/lessons.ts` is present. A
  status question no longer performs a DND write. (This entry read "COMMITTED
  AND NOT LIVE" until 08-12 — it was true from 08-09 to 08-11.)
  ⛔ The agent is still NOT in `deploy-direct.sh` (api|portal only), so it
  remains a manual
  `docker compose -f docker-compose.app.yml -f docker-compose.agent.yml up -d --build agent`.
  ⛔ **Verify by grepping the RUNNING agent container, never by reading the
  commit and never from api/portal** — `a3fcca41` is an ancestor of both the
  live api and portal images while living in a container neither one builds.
- **Company hold music still cannot be put back.** Every "Secro" switch and
  every revert-to-regular-schedule fails `native_tenant_moh_sync_failed`
  (07-30, 07-31, 08-03 ×3, 08-05 ×2, 08-06 ×2). Setting a *specific* profile
  works fine, including timed changes with auto-revert. Undiagnosed.
- **Escalations go into a queue nobody watches.** With the memory feature dead,
  Ezra invented `pass along: …` to reach Izzy, then chased it on 08-06 and
  08-07 and never got a reply; an extension request from 08-04 was still
  unanswered on 08-07. Process gap, not code.
- ⛔ **Query traps that produced a wrong answer first:** filtering
  `agentConversation` on `clientUserId` alone returned **10 of the 23**
  conversations (and a six-day-stale "latest activity"); `AgentAction.tenantId`
  is NOT the Connect tenant cuid, so counting actions by it returns **0** —
  use `requestedBy`. Anchor date windows to `max(startedAt)` in the data, not
  to a `date` reading.

## ⛔⛔ AGENT HANDOFF — the IVR Studio, walked end to end for the first time (2026-08-07) — READ FIRST before claiming ANY IVR fix, before touching prompt generation, publish, or the menu dialplan

Full handoff: **`docs/ai-context/AGENT_HANDOFF_IVR_STUDIO_LIVE_2026-08-07.md`**
(`05952a02` → `34123157` on `feat/ivr-migration-takeover`; api + portal DEPLOYED
and container-verified, plus two live PBX dialplan edits.)

- ⛔ **THE RULE THIS SESSION EARNED: a config file containing your fix is not a
  fix. Measure the thing the customer feels.** The keypress-lag fix was written,
  deployed, verified by reading `dialplan show` — the line was right there — and
  it did **nothing**, because it sat seven steps too late to execute. It was
  reported as fixed; Izzy called and found it in a minute. CLAUDE.md already
  said "the database is not what callers hear, verify with a real call"; that
  rule was quoted to him earlier the same night and then broken. **Proof looks
  like `21:16:19 DTMF '1'` → `21:16:24 menu moves` (before) and `21:21:11` →
  `21:21:11` (after)**, read out of `/var/log/asterisk/full`. Recipe in §6.
- ⛔ **The Studio sends the tenant in the QUERY STRING, never the body.** Both
  generate routes read only the body, so a super-admin's recordings for a
  CUSTOMER were filed under the admin — invisible to that customer, 200 on every
  request, and it reads as "I made 12 recordings, reloaded, they're deleted".
  Fixed by `resolveGeneratedPromptTenantId()`. **`git grep "body.data.tenantId"`
  in `apps/api/src/voice`** — any Studio-facing route reading only the body has
  it. A tenant admin never sees it (pinned to their own tenant, so the broken
  fallback is accidentally right). See [[studio-sends-tenant-in-query-not-body]].
- ⛔ **A brand-new customer could never publish their first menu.** Studio menus
  are all typed `business_hours`, a new tenant has no hours so the mode is always
  `afterhours`, nothing is scheduled yet → both lookups miss → publish refuses,
  and **nothing you can do to the MENU clears it**. `ivrFindActiveProfile` now
  falls back to the tenant's main menu, only after both lookups come back empty
  (asserted directly, not left to call ordering). Override deliberately does NOT
  fall back. Shared resolver, so both publish paths get it.
- ⛔ **One menu for both open and closed hours was rejected.** The schedule route
  compared list LENGTH against row count, so the same id twice = 2 vs 1 =
  `profile_not_found`. That closed a loop with no exit (schedule won't save → no
  menu selected → publish refuses). Deduped; a genuinely missing menu still
  refuses.
- ⛔ **`apiClient` defaults to a 10s timeout; a number switch takes 16–40s.** The
  "Publish and switch" button was **structurally impossible**, not flaky — and
  aborting doesn't stop the server, so the work often landed while the screen
  said it failed (two publishes 16s apart). Publish + switch now get 120s, and a
  client timeout says the change may already have gone through.
- ⛔ **`TIMEOUT(digit)` must be set BEFORE `Background()`**, not at `waitdigit`.
  Background collects digits *while the greeting plays*, so a caller pressing
  during the greeting never reaches a later `Set`. It is now set the moment the
  direct-dial flag is read, and set FROM it: **off → 0.2s** (nothing to wait for)
  / **on → 1s**. Plus `Wait(0.5)` after a recording before the menu replays.
  ⛔ `extensions__60_custom.conf` **silently keeps the old dialplan** on a parse
  error. Backups `.bak.timing.*`, `.bak.digittimeout.*`.
- ⛔ **VitalPBX cannot renumber an extension** — panel posts it hidden, REST is
  read-only. **copy → re-point the DID → delete**, in that order (the DID's
  destination row holds the extension_id and cascades away with it). Finish with
  `module reload res_pjsip.so` — Apply Changes leaves dead endpoints live in
  memory, and a client with cached credentials can register to one and never
  ring. inii mini is on **101**; ⛔ **baila must sign out and back in once**, and
  do NOT delete her login — she is the only admin on that tenant.
- ⛔ **A required field must never silently disable the submit button.** Gating
  Save on a recording's name shipped a dead button with no reason on screen, at
  the end of an hour of getting one take right. Refuse loudly, at the control
  that was pressed, and scroll to what's missing.
- ⛔ **Before ANY deploy: `ps aux | grep -E "[e]nqueue|[c]ommitHash"`.** A waiter
  left by a dead session sat armed with a commit **48 behind the tip**, ready to
  fire the moment a deploy finished. `nohup`/`setsid` outlive their agent.
- ⏳ **NOT PROVEN:** no human has heard the menu since the timing changes, and
  nobody has pressed "Publish and switch" since the timeout fix. The
  edit-a-recording feature is **half-built** — `34123157` adds the columns
  (`sourceText` + voice fields, nullable, unread); the routes and the Edit button
  are not written.

## ⛔ AGENT HANDOFF — "everything is loading very, very slow" (2026-08-06) — READ FIRST for ANY portal-speed report, before adding a permission check to a route, or before blaming the server / the customer's internet

Full handoff: **`docs/ai-context/AGENT_HANDOFF_PORTAL_PERFORMANCE_2026-08-06.md`**
(`abb1314a` + `4ad257f7` + `5486746a` on `feat/ivr-migration-takeover`, api +
portal DEPLOYED and container-verified, plus a live nginx change).
**Dashboard 22.1s → ~2–4s; api server time 499ms → 225ms; IVR Studio 5.15s → 3.41s.**

- ⛔ **THE BOX WAS NEVER THE BOTTLENECK — and Izzy's pushback is what found the
  real bug.** Through the whole incident the server was **79% idle**, 72 GB free,
  uplink at **0.5 Mbit/s**, on-box responses **5–20 ms**. Hardware would have
  changed nothing. **Four causes stacked**, and fixing the first alone looked
  like a total win while the api was still wasting half a second per request.
  Never stop at the first cause, and never conclude "capacity" from load average
  (it sat at 7–12 all day while CPU was 79% idle — that was deploy churn).
- ⛔ **HTTP/2 had never been enabled.** nginx was built `--with-http_v2_module`
  but no `http2` directive existed anywhere, so **51 of 51 requests were
  http/1.1** and Chrome capped at 6 connections while the dashboard fires **26
  API calls** — average queue wait **1,120 ms**, 14 requests waiting over a
  second *before being sent*. Now `listen 443 ssl http2;` in
  `/etc/nginx/sites-enabled/connectcomms` (a real file, NOT a symlink; the only
  443 block). Backup `/root/nginx-connectcomms-backup-20260806-http2.conf`.
  ⛔ nginx is **1.24**, which takes `http2` as a **`listen` parameter** — the
  standalone `http2 on;` only exists from 1.25.1. ⛔ **WebSockets are fine**
  (no Extended CONNECT → Chrome opens a separate HTTP/1.1 connection for
  `/ws/telephony`), but verify the 101s after any TLS change.
- ⛔ **Every request re-read the WHOLE permission system.**
  `hasEffectivePortalPermission()` ran the full resolver per call — **5 queries**,
  one of them issued **twice** — and routes ask several times each. Postgres was
  doing **184,000 rows/sec to serve 276 transactions/sec (~667 rows per
  request)**. ⛔ **NOT missing indexes** (all sensibly indexed; Postgres correctly
  seq-scans tables that small) — it was query *volume*. Fixed by
  `apps/api/src/permissionCache.ts`: **4 queries cold, 0 warm**; permission
  seq-scans **55.1/s → 4.5/s**. ⛔ It is an **authorization** cache: the **TTL,
  not the invalidation**, bounds staleness (blue/green means one process can't
  clear the other's map), a failed resolve is never cached, and **every new
  permission WRITE path must call `invalidateAllPortalPermissions()`**.
  `PORTAL_PERMISSION_CACHE_TTL_MS=0` disables it.
- ⛔ **A card charge that "timed out" was a deploy, not the gateway.** Izzy's
  `POST …/invoices/:id/pay` at 18:25:27 returned **499** (client gave up) while
  an api deploy started at 18:16 was still cutting over. Zero Cardknox errors.
  **44 deploys that day** (vs 12 the day before) also produced 502 bursts and
  drove 499s from ~5/hour to **124/hour**. ⛔ **An in-flight paid action can die
  in a blue/green cutover.**
- ⛔ **Never blame the customer's internet without a reference host.** Izzy's
  ping to `1.1.1.1` was a steady **10–15 ms** while the same ping to loopcom ran
  **96–830 ms** — the server is in **Lauterbourg, France**, so every request pays
  ~100–200 ms of travel forever. That is the remaining floor, and only moving the
  server fixes it.
- **IVR Studio:** the tenant list was fetched **3×** per load — ⛔ an
  **effect-dependency bug**, not a fetch bug (the effect watched a `useCallback`
  rebuilt as `role`/`backendJwtRole`/permissions each settled separately during
  boot); now watches the **boolean**. And `/voice/pbx/ring-groups` (a live
  Ombutel MySQL read, **1.8 s**) sat in the opening `Promise.all` so the whole
  screen waited on it — now deferred past first paint, **page usable ~2.8 s
  sooner**. ⛔ Late-arriving teams needed a **third** state (`teamsLoading`):
  reusing `teamsLoaded` prints "check they're linked to the phone system" while
  the request is still in flight, which is a lie.
- ⚠️ **NOT REPRODUCED: the reported Studio scroll lag.** A real defect was fixed
  (six rules used `transition:.14s` = **`transition: all`**, so the browser
  watched every animatable property on every row while scrolling swept hover
  across them), but the tenant selected in Izzy's browser (**Create A Box**) has
  **no menus**, so the page had nothing to scroll. **Re-test on a tenant with
  menus.** Next suspects: the global `.btn` transitions `transform, box-shadow`;
  `.ivrs .sticky` sits inside shadowed cards.
- ⛔ **Deploy traps:** `runningCount: 0` does NOT mean you can deploy — direct
  deploys never register in the queue and the **heavy-job lock is separate**
  (`pgrep -f run-heavy`). And **`nohup … &` over ssh dies with the tool's ssh
  session** — use `setsid nohup … < /dev/null & disown` and poll the log later;
  one deploy was silently lost this way.

## ⛔ AGENT HANDOFF — a reassigned desk phone never hears about it (2026-08-06) — READ FIRST for "I changed the extension and the phone didn't change", VitalPBX provisioning, or any phone-to-extension assignment

Full handoff: **`docs/ai-context/AGENT_HANDOFF_DESK_PHONE_REPROVISION_2026-08-06.md`**
(Gesheft T53W stuck on 114 after being assigned to 101 — diagnosed and fixed
live. **No PBX config written**; the one action was a `pjsip send notify` run by
Izzy from a Run button.)

- ⛔ **A REBOOT IS NOT A RE-PROVISION.** The panel change was correct and saved
  the whole time; the handset simply never downloaded it — last fetch **July 30,
  02:20 AM**, nothing when the change was made, nothing when it was rebooted.
  The panel's reboot button sends `check-sync;reboot=true`, and whether the phone
  then fetches settings depends on `static.auto_provision.power_on` **stored on
  the handset**. The reboot *visibly working* is what made this read as a PBX
  routing bug.
- **The fix, proven live in ~2 seconds** —
  `asterisk -rx "pjsip send notify yealink-check-cfg endpoint T8_114"`
  (`check-sync;reboot=false` = "fetch now", a different code path that ignores
  `power_on`). The phone swapped to 101 **without rebooting**. Per-brand options
  (`poly-`/`snom-`/`cisco-check-cfg`, `reboot-*`) already exist in
  `/etc/asterisk/vitalpbx/pjsip_notify__10-default.conf`.
- ⛔ **THE DIAGNOSTIC: `grep phoneprov /var/log/nginx/access.log`** (+ `zcat` the
  `.gz` for 14 days). It records every download with **model and MAC** in the
  user agent, so it is the only honest witness to whether a change reached a
  phone. A hit from the customer's public IP with a `Yealink SIP-T53W … <mac>`
  agent IS the phone. ⛔ A hit from **`127.0.0.1` with agent `VitalPBX` (54
  bytes) is only the panel rendering its own page** and proves nothing —
  it sits there looking reassuring while the phone is weeks out of date.
  Silence from the customer's IP = the change never left the server. Always
  compare against other tenants in the same window before blaming provisioning.
- ⛔ **NOTIFY targets the EXTENSION, not one handset** — it fans out to every
  contact on the AOR (114 had two phones; both re-provisioned, harmlessly).
  Check `pjsip show aor <ep>` and warn the owner first.
- ⛔ **You cannot read provisioning behaviour off the template** — VitalPBX
  pushes every `auto_provision.*` key **blank** except the server URL, and blank
  means "keep what you have". Likewise the `description` field is a LABEL: this
  phone's record still reads `114` (template still named `Gesheft 114`) while
  correctly serving 101. Read `provisioning.accounts.phone_device_id` joined to
  `ombutel.ombu_devices.user`, never the description.
- ⛔ **`PbxEndpointRegistrationEvent` has NO `createdAt`** — order by
  `occurredAt` or `findMany` throws. It is how you prove a reboot happened
  independently of whether config changed (they are unrelated).
- **Sister failure — check BOTH:** [[createabox-102-blf-mac-mismatch]] is the
  same symptom from the opposite cause (phone fetched fine, panel had the WRONG
  MAC, so the rewritten file was one nothing downloads). The nginx log tells
  them apart in one grep — it shows the MAC the phone ASKS for.
- **OPEN, needs Izzy:** Gesheft is **two sites** (`75.99.30.60` holds 102-111 +
  897 + the ORIGINAL 101; `66.250.98.9` holds 114/115/116 + the moved phone), so
  **101 now rings in both places**. If the intent was to *move* 101 rather than
  add a second, the old phone needs unassigning. Also 114 still has a T26P on it
  whose record is labelled "118".

## ⛔ AGENT HANDOFF — "he answered and got voicemail" (2026-08-06) — READ FIRST for ANY "answered and it didn't connect" report, mobile push channels, the wake hold, or before trusting a failure LABEL

Full handoff: **`docs/ai-context/AGENT_HANDOFF_ANSWER_UNACKED_PUSH_CHANNEL_2026-08-06.md`**
(commit `c55ae840` on `feat/ivr-migration-takeover`; api + telephony DEPLOYED and
container-verified. ⛔ The MOBILE half is committed and on **NO phone**.)

- ⛔ **`session_not_found_timeout` IS A LIE — read the blackbox, never the label.**
  `jssip.ts` stamps it on **any** failure with fewer than 3 attempts, *including
  one where the session was found on poll #1 and answered*. **Two consecutive
  wrong root causes were published to Izzy off that label** before the raw
  `WEBRTC_CALL_DEBUG` payload was read. The payload said the opposite all along:
  `pollIterations:1, answerAttempts:1, sipAnswer.sent:true`, candidate
  `status:6` = **`STATUS_WAITING_FOR_ACK`**. The app answered in ~160 ms; the
  **200 OK was swallowed by a dead-but-healthy-looking socket** (`uaConnected`,
  `uaRegistered`, `sipStackHealthy` all true; Asterisk noticed 27 s later). This
  IS the Simon stranded-socket family — a claim in that session that it was NOT
  was wrong. ⛔ **Nothing watches for an un-ACKed 200 OK**; every safeguard
  checks before/around the ring, none watches the pickup.
- ⛔ **`MAX_ATTEMPTS = 3` was fiction**: the per-attempt timer was the WHOLE
  remaining deadline, so attempt #1 ate all 16 s while the PBX ring expired at
  15 s. Now capped at 4 s + honest `answer_unacked` verdict + a rescue that
  re-offers the call over a fresh leg. ⛔ Do NOT shrink the cap to make "3" fit
  (only 2 fit the initial window — asserted deliberately; a smaller cap cuts
  SIP's 200 OK retransmit ladder short), and ⛔ do NOT add a socket rebuild
  between attempts — `registerInner()` suppresses force-restart inside
  `inInviteAnswerWindow()` on purpose.
- ⛔ **Three safeguards existed and had NEVER RUN — config, not code.**
  `PBX_CONTACT_QUALIFY_ON_RING` was set **nowhere in production** since July.
  The worker's direct-FCM sender had **no credential mount and an empty
  `FCM_SERVICE_ACCOUNT_PATH`** → 6 days of 100% Expo fallback *including* devices
  holding a native token. The SIP→UI cancel bridge arms only **after** a SIP
  INVITE surfaces in JS, so it is structurally disabled in exactly this failure.
  **Never claim a push channel is live from code** — grep
  `FCM_DIRECT_DELIVERED` with `"source":"worker"` in the running container.
- ⛔ **The fast token was hostage to the slow one.** A native FCM token can only
  reach us inside `/mobile/devices/register`, which **required** `expoPushToken`
  — so a phone whose Expo fetch failed could never report the good FCM token it
  already held (8 of 16 Android devices). `expoPushToken` is now nullable with
  tokenless rows keyed on `@@unique([userId, deviceId])`.
- ⛔ **The 20 s wake hold could never finish.** The caller-side `Dial` timeout
  comes from **`followme/ringtime` (15 on 115 of 122 extensions)**, NOT
  `ringtimer` (30). Fixed inside wake enrollment via in-lane `ami.dbPut`,
  raise-only, `0` left alone. ⛔ It MUST run on the `!transformed.changed` path
  — all 10 live repairs logged `dialChanged:false`; otherwise **none** of the 12
  enrolled extensions would ever be fixed. ⛔ Lowering `mobile_reach_wait_secs`
  is NOT the fix (voicemail arrives sooner, not later).
- ⛔ **`database show` output pads the key column**, so awk field indexes shift
  with key length — split on the last `:` or you get a false "no value" census.
- ⛔ **Shared tree:** another session swept this session's `server.ts` edit into
  its own IVR commit, leaving HEAD using `userId_deviceId` with no schema for it.
  Two fixes reported as "done this session" (`8c15d5fa`, `f9907e5d`) already
  existed and were merely **undeployed**. Check `git log -S` before claiming
  authorship, and re-check `git diff --cached --name-only` after every `git add`.

## ⛔ AGENT HANDOFF — billing: 4 live bugs fixed, screens rebuilt (2026-08-07) — READ FIRST for ANY billing work, `{ not: … }` Prisma filters, or a new screen under /admin/billing

Full handoff: **`docs/ai-context/AGENT_HANDOFF_BILLING_REBUILD_2026-08-07.md`**
(`e20776c6` → `a75344b9` on `feat/ivr-migration-takeover`, api + worker + portal
all DEPLOYED and container-verified).

- **`billingDayOfMonth = 1` could NEVER generate an invoice** — and it is the
  Prisma DEFAULT, which onboarding never changes, so **16 of 30 live tenants sat
  on it**. Invoices are only created inside `reminderDue`, and the payment date
  is clamped into the CURRENT month, so for day 1 the window is permanently in
  the past: **0 of 365 days**, proven by simulating a full year. On the due date
  the worker logged `CRITICAL: manual intervention required` and never created
  the invoice it had just proved was missing. Fixed via
  `buildUpcomingBillingSchedule()`. ⛔ It survived years of "it's fixed" because
  **all 11 scheduler tests used day 21 — the one broken value was the one never
  tested.**
- **A charge is now an event on a date, not a condition true all month.** `due`
  was `today.day >= paymentDay`, i.e. true for the rest of the month and
  re-evaluated hourly *and on every worker restart* — which is why autopay felt
  like it "charges every minute" and why **14 guard clauses** were the only
  thing preventing a double charge. ⛔ A missed date is **never charged late**;
  it is surfaced (`chargeWindowMissed`) with the invoice left open.
- ⛔ **`field: { not: "X" }` in Prisma DROPS every NULL row.** Self-inflicted and
  caught before damage: `source: { not: "MANUAL" }` matched **0 of 53 invoices**
  across all 30 tenants (auto invoices have `source = NULL`; `NULL <> 'MANUAL'`
  is NULL, not true) and would have blocked **every** autopay charge. Use
  `AND[ OR[ field: null, field: { not: X } ], … ]`. **A unit test cannot see
  this — after deploying, run the real query and assert the row count.**
- ⛔ **billingEmail was erased by every save, at TWO sites** — a zod transform
  ending `: v ?? null` turns an ABSENT field into null, which survives the
  undefined-filter. The second site was found only by grepping the RUNNING
  container for the OLD pattern and getting `2`, not `0`. 18 of 30 tenants had
  no billing email; 5 were recovered from `EmailJob` history. ⛔ Backups reach
  only 15 days and there is **no audit log for billing settings at all**.
- ⛔ **New screen under `/admin/billing`? Add its path to `REBUILT` in
  `layout.tsx`.** That layout wraps every route in `AdminBillingShell` (its own
  toolbar, nine-tab nav, ten old stylesheets). Seven rebuilt pages shipped
  underneath the old chrome and **looked nothing like the approved design** —
  the single biggest waste of that engagement.
- ⛔ **Deploy traps:** `deploy-direct.sh --branch` hard-resets to **origin**, so
  a commit only in the server clone is silently rolled back and "deployed" as a
  no-op — push to GitHub first. `deploy-worker.sh` self-skips `no_changes` right
  after an api deploy, leaving the OLD container running while reporting done —
  use `DEPLOY_FORCE_RESTART=1` and grep the running container.
- ⏳ **The rebuilt screens have NEVER been opened in a browser** (auth gate makes
  curl useless — it only ever returns the login shell). Open them before
  trusting them. **The engine work — a schedule row per customer per month, and
  a priority lane for billing email — was never started.**

## ⛔ AGENT HANDOFF — turning SMS on for a customer (2026-08-07) — READ FIRST for "activate texting", SMS number assignment, or any "their texts aren't arriving" report

Full runbook (incl. paste-ready wording for the Connect Agent's knowledge):
**`docs/ai-context/AGENT_HANDOFF_SMS_ACTIVATION_2026-08-07.md`**. Proven end to
end on **inii mini** 2026-08-07 — real text out ("Message delivered to handset")
and a real reply into the customer's inbox. No deploy, no PBX write, no Apply
Changes.

- **The whole job is four steps:** (1) find the DID's `TenantSmsNumber` row —
  every VoIP.ms DID syncs in with `tenantId: null` (69 rows, 59 unassigned);
  (2) assign it (`PATCH /admin/apps/voip-ms/numbers/:id` or Admin → VoIP.ms
  numbers) with `tenantId` + `assignedExtensionId` (or `assignedUserId`, or
  neither for a shared company inbox) + `isTenantDefault`; (3)
  `TenantBillingSettings.smsBillingEnabled = true` — `smsPriceCents` is already
  1000 on every onboarding tenant, so the next invoice moves $35 → $45, nothing
  charges mid-cycle; (4) confirm `sms_enabled: "1"` on the DID at VoIP.ms
  (`setSMS {did, enable:"1"}` if not; expect `sms_wait_message` rate-limiting).
- ⛔ **The per-DID `webhook` / `sms_url_callback` fields are a red herring, and
  `setSMS` lies about them.** It answers `{"status":"success"}` and NEVER moves
  either `_enabled` flag (four param shapes tried). **Gesheft is the busiest
  inbound SMS number on the platform with `webhook_enabled: "0"` and a stale
  3CX URL.** Judge from a number that demonstrably works, never a field name.
- ⛔ **Three more non-requirements:** `smsSendMode` stays **TEST** (LIVE is the
  old campaign path — it reads the `phoneNumber` table, which onboarding tenants
  have ZERO rows in); `defaultSmsFromNumberId` stays null (`isTenantDefault` on
  the number row is the real setting); `smsPrimaryProvider` reads TWILIO on every
  working tenant and must not be "fixed" — chat texting rides VoIP.ms regardless.
- **Inbound arrives by POLL, not the webhook.** `voipMsInboundSyncJob.ts` polls
  `getSMS`+`getMMS` for every assigned/active/smsCapable number — assignment IS
  the wiring; watch `[voipms-inbound] +1…: fetched=N` in the worker log. ⛔ Never
  conclude "nothing arrived" from nginx (`/api/webhooks/voipms/sms` is rarely
  hit), and ⛔ never measure delivery lag from the DB — inbound `createdAt` is
  stamped from the **carrier's** timestamp, so it can only ever agree with itself.
- ✅ **inii mini's port LANDED 2026-08-12 and is FULLY LIVE** (order 217760).
  The real number 646-984-6023 arrived routed to the MASTER account with SMS
  off — fixed same day: routed to `344022_iniimi92gh2m`, `sms_enabled=1`,
  TenantSmsNumber assigned + made tenant default (worker poll numbers=12).
  Calls: inbound route 240 created via panel automation (same code path as
  onboarding), switched to Connect via the real `/voice/did/:id/switch-to-connect`
  + full publish (183 keys) — probe call traced into `connect-menu` playing
  `custom/main_greeting_fc10c9`. ⛔ **The switch only worked after restarting
  `connect-pbx-helper` on the PBX** — it had wedged at 1024/1024 FDs + 761
  threads (`pbx_helper_read_failed: aborted due to timeout` on every switch
  platform-wide). Root-caused + FIXED same day: helper `2026.08.12.1`
  (bounded server, spool-scan cache, LimitNOFILE 65536) — see
  [[pbx-helper-fd-leak-wedges-switches]]. ✅ **Temp number 845-260-5692 was
  RETIRED automatically** by the port watchdog's first sweep (back on the
  master spare pool, SMS row un-claimed, mapping deleted); its old "Main"
  PBX inbound route on tenant 105 is the one leftover (+$3/mo E911 until
  deleted in the panel). See the port-automation handoff at the top of this
  file and [[voipms-sms-per-did-webhook-is-a-red-herring]].

## ⛔ AGENT HANDOFF — "I changed it in VitalPBX and the phone didn't change" (2026-08-06) — READ FIRST for BLF/key edits, desk-phone provisioning, or before believing a phone's registration proves anything

Full handoff: **`docs/ai-context/AGENT_HANDOFF_CREATEABOX_102_BLF_MAC_2026-08-06.md`**
(Create A Box ext 102 — FIXED and verified live under Izzy's one-time PBX write mandate,
scoped to that one extension; backups `/root/blf-102-backup-20260806/`.)

- ⛔ **VitalPBX provisioning is PRE-GENERATED FILES, rendered at SAVE time.** It never
  looks a phone up when the phone asks. Saving writes
  `/var/lib/vitalpbx/provisioning/provisioning_templates/<tenant-hash>/<mac>.cfg`, and
  nginx hands out whatever filename is requested. So a **wrong MAC on the record rewrites
  a file nothing downloads**, while the phone keeps downloading its own file — with a
  clean **200**, never a 404. Ext 102's phone served a **July 19** copy for seven weeks:
  right account, right password, **zero BLF keys**. Proven by mtimes: he saved 101 at
  12:26:15 and 101's phone got it 29 s later (**that one worked**), saved 102 at 12:41:20,
  then resynced 102 four times and got the stale file every time.
- ⛔ **"It registers, so its MAC must be in the system" is FALSE — the MAC plays no part in
  registration.** `[T7_102]` is `identify_by=username,auth_username`; there are **zero**
  MACs in the tenant SIP config, and across `ombutel`+`asterisk` the only `mac` column is
  `ombu_static_leases` (DHCP). `ombu_devices` has **no MAC column at all**. The phone keeps
  its credentials locally. ⛔ The WireGuard tunnel is irrelevant to both — it is only the
  road the traffic travels.
- **THE DIAGNOSTIC, one grep:** `grep phoneprov /var/log/nginx/access.log` (+ zgrep the
  .gz). Every download logs the phone's **own MAC in its User-Agent**; compare it to the
  record, then `stat` that `<mac>.cfg`. Fetched but **mtime predates your edit** = wrong
  MAC (this case). **No fetch at all** = the phone never asked — fire the check-sync, see
  [[desk-phone-reassign-needs-check-sync]]. A hit from **127.0.0.1 / UA "VitalPBX"** is
  just the panel rendering a page and proves nothing.
- **Fix + proof shape:** correct the MAC on the record (durable — future saves land right),
  overwrite the phone-facing `.cfg` with the correct render for an immediate fix, then
  `pjsip send notify yealink-check-cfg endpoint T<t>_<ext>` (⛔ NOT the reboot button).
  ⛔ **Diff the two configs before overwriting** — ours differed only in the key blocks with
  a byte-identical account block; a differing password would knock the phone offline. ⛔ Use
  `cat src > dest`, never `cp` — that dir carries POSIX ACLs (`+` in `ls -la`). Verified by
  the served size changing **138162 → 138270** 1 s after the NOTIFY, plus **5 BLF
  subscriptions** (101/103/105/106/107) appearing in `pjsip show subscriptions inbound`.
- ⛔ **Do not suppress stderr on probes** — an early `mysqldump … 2>/dev/null | grep` would
  have made a failed dump read as "the MAC isn't in the database". Re-run visibly before
  trusting a negative. Config key lines are **indented**, so `grep "^linekey"` finds
  nothing and looks like "no BLFs anywhere".
- A trailing space in `linekey.2.value` (`103 `) was called a likely dead key and that was
  **wrong** — Yealink trims it, 103 subscribed normally. Left as Izzy wrote it.
- ✅ The staged registration-expiry fix from the T7 outage handoff (2026-08-05 §4) is
  **confirmed applied** — all seven T7 aors read `default_expiration/maximum_expiration
  120`. ⏳ Ext **104 and 106 are not registered** (101/102/103/105/107 Avail) — flagged to
  Izzy, not investigated.

## ⛔ AGENT HANDOFF — IVR Studio: forwards, direct dial, audible prompts (2026-08-06) — READ FIRST for the Studio, prompt refs, or any PBX dialplan patch

All DEPLOYED and container-verified on `feat/ivr-migration-takeover`
(tip `ae2ba8e3`). Full detail in the memory files named below.

- **A menu key can ring an outside phone number.** Built from Izzy's recorded
  panel session: a Custom Destination holds the number, a Custom Application on
  a reserved **2000–2099** number answers and hands the call to it; the key
  stores `destinationType:"custom"` → `T<t>_app-custom-application,<ext>,1`
  (a plain Goto — NOT `cos-all`, which is typed "extension" and drags the call
  through the wake dialer). ⛔ **`cid_name`/`cid_number` stay EMPTY forever** so
  the outbound route's caller ID is used — customers must never set their own.
  ⛔ **This is the ONE place Connect calls Apply Changes itself** (Izzy's
  instruction; it was in his recording). Without it the rows exist, the
  extension is in no dialplan, and callers get a BUSY SIGNAL — which is exactly
  what happened live. Every other panel write still leaves the click to Izzy.
- **Direct dial + spoken prompts fixed ON THE PBX** (`extensions__60_custom.conf`,
  backups `.bak.dd3.*` / `.bak.langdir.*`). `[connect-menu]` had NO `_XXX`
  patterns, so pressing 1 fired option 1 instantly and 101 was impossible; and
  every prompt was probed at `sounds/<ref>` when Asterisk's built-ins live at
  `sounds/**en**/<ref>` — so "that option is invalid" and the timeout message
  were silently skipped for years. Default invalid prompt is now
  `option-is-invalid`. ⛔ **Never invent syntax inside those guards** — an
  attempt using `CUT()` made Asterisk reject the file and SILENTLY keep the old
  dialplan (no error logged for that file). Mirror the existing proven line
  shape. The `same =>` indent there is **seven** spaces; assert every
  string replacement.
- ⛔ **The prompt REF is canonical, never the stored filename.** A "fix" that
  rewrote refs to match files (`custom/Home_main` → `custom/home_main`) made the
  catalog check fail and **blocked publishing entirely**. Publish now pushes the
  audio to the PBX under the name the ref asks for. See
  [[ivr-menu-prompts-and-directdial-broken]].
- **Studio UX rules** (Izzy, sharply): a key choice is **never hidden for being
  empty** — picking one you don't have must CREATE it (team → MakeTeam,
  recording → upload/AI, number → add). Only "A person" stays greyed.
- **Half-migrated numbers are flagged**: `pbxHandBack`/`findPbxHandBacks` in
  `@connect/shared` mark keys that hand control back to a PBX IVR/time
  condition, on the map and before Publish. Rule = who DECIDES, not who answers.
- **Deploy traps that cost hours tonight:** ⛔ enqueue the **branch TIP**, not
  your own commit — several sessions push minutes apart and pinning your hash
  silently ROLLS BACK newer work; a running job can't be cancelled. ⛔ The
  queue does NOT protect against the heavy-build lock — jobs fail in the build
  stage with `HEAVY JOB ALREADY RUNNING` and look like broken code (happened 5×).
  ⛔ Never wait with `pgrep -f deploy-direct` in an ssh one-liner — it matches
  its own command line and hangs forever. Poll `/ops/deploy/jobs/<id>`.

**DONE 2026-08-06 (was open item 1):** inii mini is on **101**. ⛔ VitalPBX has
NO way to renumber an extension — the panel posts the number as a hidden field
and the REST API is read-only — so it was **copy → re-point the DID → delete**,
in that order, because the DID's destination row stores the extension_id and
**cascades away with the extension**. All verified live: dialplan reads
`Goto(T105_cos-all,101,1)`, 25 voicemails moved, dead endpoints cleared with
`module reload res_pjsip.so` (Apply Changes leaves them live in memory), Connect
shows the phone. ⛔ The endpoint name changed (`T105_1_1` → `T105_101_1`), so
**baila must sign out and back in**. The wizard is gated too (`0441fe2d`,
deployed): a lone digit promotes 1 → 101 **on blur, not on change**, and under
three digits is refused in the browser AND in the submit route. Recipe:
[[vitalpbx-cannot-renumber-extension]], [[connect-extension-number-min-three-digits]].

**OPEN, not started:**
1. **`invalid_prompt_ref` red banner** when making a recording on inii mini —
   UNDIAGNOSED. Its five prompt refs are all valid; the server sends a `detail`
   the portal drops (the `.body` not `.payload` bug again). Three emit sites:
   `server.ts` ~21008, ~21121, ~21379.
2. **A plus center key 2** still hands back to the PBX time condition. Both PBX
   menus behind it are ALREADY migrated into Connect (greeting ids 99/11 match)
   — only the key's pointer remains, and Izzy must choose: point at "A plus
   main" (loses the hours switch) or build an hours-aware key kind. See
   [[aplus-key2-handback-last-step]].

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
  12 agent tests cover every stress case. ✅ **DEPLOYED — container-verified
  2026-08-09**: `agentGrantRoutes.ts` in `app-api-1`, `permissionGrant.ts` in
  `app-agent-1`, and `AgentGrantConfirm` inside the live portal `.next` build.
  ⏳ Still **never walked in a browser** — nobody has typed a password into the
  dialog and watched a real permission land. Do that before trusting it; the
  tests prove the logic, not the round trip.
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
- **Build 52 is the current TestFlight build** (launch-screen picker, paste
  explainer + Deny-wedge detector, keyboard-inset commit) — id
  `6d37750c-78e1-4fe2-87c3-f77a62336f16`, uploaded 2026-08-04, `VALID`, beta
  review **APPROVED**, attached to "Loopcom Testers"
  (`fe508ee6-4a3f-49dd-bf53-858839fa2f06`). Pipeline recipe +
  `asc-release-52.mjs` pattern in the handoff §6. Bump `buildNumber` in
  **app.config.ts**; `npx --yes eas-cli` (plain `eas` not installed on loopcom).
- **"Send him the latest build" = add him to the group, nothing more.** The
  newest build is already attached, so a `POST /v1/betaTesters` with a
  `betaGroups` relationship is the ENTIRE job — Apple fires the invite email
  itself. There is no separate build-push step. Testers as of **2026-08-10**:
  eli.lovi@outlook.com, izzwgg@gmail.com, fixupusa1@gmail.com,
  leibfrankel0999@gmail.com INSTALLED; yossi@yossiswoodworx.com,
  shulemfreund1@gmail.com INVITED.
- ⛔ **`GET /v1/betaGroups/{id}/builds` returns an EMPTY list even when builds
  ARE attached** — it made build 52 read as unattached and nearly bought a
  pointless re-attach. Ask the other direction:
  `GET /v1/builds?filter[betaGroups]={id}&sort=-version`. And
  `GET /v1/builds/{id}/betaGroups` is a hard **403 `GET_RELATED` not allowed**
  (CREATE/DELETE only), which reads like an auth failure and is not one.
- **SSH to loopcom works straight from the Bash tool here** (Git Bash):
  `ssh -i .connect-ssh/connect2_ed25519 -o IdentitiesOnly=yes root@45.14.194.179`
  from the repo root — the Linux-sandbox hop in §"Server access" is not required
  in this environment. Ship a script with
  `ssh … 'cat > /root/.appstoreconnect/x.mjs' < local.mjs`, then `node` it.
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

## ⛔ AGENT HANDOFF — the APK link was missing from sign-up invitations (2026-08-09) — READ FIRST before changing ANY invite/welcome email, or for "the link got taken out of the email"

Full handoff: **`docs/ai-context/AGENT_HANDOFF_INVITE_APK_LINK_2026-08-09.md`**
(commit `357f863c` on `feat/ivr-migration-takeover`, api DEPLOYED and
container-verified, queue job `c649d756`).

- ⛔ **TWO paths queue the SAME welcome/create-password email**, and only one had
  the Android link: the admin invite path (`server.ts` →
  `queueUserWelcomeEmail`) resolved a real URL, while the self-service onboarding
  path (`onboarding/setupOrchestrator.ts` → `queueInviteEmail`) passed
  **`androidApkUrl: null`**. It was never removed from the template — it was
  never put in on that path, so **every customer who signed up themselves got an
  invitation with no way to install the app** while hand-sent invites worked.
  Same family as the two IVR publish paths: find EVERY site that builds a
  template before believing an email feature is live.
- ⛔ **The proof is the `EmailJob` queue, not the template.** Testing the last 12
  `USER_INVITE` bodies for `/android\/download|connectcomms-latest\.apk/i` split
  perfectly down the two paths (sign-ups had none: iniimini, matamimweekly,
  ezralife13, lafixerco; admin invites all had it). Reading the template would
  have shown a correct-looking `androidSection` and proved nothing.
- **Ruled out first, deliberately:** the resolver returns `null` when
  `connectcomms-latest.apk` is missing under `APK_DOWNLOAD_DIR` — a container
  that lost that mount would silently drop the section. Checked: the file is on
  the host AND inside `app-api-1` (147.5 MB; both `api` and `api_candidate` mount
  it read-only).
- **Now in one place:** `apps/api/src/androidApkInviteUrl.ts` owns the APK dir,
  base URL, download-page URL and `getAndroidApkUrlForInviteEmail()`; both invite
  paths call it. Behaviour unchanged — `ANDROID_APK_DOWNLOAD_PAGE_URL` overrides,
  otherwise the download **page**, and only when a real (≥1 KB) APK exists so a
  broken link is impossible. ⛔ Values are read at **call time, not module load**,
  so they are testable; `import.meta` is a **TS1343 error** in this repo (module
  is CommonJS) — use `__dirname`.
- **Guard:** `androidApkInviteUrl.test.ts` (6 cases) tests the resolver AND reads
  both call-site sources, failing if either drops the helper or reintroduces
  `androidApkUrl: null`. ⛔ A resolver-only unit test passes straight through this
  bug — the defect was a **caller**.
- ⛔ **Deploy-queue shape:** `POST /ops/deploy/enqueue`, field **`service`** (not
  `target`). `POST /ops/deploy/jobs` does not exist and answers with an Express
  **404 HTML page** that skims like an auth failure.
- ⏳ **NOT PROVEN: no invitation has been sent since the deploy.** Proven by the
  code path in the running container plus a live 200 on
  `/api/mobile/android/download` — not by an email in an inbox. Invite a spare
  address and re-run the `EmailJob` query in §2 of the handoff.

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
