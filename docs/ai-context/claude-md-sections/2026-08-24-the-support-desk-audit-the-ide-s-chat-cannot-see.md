# ⛔⛔ AGENT HANDOFF — the support desk AUDIT: the IDE's chat cannot see the IDE, and the Inbox reads 679 companies' private texts (2026-08-24) — READ FIRST before touching /admin/support, before answering "is the IDE the Claude Agent SDK?", or before reading a `workbench.command_refused` count as a blocked user

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full audit + mockups for every screen: **`docs/ai-context/AGENT_HANDOFF_SUPPORT_CONSOLE_MOCKUPS_2026-08-20.md` §13**
(**Read-only audit — no code, no deploy, no migration, no PBX interaction, no data change.**)
Artifact: <https://claude.ai/code/artifact/6f514701-4e37-4dea-a80f-2366ed600030>

- ⛔⛔ **THE SDK ANSWER, verified by grep 2026-08-24: `claude-agent-sdk` is in NEITHER
  the repo NOR any package — zero hits.** What exists is **`@anthropic-ai/sdk@^0.60.0`** in
  `apps/agent` (the plain HTTP client) plus our own hand-rolled `completeWithTools` loop.
  **The IDE is not the Agent SDK and it is not "cloud".**
- ⛔⛔ **AND THAT IS THE "some stuff is not working": THE WORKBENCH DOCK IS THE CUSTOMER
  CHATBOT.** `SupportWorkbench.tsx:322` posts to `/agent-api/chat/message`, and the agent's
  whole tool surface (`apps/agent/src/tools/`) is contacts / investigation / permissionGrant /
  portStatus / provisioning / read / selfService — **`read_file`, `list_files` and
  `run_command` grep to ZERO.** So it answers about a file it cannot read. ⛔ It is also an
  **editor that cannot edit**: all four workbench doors are read-only, while the chrome ships
  tabs, a minimap and a palette. **A tool that looks like it can do more than it can is how
  it teaches people to distrust it** — which is what 4 commands in 4 months means.
- ⛔⛔ **A REFUSAL COUNT MEANS NOTHING UNTIL YOU READ WHAT WAS REFUSED — I nearly
  filed this wrong.** `workbench.command_refused` reads **24** against 4 runs, which looks
  like the rulebook blocking real work. **18 of the 24 are the build day's own security
  probes** (`rm -rf /`, `bash -c whoami`, `cat …/.env.platform`, `git push`, `ls; whoami`,
  `docker restart`). ✅ The one real over-block (`wc -l apps/api/…` matching *"Passwords,
  card details or API keys"*) is **confirmed FIXED** — later rows run the same command
  `exit 0`. The honest reading is the other one: **no real maintenance has ever run through
  the Workbench.**
- **The usage ledger, read live 2026-08-24 — re-measure before quoting:** Escalations
  **7 cases** (all within 30 days, ≈2/week) · Inbox **679 threads / 2,477 messages** ·
  Assistant take-over **0 ever** (of 114 conversations) · Workbench **4 commands ever** ·
  Ground rules 2 versions. **Four of five tabs carry no traffic and the one real job sits
  behind a tab bar.**
- ⛔⛔ **IZZY WANTS THE INBOX GONE AND HE IS RIGHT ON THE MERITS, NOT ONLY ON TASTE**
  (*"I don't want to see everybody's text messages. I don't know why it's there"*).
  `GET /admin/support/threads` is **the one screen on the platform where one person reads 30
  companies' customer conversations with no case attached to the reading.** The fix is not a
  smaller list — **delete the browse surface, keep the reader inside the case**, name the
  case in the header, audit every open.
- **Proposed shape: five tabs → one desk + two settings.** Escalations IS the desk
  (cases / conversation / customer); take-over becomes a button in the composer; ground rules
  move to settings gaining a **try-a-sentence box** (would have caught the `api` over-block
  the day it was written) and an **over-blocking counter**; the Watchman becomes a status
  strip. ⛔ **Draw only what the box can do** — no git gutter (the api image copies
  source, so no `.git` and no `git` binary).
- **Build order given:** (1) delete the Inbox tab, (2) collapse the five tabs, (3) give the
  agent the three staff tools — **no new dependency, no new key** — then (4) decide on
  the Agent SDK, (5) support-staff accounts + per-feature keys. ⛔ **Under every option
  code still ships ONLY through the deploy queue.**
- ⏳ **NOTHING IS BUILT. Every screen is a mockup awaiting Izzy's pick.**
