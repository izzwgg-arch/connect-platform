# LoopCom support tickets — MCP server

Brings LoopCom support escalations into a Claude Code session, so the Claude that
already knows this system (CLAUDE.md, the handoffs, the memory dir, SSH, the repo)
can work a ticket directly.

**Status: v1, READ-ONLY.** It reads tickets, the customer behind them, and the
chat they came out of. It writes nothing, and in particular it never messages a
customer — per Izzy's design the OpenAI agent inside LoopCom keeps the customer
relationship and does the talking. Adding a write path here is a separate,
deliberate decision.

Plan and rationale: `docs/ai-context/PLAN_SUPPORT_TICKET_AGENT_2026-08-27.md`.

## Setup

```bash
cd tools/loopcom-support-mcp
npm install
```

Then register it with Claude Code (`claude mcp add`, or in `.mcp.json`):

```json
{
  "mcpServers": {
    "loopcom-support": {
      "command": "node",
      "args": ["C:/dev/projects/Connect 2/tools/loopcom-support-mcp/server.mjs"],
      "env": {
        "LOOPCOM_TOKEN": "<a SUPER_ADMIN portal token>",
        "LOOPCOM_API_BASE": "https://app.loopcom.net/api"
      }
    }
  }
}
```

⛔ `LOOPCOM_TOKEN` is a **SUPER_ADMIN** token and portal tokens currently never
expire (see CLAUDE.md, the token-expiry section). Treat it like a password: it is
on your machine, it is not in git, and it should be rotated by signing out if it
ever leaks.

## Tools

| Tool | What it does |
|---|---|
| `list_support_tickets` | Recent escalations, newest first — reference, company, person, the ask |
| `get_support_ticket` | One ticket in full: report, proposed fix, customer context. Takes a reference (`Q2FJRK`) or an id |
| `get_customer` | The account behind a ticket — numbers, extensions, billing, recent calls |
| `get_conversation` | The chat the ticket came out of, i.e. what the customer actually said |

## Why this exists rather than an agent inside LoopCom

LoopCom's own agent knows far less than a session in this repo does — measured
2026-08-27: **46 knowledge docs (16 hand-written), 0 KB articles, 0 memories**,
against CLAUDE.md's 1.2 MB plus 172 handoffs plus 282 memory files. Until the
internal one is genuinely stocked, the work is better done here.

⛔ The cost of that choice: this only runs while your computer is on. The plan
doc (§22, §26–§28) covers moving it to loopcom or a Managed Agents self-hosted
sandbox when that stops being acceptable — the server itself does not change.

## Registered state (2026-08-27)

Already registered in Izzy's Claude Code at `--scope local` (user config, not
committed), pointing at `https://app.loopcom.net/api`, with a **30-day**
SUPER_ADMIN token that expires **2026-09-26**.

⛔⛔ **`claude mcp add` FROM GIT BASH REGISTERS UNDER THE WRONG PROJECT KEY.**
`~/.claude.json` keys projects by the cwd string, and Git Bash reports
`C:/dev/projects/Connect 2` (forward slashes) while Claude Code itself uses
`C:\dev\projects\Connect 2`. The CLI then reports **✔ Connected** — because it
is reading the same forward-slash key it just wrote — while the real session
would find nothing at its own key on the next restart. It is registered under
**both** spellings now. **After any `claude mcp add`, check which key it landed
under before believing the health line.**

To re-mint the token when it expires (it is minted on the server, so the value
never touches a shell history or a transcript):

```bash
# on loopcom, inside app-api-1, from /app/packages/db  ⛔ NOT /app/apps/api —
# @prisma/client does not resolve there
node -e '<sign an HS256 JWT with JWT_SECRET for the SUPER_ADMIN user>'
```

Then `claude mcp remove loopcom-support` and add it again with the new value in
a shell variable, never inline.
