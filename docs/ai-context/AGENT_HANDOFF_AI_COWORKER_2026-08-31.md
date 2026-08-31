# ⛔⛔ AGENT HANDOFF — the AI Coworker: the deterministic policy core, the evidence-based diagnostic engine, and the floating bubble (2026-08-31)

**Commits:** `dbe922a3` (policy core) → `00699527` (diagnostics + bubble), on
`feat/ivr-migration-takeover`.

**Deploy state: NOTHING IS DEPLOYED.** No api deploy, no portal deploy, no agent
rebuild, no desktop publish, no migration, no PBX write, no env change, no
customer-visible change of any kind. The bubble defaults **OFF**.

**Scope of the mandate vs what exists:** Izzy's brief was a 45-phase "full computer
coworker" (MCP host, browser automation, isolated desktop, support job system,
packaging). What is built is **Phases 2, 3, 12, 13, 14–16, 25, 26, 27 and the
bubble** — the deterministic layer everything else must sit on, plus the diagnostic
engine. ⛔ The rest is **not started**; see §8. Do not read this doc as "the
coworker is built".

---

## 1. The one idea this rests on

⛔⛔ **THE MODEL IS NOT THE SECURITY BOUNDARY.** Every action carries declared,
deterministic metadata, and `decideToolCall()` judges from that metadata alone. It
never reads the model's reasoning, its confidence, or its prose.

This is not a new pattern here — it is the generalization of three gates this repo
already paid for:

| existing gate | what it does |
|---|---|
| `apps/desktop/src/phoneSetup/capability.ts` | fixed op allowlist, credentials by reference, local rate limits |
| `apps/api/src/supportWorkbench.ts` + `supportGroundRules.ts` | WATCHMAN → SHAPE+ALLOWLIST → SECRETS → RULEBOOK, `classifyAction` NEVER>ASK>ALLOWED |
| `apps/agent/src/tools/toolRegistry.ts` | `minRole` tiers, `FORBIDDEN_ARG_KEYS` tenant-key stripping |

⛔ **Do NOT add a fourth, differently-shaped gate beside them.** Extend
`packages/shared/src/coworker/`.

---

## 2. What is in `packages/shared/src/coworker/`

All pure: no network, no filesystem, no clock of its own, no database. That is what
makes it exhaustively testable — and it is exhaustively tested.

- **`types.ts`** — risk levels, tool categories, `validateToolSpec()`, permission
  profiles (SAFE/TRUSTED/AUTONOMOUS/CUSTOM), and `NEVER_AUTO_DOMAINS`.
- **`policy.ts`** — `decideToolCall()`. ⛔ **The order of its checks IS the safety
  property:** kill switch → spec validity → hard prohibitions → call protection →
  provenance → domain grants → risk floor → approval.
- **`trustBoundary.ts`** — provenance taint that propagates **downward only**,
  external-content framing, marker-forgery and bidi/control stripping.
- **`redaction.ts`** — ⛔ **structural (by key name) FIRST, patterns second.**
- **`paths.ts`** — Windows path fencing.
- **`resourceGuard.ts`** — concurrency ceilings, per-task budgets, repeated-action
  loop detection, rate limiting with recovery.
- **`taskState.ts`** — 11-state lifecycle; `decideCompletion()` is "no unverified
  success" as code.
- **`audit.ts`** — events that cannot carry a secret; redaction is not skippable.

### The rules inside that are easy to "simplify" and must not be

- ⛔ **`NEVER_AUTO_DOMAINS` can never resolve to `allow`** — not by profile, not by
  an explicit override. Seven domains: credentials, desktop.active,
  software.install, system.settings, network.config, windows.services,
  loopcom.admin. "Autonomous" means it stops interrupting you for routine work, NOT
  that it has the run of the machine.
- ⛔ **`CUSTOM` defaults every unset domain to `ask`, never `allow`.** Fail closed.
- ⛔ **Provenance is checked BEFORE grants**, so a domain the user set to `allow`
  cannot be exercised by a website that talked the model into it. An external-origin
  action that is destructive, HIGH risk, or exfiltration-capable is **denied even
  with an explicit approval** — an approval must not launder external authority.
- ⛔ **Call protection outranks everything.** While a call is up, nothing may touch
  audio/network/service/desktop settings, whatever the profile says (invariant #13).
- ⛔ **`HARD_PROHIBITIONS` cannot be approved away.** Disabling security products,
  opening remote-access listeners, and free-form support shell are refused outright.
- ⛔ **Redaction is structural first because a regex cannot recognise a password
  that looks like a word.** This repo's own SIP passwords, the AMI password and the
  robot panel password are all ordinary strings no pattern would flag. The
  `SAFE_KEY_EXACT` list is what keeps diagnostics useful (`tokenExpiresAt` and
  `hasPassword` are facts ABOUT a secret and survive).

---

## 3. The diagnostic engine (`coworker/diagnostics/`)

⛔⛔ **NEVER NAME A ROOT CAUSE WITHOUT THE MEASUREMENTS THAT SUPPORT IT.**

This exists because it already went wrong: an escalation report told a real customer
their internet was filtered and blamed their router's SIP ALG, while their line was
clean and a **different extension** was losing 37% of its packets. It reasoned from
call durations because it did not know `rtpStats` existed
(`AGENT_HANDOFF_TRIMPRO_105_AUDIO_2026-08-26.md`).

So:

- Every rule declares the signals it **requires**; without them it cannot fire.
- `diagnose()` returns **`inconclusive`** plus what to measure next, rather than a
  plausible story. Three routes there: too few measurements, no eligible rule, or
  nothing above the reportable bar.
- **Confidence is derived** from agreeing evidence; **contradicting evidence lowers
  it** rather than being dropped.
- ⛔ **`remediationsFor()` refuses to repair a guess** — nothing on an inconclusive
  diagnosis, and nothing below 70% confidence.
- ⛔ Every measurement field is optional, and `undefined` means *"we did not learn
  this"*, **never** *"this was fine"*.

Rules today: VPN interference · plain packet loss · filtered internet · not-registered
vs signed-out · audio device · TURN unreachable · system pressure · outdated client.

⛔ An available update is deliberately **low confidence (~40)** — it is rarely the
cause, and reporting it confidently sends people to install an update that changes
nothing.

---

## 4. The floating bubble (`apps/desktop/src/coworkerWidget/`)

Izzy's request, 2026-08-31: *"a small round widget that can be moved around and
placed anywhere on the computer. Every time I press it, chat opens up to the agent."*
He picked **option A (the Orb)** from the mockups.

- ⛔ **It opens the EXISTING `/assistant`, not a second chatbot.**
- ⛔ **`focusable` stays TRUE.** `focusable: false` is the obvious choice for a
  passive bubble and it **breaks `-webkit-app-region: drag` on Windows**, so the user
  could not move it. `showInactive()` is what keeps it from stealing focus.
- ⛔ **All geometry lives in `widgetGeometry.ts` (pure, tested)** — click-vs-drag
  (4px **radial**, so 4px right + 4px down is a drag), work-area clamping (so it can
  never hide under the taskbar), and re-validation of a saved position against the
  **current** displays.
- ⛔ **Off by default.** An update must not sprout a floating window on a customer.
  Tray → "Show Coworker Bubble".
- ⛔ Every entry point is wrapped: a fault in a decorative bubble must never threaten
  the phone.

---

## 5. Proven, not asserted

- **93/93** shared coworker tests · **119/119** desktop tests · both typechecks **0**.
- **12/12** policy-core mutations killed · **8/8** diagnostic mutations killed.
- ⛔⛔ **The first diagnostic mutation run had THREE SURVIVORS and they were real.**
  Two remediation guards and the confidence ceiling were **unreachable through
  `diagnose()`**, so deleting them changed nothing. Fixed by testing the contracts
  **directly** — `clampConfidence` is exported for exactly that reason — rather than
  by weakening the guards. **A green suite proves the tests ran, not that they guard
  anything.**

### Two bugs the tests caught during the build

1. **Lexical `..` resolution** let `C:/Users/bob/../../Windows/System32` normalize to
   a valid-looking absolute path, caught only by the separate scope check. Any `..`
   is now **refused outright**, so the property is "no traversal, ever" rather than
   "traversal is normalized and hopefully bounds-checked later".
2. `resolveStartPosition` leaked `width`/`height` into what is typed as a `Point`,
   which would have drifted the persisted settings shape.

---

## 6. Traps hit while building this

- ⛔ **The control-character trap bit again.** Writing a regex character class
  through the editor landed **real** control bytes (NUL, backspace, bidi) in
  `trustBoundary.ts`, which makes git treat the source as **binary — no diff, no
  review, ever**. Fixed by building the class from `\uXXXX` escape text. **Check
  `git show --stat` for `Bin` on any new source file**, and scan for control chars
  before committing.
- ⛔ **The shared index held another session's staged `CLAUDE.md`, `favicon.ico` and
  `portal-favicon-assets.py` at both commits.** `git commit -F - -- <paths>` is what
  kept them out. **Read `git diff --cached --name-only` as its own command first.**
- ⛔ **A new test does nothing until the runner names it.** `apps/desktop`'s `test`
  script lists globs explicitly; `src/coworkerWidget/*.test.ts` had to be added or
  the 19 bubble tests would never have run.

---

## 7. Deliberate deviations from the mandate

1. **No working branch**, though the mandate asked for one. Other sessions are live
   in this tree (4+ files dirty from them at the time). A `checkout` would have
   yanked the tree out from under them — CLAUDE.md forbids it. Committed by explicit
   pathspec instead.
2. **Policy core before everything else**, because Phases 4–20 are only as safe as
   that layer, and pure modules cannot touch the call path.
3. **UI paused for mockups** after Izzy's standing rule ("show me mockups before you
   build anything"). Mockups:
   <https://claude.ai/code/artifact/4f37d49b-0c9b-4bde-a990-a6063a1df0d6>

---

## 8. ⏳ NOT BUILT — the honest list

Nothing below exists. Do not report any of it as done.

- **Phase 4 MCP host** — no MCP client, no server registry, no OAuth, no UI.
- **Phase 5** — the provider abstraction is untouched; the agent's existing
  Claude/OpenAI router is unchanged.
- **Phases 6–9** — no filesystem, shell, Windows or browser tool **implementations**.
  The policy layer that would gate them exists; the hands do not.
- **Phases 10–11** — no isolated agent desktop, no active-desktop control.
- **Phases 17–20** — no support case integration, **no signed remote job system**, no
  self-repair executors. The diagnostic engine NAMES remediations
  (`repair_loopcom_firewall_rule`, `match_audio_device`, …) and **nothing executes
  them**.
- **Phases 21–23** — no Coworker UI, no task list, no approval UI. Mockups only.
- **Phase 29** — no worker process or Windows service; nothing runs a task yet.
- **Phases 42–45** — no packaging changes, no installer testing, no release candidate.

### What is unproven even in what IS built

⏳ **Nobody has seen the bubble on a screen.** It compiles, its geometry is tested,
and the asset ships — but no human has watched it appear, dragged it, or clicked it.
**The acceptance test is: enable it from the tray, drag it to another monitor,
restart the app, confirm it comes back in the same place and one click opens the
assistant.** The riskiest unknown is whether `-webkit-app-region: drag` behaves as
expected on Izzy's actual Windows build.

⏳ **No diagnostic has run against a real machine.** Every scenario is a fixture.
The engine is proven as decision logic; the **collectors do not exist**.

---

## 9. Open decisions for Izzy

1. ✅ **Bubble shape — answered: option A (Orb).**
2. ⏳ **On by default, or opt-in?** Currently **opt-in** (off; tray menu enables it).
3. ⏳ **Click opens** the compact 400×580 panel (current) **or** the full window on
   `/assistant`?
4. ⏳ **The approval and permissions screens** — mockups only; those two decide
   whether anyone trusts this.

---

## 10. ⛔ CLAUDE.md section still owed

CLAUDE.md could not be updated: at the time of both commits another session had it
**staged with a 57-line deletion**, and editing it would have swept their in-flight
work into this commit. **A summary section for this work still needs adding to
CLAUDE.md once the tree is quiet** — this doc is the source for it.
