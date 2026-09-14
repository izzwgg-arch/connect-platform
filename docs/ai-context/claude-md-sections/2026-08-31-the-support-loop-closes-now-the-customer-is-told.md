# ⛔⛔ AGENT HANDOFF — the support loop CLOSES now: the customer is told in plain English, tests it, and answers (2026-08-31) — READ FIRST before touching `apps/api/src/support/`, before letting anything write a customer-facing message, before adding an escalation creator, or for "a ticket was investigated and the customer heard nothing"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(`4530eb3f` on `feat/ivr-migration-takeover`, building on `97112a90`. **api +
portal deploy state at the end of this section; migration
`20260831160000_support_update` creates ONE new table and alters nothing
existing, so no current customer is touched.**)
Izzy, 2026-08-31: *"the agent gives the report back to Loopcom, and then OpenAI
should take the report and regenerate it in plain English. No technical talk, no
secrets, no potential backhand stuff … tell them to test it … down by the widget,
there is a message."*

- ✅ **THE LOOP, END TO END:** customer reports → agent investigates (the section
  below) → **watcher posts the report back** (`postAgentReport` →
  `POST /admin/support/escalations/:reference/agent-report`) → **OpenAI rewrites
  it in plain English** → **the safety gate decides** → the assistant widget
  shows a **badge**; they open it, test it, and press **"Yes, it's working"** or
  **"No, still not right"**.
- ⛔⛔ **CLAUDE STILL NEVER SPEAKS TO THE CUSTOMER, and that is the whole
  architecture.** It hands back a TECHNICAL report; the customer-facing voice
  stays OpenAI's (plan doc §13–§19). ⛔ `technicalReport` is OURS and must never
  reach a customer surface — it names other tenants, file paths and internal
  systems **by construction**. The customer routes select their fields
  explicitly and a test fails if that projection ever grows.
- ⛔⛔ **THE GATE REFUSES, IT DOES NOT REDACT** (`support/customerUpdateSafety.ts`,
  pure). A message with a secret cut out of it is one we **already know was
  wrong**, sent on the hope the cutting was complete. A held message waits for a
  person: nothing is lost, and nothing wrong goes out. It refuses **secrets**,
  **internal detail**, **admissions of fault** ("our bug", "broken for three
  weeks", "other customers", anything about credit or liability) and — the worst
  leak — **any mention of another company on the platform**.
- ⛔⛔ **AND IT MUST NOT REFUSE EVERYTHING.** A gate that never passes is not safe,
  it is a loop that silently never closes and Izzy hears about it from a
  customer. **The customer's own vocabulary — voicemail, extension, calls, texting,
  the app — is deliberately NEVER treated as jargon**, and a test group exists
  purely to pin that honest messages still pass.
- ⛔⛔ **THE FINDING THAT MATTERS MOST: THE FIRST VERSION OF THE GATE PASSED A REAL
  AGENT REPORT COMPLETELY CLEAN.** Fed one of the watcher's actual reports it
  returned `ok: true` with **zero** issues — it had matched none of "app-portal-1",
  ".build-commit = 34989820", "22:50:25Z", "ext 102", or "across 21 tenants".
  Seven patterns were added and it now catches that same report on **seven**
  counts. ⛔ **A gate is only ever as good as the text somebody has fed it —
  invented examples agree with the rules you just wrote.** Feed it real output.
  (Same pass: **"for two months" slipped through** because durations were matched
  as `\d+` only and people write them in words.)
- ⛔⛔ **AND THE WORST THING IT DID WAS NOT A LEAK — IT TOLD A CUSTOMER WE HAD
  FIXED SOMETHING WE HAD NOT.** Caught on the FIRST real ticket through the live
  loop (`T6HMUQ`, Connect Communications). The agent's report opened
  *"Investigated and reported only. Nothing was changed on Connect, the PBX, or
  the customer's account."* — and the rewrite said **"We've made some
  adjustments, and it should now be correctly hidden."** It was already sitting
  in that customer's queue. ⛔ **The investigating agent CANNOT change anything,
  so in this pipeline a claim of a change is ALWAYS false**; it is refused in the
  GATE (`unearned_fix`), not merely discouraged in the prompt, because a prompt
  is a request and a gate is a promise. `changeWasMade` (default **false**) is
  the flag that lets a real fix say so, the day one rides this loop.
  ⛔ **Two of the suite's own fixtures were themselves examples of the bug** —
  the "good message" said *"We've made a change"* and the vocabulary list said
  *"We've turned texting on"*. Both report a FINDING now; **do not fix them
  back.** ⛔ **The general lesson: a rewrite layer will describe the outcome the
  READER wants, not the one the source states.** Anywhere a model summarises
  work for the person who asked for it, check that it cannot claim the work
  succeeded.
  ⚠️ **TWO messages carrying that false claim really did reach a customer queue
  before the gate landed — both on Connect Communications (Izzy's own tenant),
  so no outside customer was misled.** `UXN2E6` was re-run through the corrected
  gate and now reads honestly; **`T6HMUQ` had already been READ AND ANSWERED by
  a person, so it was left as the record of what happened** — it is `answered`,
  which the customer route does not serve, so it is no longer visible. ⛔ Deleting
  the evidence of a mistake is worse than the mistake.
  ⛔ **The reprocess recipe, if this is ever needed again:** set the row back to
  `status: "draft"` and re-POST its stored `technicalReport` to
  `/admin/support/escalations/:ref/agent-report`. **A `delivered` or `answered`
  row is deliberately refused** by `recordAgentReport` — never rewrite something
  a customer has already been shown — so the reset is the explicit, deliberate
  step that allows it.
- ⛔ **THREE ROUNDS OF LIVE RUNS EACH BEAT THE TEST SUITE**, which is the pattern
  worth carrying: the gate passed a real agent report clean (round 1); it then
  let *"a similar issue affecting multiple accounts"* through because the rule
  matched only the past tense, and *"the issue has been addressed"* because the
  banned-verb list covered the centre of the neighbourhood and not its edges
  (round 3 — **a model reaches for a softer synonym the moment the obvious verb
  is refused**). Final live result: **10 adversarial reports, 0 leaks, 8 ready /
  2 correctly held.**
- ⛔ **EVERY FAILURE ENDS IN `held`, NEVER IN A MESSAGE GOING OUT:** no OpenAI key,
  a model error, an empty rewrite, or any objection from the gate. A **platform
  alarm never becomes a customer message** (checked twice — at triage and again
  at the point of writing, because this one is irreversible), and a re-post
  **never rewrites something already delivered**.
- ⛔⛔ **`OPENAI_API_KEY` IN THE API CONTAINER IS LITERALLY `(paste…` — the
  documented decoy trap, verified 2026-08-31 (28 chars).** The real key lives
  encrypted in **`AgentSecret` key `openai_api_key`**, written from the owner's
  Assistant settings page. `resolveOpenAiKey` reads the STORE first, env second,
  and refuses anything placeholder-shaped. ⛔ **`emailTemplateAi.ts` and
  `leadIntelligenceService.ts` read the env value directly and are therefore
  very likely broken in production** — noticed, NOT fixed, Izzy's call.
- ⛔ **The post-back is an `/admin` route, NOT an `/internal` one.** The watcher
  already holds a SUPER_ADMIN token — it is how it reads tickets at all — so an
  internal door would have meant putting the platform's machine-to-machine
  secret on a laptop to buy nothing. Same authority, one credential. (The JWT
  bypass entry was added and then **reverted** when the door moved; it is not
  needed and must not come back.)
- ⛔ **The widget polls every TWO MINUTES, gated on the auth token.** The
  voicemail-flood lesson: a widget poll runs on every page for every customer
  forever, and a signed-out tab polling an authenticated route is how an office
  auto-bans itself at nginx. This is a note that arrives once a week at most.
- ✅ **64 tests (`apps/api`, `src/support/customerUpdate.test.ts`), PROVEN
  NON-VACUOUS BY SEVEN MUTATIONS** — removing the cross-customer check (7 red),
  the secret scan (8), the blame scan (13), the internal scan (16), adding the
  technical report to the customer projection (1), removing the platform-alarm
  guard (1), and unscoping the verdict from its owner (1). Includes an
  exhaustive 90-combination poison sweep and 500 seeded fuzz messages.
  ⛔⛔ **`src/support/*.test.ts` WAS NOT IN apps/api's test list** — the
  documented unregistered-test trap. Registered; check the runner's file list
  before believing any test here protects anything.
- ⏳ **NOT PROVEN: no customer has seen one.** Acceptance is the next real ticket
  — the report should come back, a badge should appear on that person's widget,
  and their answer should land as a `verdict`. ⛔ **A held message is invisible
  to the customer by design**, so watch `SupportUpdate.status` — a queue of
  `held` rows means the gate is too tight and nobody is being told anything:
  `select status, count(*) from "SupportUpdate" group by 1;`
