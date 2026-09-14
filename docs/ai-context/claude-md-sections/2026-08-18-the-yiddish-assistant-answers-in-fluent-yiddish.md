# ⛔⛔ AGENT HANDOFF — the Yiddish assistant answers in fluent Yiddish and says NOTHING, because the Yiddish Labs account is OUT OF CREDITS (2026-08-18) — READ FIRST for any "the agent isn't picking up Yiddish" / "it's not using Yiddish Labs" report, before re-pasting the YL key, or before touching the translate bridge

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full detail: **`docs/ai-context/AGENT_HANDOFF_IVR_YIDDISH_2026-08-04.md`**
(appended 2026-08-18). **Read-only investigation — no code change, no deploy, no
PBX write, no data change, no credits spent.** Memory:
[[yiddish-labs-out-of-credits]].

- ✅✅ **RESOLVED 2026-08-18 — THE ACCOUNT WAS TOPPED UP AND YIDDISH WORKS.
  ⛔ Everything below about "-3 credits" is the OUTAGE HISTORY, not the live
  state; re-verify before acting on any of it.** The outage ran **2026-08-16
  17:34Z → 2026-08-18 ~03:5xZ**: last `402` at **03:33:27Z**, first successful
  translation at **03:53:57Z**, so credits arrived in that 20-minute window.
  ✅ **Proven by a real conversation, not by a probe:** Izzy dictated three
  Yiddish questions at 03:53–03:55Z (*"פארשטייסט אידיש?"*, then a question about
  headaches) and got three real answers, every turn audited **`bridged: true,
  degraded: false`** — i.e. Yiddish Labs did both legs and the canned fallback
  never fired. Confirmed still live at **11:50:46Z**. ⛔ **The key was never
  touched** — as predicted, it resumed on the next message with no restart, no
  rebuild and no deploy.
- ⛔⛔ **THE LESSON, and it cost this session a wrong report to Izzy: a recorded
  outage is a fact about the PAST.** This section still read "the account IS at
  -3" hours after it had been fixed, and I repeated it to him — including
  advising him what to check "before you top up", when he had already topped up
  and tested it himself the previous night. **Before repeating any outage from
  these notes, re-verify it live.** The cheapest check needs no credits and no
  API call: **`select max("createdAt") from "AgentTranslation"`** — a row exists
  only when Yiddish Labs really performed a translation, so a timestamp within
  the hour means it is working right now.
- ⛔⛔ **THE SYMPTOM IS DISGUISED, WHICH IS WHY IT READS AS "it ignored my
  Yiddish".** `finishBridged()` (`apps/agent/src/conversation/engine.ts:230`)
  catches the failure and returns `fallbackReply("yi")` — a **hard-coded**
  sentence: *"איך האָב אײַער מעסעדזש באַקומען און איבערגעגעבן צום טים"* ("I've
  received your message and passed it to the team"). So the customer gets
  **fluent Yiddish that answers nothing**. ✅ That degradation is CORRECT and
  must stay — it never passes model-written Yiddish off as YL's. The defect is
  that **nobody is told**.
- ✅ **Everything on our side was verified working, so do not go looking:**
  `AGENT_YIDDISH_BRIDGE=1` on `app-agent-1` (default ON; only `0` disables),
  `/agent/yiddishlabs/status` → `configured: true`, the stored key is 72 chars
  and **authenticates**, and the audit rows read `"language":"yi","bridged":true`
  — i.e. detection ran and the bridge really did call YL.
  ⛔ **A dead key answers 401; an empty wallet answers 402. DO NOT re-paste or
  rotate the key on this symptom** — same shape as the ElevenLabs trap: let the
  provider refuse, then read *which* refusal. ⛔ And do NOT set
  `AGENT_YIDDISH_BRIDGE=0` "until it's fixed" — that makes the model write
  Yiddish itself, the one thing Izzy has ruled out.
- ⛔ **The env var is a decoy.** `YIDDISHLABS_API_KEY` in the container is the
  34-char `(paste…)` placeholder; the real key is in the encrypted `AgentSecret`
  store. **Judge configuration from `/agent/yiddishlabs/status`, never `env`.**
- ⛔ **It can look INTERMITTENT, and that is the cache.** Every translation goes
  through `AgentTranslation` first, so a repeated phrase still answers, free.
  **`select max("createdAt") from "AgentTranslation"` is the single most useful
  query here — it is the last moment YL actually worked** (`2026-08-16T17:34:39Z`).
  The verbatim 402 **including the live balance** is in `AgentAuditLog` where
  `event = 'chat.bridge_out_failed'`.
- ⛔⛔ **THIS RETIRES A RECORDED-BUT-WRONG ROOT CAUSE.** The 2026-08-16 warm of
  the 176 queue-screen phrases (**26 translated, 150 failed**) was written up as
  "YL rejects most UI phrases for an unreadable reason — not rate limiting, not
  punctuation, not length". **It was insufficient credits, and the 26 successes
  were cache hits.** Checked each documented string against the cache, **7 for
  7**: every "success" (`Longest wait`, `Refresh`, `Most callers allowed to
  wait`) was already cached, every "failure" (`seconds`, `Advanced`, `Loading
  reports…`) was not. `/agent/ui/translate` is **cache-first**, so cached =
  free = "works" and uncached = 402. **THE LESSON: when a pass/fail pattern
  makes no sense and there is a CACHE in front of the call, you are measuring
  cache membership, not the property you are testing.**
- ✅ **Blast radius measured, not assumed.** Yiddish assistant chat: **dead**.
  UI phrase warming: **dead** (an untranslated phrase renders English — safe,
  just incomplete; the queue screens sit at 26 of 176). Nothing in calls,
  billing or routing touches YL.
- ⛔⛔ **VOICEMAIL STILL WORKS, BUT NOT BECAUSE YL IS OUT OF THAT PATH — IT IS
  FIRST IN IT AND FAILING SILENTLY ON EVERY VOICEMAIL.** `yiddishPass()`
  (`apps/agent/src/transcription/voicemailJob.ts`) tries **Yiddish Labs first**
  and falls back to **ivrit.ai** inside a bare `catch`. Since 2026-08-16 every
  Yiddish voicemail goes YL → 402 → swallowed → ivrit.ai. Healthy by
  measurement — **126 transcribed** vs 4 failures, and all 4 are `audio_empty`
  at the same rate as before (3.1% vs 3.5%), zero `both_stt_failed`.
  ⛔ **`transcriptEngine: "stt-yi"` NAMES THE LANGUAGE THAT WON, NOT THE
  PROVIDER** — YL and ivrit stamp the identical tag, so that column can never
  tell you which one ran. ⚠️ **The cost is that the redundancy is gone**: Yiddish
  voicemail is on ONE engine now, so an ivrit.ai outage today means no
  transcript at all (`both_stt_failed`), where a week ago YL covered it.
- ⚠️ **INFERENCE, NOT PROVEN — check the usage page before assuming a top-up
  lasts.** Audio costs far more than text (1 credit for a one-word probe, 15–21
  for a chat reply) and **~600 voicemails ran through YL in the nine days
  before it emptied**. The chat bridge is the visible casualty, not likely the
  big consumer. ⛔ Unprovable from our side — that bare `catch` logs nothing.
- ✅ **THE REAL DEFECT — THE OUTAGE WAS INVISIBLE — IS NOW FIXED: IZZY IS TEXTED
  WHEN YIDDISH LABS RUNS DRY.** `apps/api/src/yiddishLabsCreditWatch.ts`
  (`bcf18435` + `301a28b7`, **api DEPLOYED and container-verified `301a28b7fb95`**;
  no migration, no agent rebuild, no PBX write). It writes a **QUEUED
  `AgentEscalation`**, so it rides the delivery half that already works — SMS to
  **(562) 209-6644 + (845) 723-1213** and the `AGENT_ESCALATION` email.
  ⛔ **It must never become an `ADMIN_ALERT`** (muted platform-wide: it would
  build clean, log clean and reach nobody — the exact failure it exists to end),
  and it must never grow its own sender; a test asserts both.
- ⛔⛔ **THERE IS NO BALANCE ENDPOINT — probed read-only, `/credits` `/balance`
  `/account` `/usage` `/quota` `/status` and six more all 404.** The ONLY way to
  learn the balance is to be refused, so **no early "you're running low" warning
  is possible** — the alert fires on the first refusal, not before it. That is
  also why the watcher takes the cheapest signal first: a customer's failed
  Yiddish chat already in the audit trail (**free**, and it fires on the first
  real failure) → else a fresh `AgentTranslation` row proving the wire works
  (**free** — so an account in daily use costs nothing to monitor) → else a probe
  that costs **1 credit when healthy and nothing when empty**.
- ⛔ **Only a `402` texts him.** A dead key (401), a 500 or a timeout is recorded
  and never texted — a provider blip at 3am must not ring his phone, and
  "unreachable" is not "out of money". It is **edge-triggered with the state in
  `AgentAuditLog`**, never a module variable: it texts once on the crossing into
  out and re-arms only after a healthy check. ⛔ **It also checks 2 minutes after
  boot, not only hourly** — on a timer alone every deploy resets the clock, and on
  a 44-deploy day it would never run once while looking armed. A check recorded
  within the interval is skipped, so a run of deploys cannot probe every few
  minutes.
- ✅ **Its first live verdict was correct and cost nothing:** at 11:57:01Z it read
  the 11:50 translation row and recorded `state: ok, via: translation`.
- ⛔⛔ **“I NEVER GOT THE TEXT” — THE ALARM IS BLIND, AND IT WAS PROVEN ON THE
  NIGHT OF 2026-08-25/26. An earlier pass of this file recorded “the alarm is not
  at fault, it has never had anything to fire on.” THAT WAS WRONG.** The account
  ran dry through the evening of 08-25, Izzy paid at **12am ET = 04:00Z**, and
  **the watcher probed NINE times across the outage and answered `state:"ok"`
  every single time** (18:03, 19:59, 20:59, 21:59, 22:59, 23:59, 00:59, 02:16,
  03:54Z — the last one **6 minutes before the top-up**). He found out by reading
  transcripts, which is exactly what this file was built to stop.
- ⛔⛔ **ALL THREE DETECTION PATHS WERE BLIND AT ONCE — that is the finding.**
  **(1) The chat path** only greps `chat.bridge_out_failed`/`chat.bridge_in_failed`;
  nobody chatted in Yiddish, so silence. **(2) The voicemail path — THE ONE
  CARRYING ALL THE TRAFFIC — SWALLOWS THE REFUSAL.** `yiddishPass()`
  (`apps/agent/src/transcription/voicemailJob.ts:180`) wraps Yiddish Labs in a
  **bare `catch {}`** and falls through to ivrit; **26 voicemails were refused in
  that window and 1,145 audit rows were written, of which ZERO recorded the
  refusal.** ⛔ It also fails silently WITHOUT throwing when `r.status` is not
  `completed` — two silent exits, not one. **(3) The probe — the real killer.**
- ⛔⛔ **THE PROBE TESTS THE CHEAPEST ACTION IN THE CATALOGUE, SO IT GOES GREEN
  WHILE THE ACTUAL WORKLOAD IS BEING REFUSED.** `probeYiddishLabs` asks
  `/process/text` to translate the word `ok` — **1 credit** (verified live:
  `{"text":"...","credits_consumed":1}`). A voicemail goes to a **different
  endpoint** (`POST /transcriptions/sync`) and costs far more, and YL refuses
  **per-action**: *“requires N credits but you only have B available”*. So a
  balance too small for a transcription still affords the 1-credit probe. ⛔ The
  text endpoint DOES enforce credits (at **-3** even a 1-credit call was refused,
  2026-08-18), so the balance that night sat **above 1 and below one voicemail** —
  precisely the band the probe cannot see. ⚠️ Not directly measured: whether YL
  also runs **separate pools** for text vs audio. **Ask them — it changes nothing
  about the fix, only the explanation.**
- ⛔ **`transcriptEngine` CANNOT TELL YOU WHICH ENGINE RAN — re-proven here.** The
  re-transcribe Izzy ran is in the audit twice under **one voicemail id**
  (`cmt9kasfn00vsrz13qzpdh9a7`): **03:57:28Z, 1951 chars** (fallback) and
  **04:02:07Z, 1953 chars** (Yiddish Labs) — **same length, both stamped
  `stt-yi`**. Only the WORDS differ, so **quality is the only signal** and the DB
  keeps just the latest transcript. Measured across the boundary: before it,
  `פארטן` repeated **42 times** on a 1-second clip (270 chars/sec) and word salad
  like `עבדים איןשמונגען שטארקייט`; after it, clean orders with intact phone
  numbers. ⛔ **5 of the 26 came out as `stt-en` English** — with the Yiddish
  candidate degraded, `pickLanguage` picks the OpenAI English transcript, which is
  the “it switched to OpenAI and it is gibberish” Izzy reports.
- ✅ **The fallback IS configured, so do not chase it.** `ivrit_api_key` is in the
  **`AgentSecret` store** and the endpoint id defaults to `536xyqv8oyqygx`.
  ⛔ **An env check LIES here**: the code reads **`EVERETT_API_KEY` /
  `EVERETT_ENDPOINT_ID`** (DB-first), so grepping `IVRIT_*` shows empty and reads
  as “no fallback configured”. It is ivrit.ai (Yiddish-tuned Whisper on RunPod),
  not raw OpenAI — but it is markedly worse than YL, which is the whole point.
- ⛔⛔ **THE FIX, AND ITS ORDER MATTERS — REAL TRAFFIC BEATS ANY PROBE.** Gesheft
  alone puts **~50 Yiddish voicemails a day** through this path, so the failures
  are free, constant and truthful. **(a)** Stop swallowing in `yiddishPass` —
  record the refusal (best-effort, never able to break transcription) so a
  run-out is visible within **minutes** instead of never. **(b)** Widen the
  watcher’s free path to match `insufficient_credits` in **any** audit event, not
  two hardcoded chat names. **(c)** Stop reading a cheap probe as proof of health;
  once (a) lands the hourly probe can drop to a rare heartbeat, which also ends
  the **~22 credits/day** it burns. ⛔ (a) is in **apps/agent — a MANUAL container
  rebuild** (reset the server clone first); (b)/(c) ride the api deploy queue.
- ⚠️⚠️ **THE MONITOR IS STILL THE BIGGEST CONSUMER OF YIDDISH LABS CREDITS.**
  Across 170 checks the `via` split is **168 probe / 2 translation** — the free
  path almost never applies because chat usage is near zero (**38
  `AgentTranslation` rows in 14 days, 1 in the last 8**). At 1 credit a probe that
  is **~22/day**, against 15–21 for one assistant reply. **The thing built to warn
  about running out of credits is helping to run the account down** — and it was
  buying nothing, because it cannot see the failure that matters.
- ⛔ **THERE IS STILL NO LOW-BALANCE WARNING AND THERE CANNOT BE ONE.** Re-probed
  2026-08-26: `/credits` `/balance` `/account` `/usage` `/quota` `/me` `/user`
  `/status` `/subscription` `/billing` `/wallet` `/credits/balance`
  `/account/credits` — **all 13 answer 404**. The only way to learn the balance is
  to be refused, so the honest early warning is **the first refused REAL job**,
  which is exactly what fix (a) delivers.
- ⛔ The empty **`AGENT_ESCALATION_SMS_TO`** on the container is **NOT a fault** —
  the two numbers are a hardcoded default at `agentEscalationDispatch.ts:30`, and
  escalations texted fine on 08-24. **Delivery was never the problem; detection
  was.**
- ⏳ Still not done, and now much less urgent: `/agent/ui/translate`'s bare
  `catch { failed.push(s); }` still discards the HTTP status (needs a manual
  agent rebuild — ⛔ reset the server clone first).
