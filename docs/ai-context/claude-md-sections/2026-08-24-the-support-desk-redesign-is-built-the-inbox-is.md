# ⛔⛔ AGENT HANDOFF — the support desk redesign is BUILT: the Inbox is gone at the SCHEMA, the agent has hands, and the IDE has a browser (2026-08-24) — READ FIRST before touching /admin/support, before adding ANY tool to the agent, before pointing a fetch at anything from apps/api, or before adding a class or a var to the support stylesheets

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_SUPPORT_CONSOLE_MOCKUPS_2026-08-20.md` §14**
(`f698d7c6`. ✅ **api + portal DEPLOYED and container-verified; agent REBUILT and
container-verified.** No migration, no PBX write, no env change, no tenant row.)
Built to <https://claude.ai/code/artifact/6f514701-4e37-4dea-a80f-2366ed600030>.

- ⛔⛔ **THE INBOX IS DELETED AT THE SCHEMA, NOT THE SCREEN.**
  `GET /admin/support/threads` now **REQUIRES `tenantId`**, so no request returns
  the platform — it used to browse 679 threads / 2,477 messages of every
  company's private conversations. **Hiding a browse surface in the UI leaves it
  one curl away.** ⛔ `caseRef` is optional and unvalidated ON PURPOSE: it is
  provenance for the audit row, not permission; making it mandatory tempts a
  caller to invent one, and a fabricated reason in an audit trail is worse than
  an honest blank. Every open writes `support.customer_threads_opened`.
- ⛔⛔ **THE AGENT'S WORKBENCH DOOR IS REGISTERED INSIDE
  `registerSupportConsoleRoutes`' CLOSURE, AND THAT IS THE DESIGN.**
  `POST /internal/agent/workbench` uses the SAME `decideCommandRun`,
  `currentRules()`, `watchmanNow()` and workspace root as the human routes. A
  module of its own = a second gate implementation, and the day those drift the
  agent runs under rules nobody wrote down. **Auth is the only difference**
  (shared secret, fail-closed) — and ⛔ the path is in
  `jwtPublicRouteBypass.ts`, without which the JWT hook 401s it before its own
  check runs (403 = you reached the handler, 401 = you did not).
  ⛔ **The agent cannot pass `confirmed`** — a person is accountable for a
  confirmation and the agent is not, so ask-first is a REFUSAL that sends it back
  to the human. Source-guarded.
- ✅ **Four staff-only tools** (`apps/agent/src/tools/workbenchTools.ts`):
  `read_file`, `list_files`, `run_command`, `browse`. ⛔ **`minRole: "staff"` on
  all four** — "internal" includes every TENANT_ADMIN since 2026-08-06, and this
  is a read of the platform source plus a command runner on the production box.
  ⛔ **No new dependency, no new key**: the agentic loop and both API keys
  already existed.
- ⛔⛔ **THE BROWSER READS A PAGE'S CONTENT, IT DOES NOT SEE ITS
  APPEARANCE — never describe it otherwise, a model will act on it.**
  `apps/api/src/supportBrowser.ts` returns status/timing/title/headings/text/
  links/forms; the PERSON gets pixels from a same-origin `<iframe>` (works only
  because nginx sends `X-Frame-Options: SAMEORIGIN`). **No screenshots**:
  `app-api-1` has no chromium (checked), and puppeteer is ~170 MB into an image
  every api deploy rebuilds. ✅ `clientRendered` turns the documented
  curl-and-grep `/login` trap into a fact the model is handed — proven live:
  200 / 5,288 bytes / 14 scripts / no title.
- ⛔⛔ **THE SSRF FENCE IS THE POINT OF THAT FILE** — `app-api-1` sits
  beside Postgres, Redis and the PBX credential. Host allowlist **derived from
  `PLATFORM_PORTAL_HOSTS`, never re-typed**; http/https only; **no credentials
  ever**; redirects followed BY HAND with **every hop re-validated** (the
  desk-phone validate-one-dial-another lesson). ⛔ **`api:3001` is deliberately
  ABSENT and must stay absent** — reaching the api's own origin from inside the
  network is a confused deputy; the PUBLIC hostname is fine because that path
  enforces JWTs and the nginx `/api/internal/` deny.
- ⛔ **Three documented traps hit AGAIN while building this** (§14d):
  a **`.sd-watch` class collision** that would have silently broken the Ground
  rules layout; **a whole CSS block written against an `--ide-*` namespace that
  does not exist**, so zero var() names resolved and it would have shipped an
  **invisible panel** reading exactly like a failed deploy (now a permanent test);
  and **a fake db that ignored the very where-clause under test**, which would
  have made the scoping test prove nothing.
- ✅ **Proven live on production, not by the deploy log:** no secret → 403,
  wrong secret → 403, real secret → lists the real repo, `169.254.169.254` →
  refused, `.env.platform` → `refused_secrets`; browse `/login` → 200 in 84 ms;
  `wc -l apps/api/…` → exit 0 (the exact shape the old "api" over-block refused).
  ⛔ The portal deploy log's last line read `done d39cad7f`, NOT this commit —
  the documented trap; `merge-base --is-ancestor` confirms it contains the work,
  and the bundle STRING grep is the authority (old Inbox string greps **0**).
- ⛔⛔ **"FOR PRIVACY, I CAN'T DO IT" WAS THE PROMPT, NOT THE PERMISSIONS
  (`38910aa9`, agent REBUILT + container-verified).** Izzy hit this in the
  Workbench within minutes. The tools and the tier were already correct —
  `toolRoleFor` had handed him the staff tools — but **ONE system prompt served
  every caller** and it said *"EVERYTHING ELSE … you cannot do it yet"* and
  *"never discuss other tenants or internal systems"*, so the model declined to
  look at the platform it held the keys to. ⛔ **A CAPABILITY THE PROMPT DENIES
  IS NOT A CAPABILITY, and no test of the tool layer can see it.** Fixed with
  `STAFF_SYSTEM_PROMPT` — ⛔ **a SEPARATE prompt, never a suffix** (building on
  the customer one inherits the refusals; guard-tested) — gated on
  **`isPlatformStaff(ctx.platformRole)`, the same check `toolRoleFor` uses**, so
  prompt and capability can never disagree again. ⛔ **Never gate this on the
  channel** — a client can claim any channel, nobody can forge a platform role.
  ⛔ **It relaxes nothing real**: the ground rules, allowlist, Watchman,
  secret-path refusal and read-only-ness are all CODE, which is why loosening
  the words was safe. Scope: SUPER_ADMIN is **exactly one account**.
  ⛔⛔ **DO NOT give the Workbench its own `channel`** — `store.ts` upper-cases
  it into the `AgentChannel` enum (`CHAT|EMAIL|WHATSAPP|SMS|PHONE`), so
  `"workbench"` makes the conversation create THROW and the dock stops answering
  entirely. Also fixed in passing: the Yiddish bridge was hardcoded onto the
  CUSTOMER prompt (a staff caller on the bridge got customer instructions), and
  the viewing block called the owner "the customer".
- ⏳ **NOT PROVEN: nobody has opened any of it in a browser.** Acceptance in
  §14f; the step that proves the engagement is asking the dock to READ A FILE.
  ⏳ Deliberately unbuilt: edits/diffs (every door is read-only; code ships only
  through the deploy queue), the Claude Agent SDK, and support-staff accounts +
  per-feature keys.
