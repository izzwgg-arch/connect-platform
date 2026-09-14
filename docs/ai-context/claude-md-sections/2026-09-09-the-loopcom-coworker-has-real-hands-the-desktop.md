# ⛔⛔ AGENT HANDOFF — the Loopcom Coworker HAS REAL HANDS: the desktop links to the agent, the model calls `computer_*`/`mcp_*` tools that RUN on the person's Windows PC, and every call is judged + approved LOCALLY (2026-09-09, `bab5323d`) — READ FIRST before touching `apps/agent/src/coworker/`, `apps/desktop/src/coworker/`, the engine's `DynamicToolsProvider`, or before adding any computer capability

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_COWORKER_HANDS_2026-09-09.md`**. This replaces the card-era three-task
`coworker_task` as the way the Coworker acts on a computer (that tool stays, but is not offered while the hands are on).

- **Shape:** the Windows app (`hands.ts`) links to the agent over `/agent-api/coworker/*` (hello / long-poll `next` /
  `result` / `progress` / `cancel`, keyed by the verified `tenantId:userId`) and announces a manifest of 31 built-in
  tools + any connected MCP tools. `ConversationEngine` takes a per-turn `DynamicToolsProvider` that offers them as
  `computer_*` / `mcp_*` when the chat comes from the app (branded UA) or the bubble, and awaits each call's result
  INSIDE the turn (up to 10 min; an approval extends it). Every call is decided on the desktop by a COPY of the shared
  policy core (`apps/desktop/src/coworker/policyCore.ts`, drift-guarded), shown as an approval window when the verdict
  is `ask`, executed in `runtime/` (fs fence, PowerShell denylist, Windows CIM, hidden own-partition browser, xlsx,
  diagnostics, MCP host), and journaled.
- ⛔ **THE DESKTOP DECIDES, NEVER THE SERVER.** Every message from the wire is untrusted input. A compromised agent
  can only ASK; the NEVER_AUTO floor, the hard prohibitions and the shell denylist are not settings. A "No"/denied/
  cancelled is final for that call — the prompt forbids routing around it.
- ⛔ **Keep `policyCore.ts` identical to `packages/shared/src/coworker/*`** (the test reads the shared files); tool
  names must match `^[a-z][a-z0-9_]{0,63}$`; never let the poll loop spin or leave a timer armed.
- ⛔⛔ **"I asked the Coworker to use the browser and it said it can't" (Izzy, 2026-09-10 15:08 ET) = HIS WORKSTATION
  STILL RUNS rc.9, WHICH HAS NO HANDS.** Read-only diagnosis, nothing changed. The turn came from IP 50.48.58.53 with UA
  `Loopcom/0.1.17-rc.9` on the Landau Home login (izzwgg@gmail.com); the reply was "I don't have web-browsing from this
  chat". rc.9 was built from `7f73086a` (09-03): its `apps/desktop/src/coworker/` holds only the card-era
  `executor/tasks/mainWiring` — no `link.ts`, no `hands.ts`, no `computer_browser_*`. It never POSTs
  `/agent-api/coworker/hello` (**0 ever from his IP**; the only linked box today is Ezra's dev box on rc.10), so
  `dynamicTools` returns `empty` and the model has no browser tool. ✅ **The feed was FLIPPED to rc.10 at 11:25Z the same
  day on his word** (see the Install-link section below), so his rc.9 updates itself on its next check (at app start,
  then every 3 h; it downloads in the background and offers "Restart now"); installing by hand from the portal Install
  link (`/desktop/Connect-Setup-latest.exe`, rc.10) is the faster route. Then sign in with the bubble on and wait for
  the tray to read `Coworker hands: connected`. **Triage recipe for any "the Coworker can't do X on my
  computer":** grep nginx for that person's IP on `agent-api/coworker/hello` — zero hits means the app is pre-rc.10 or
  not linked, and no server change can help.
- **Deploy state:** agent `app-agent-1` at `bab5323d` (`/agent-api/coworker/*`, `proxy_read_timeout 900s`); portal
  `48511a49` (permissions view: SAFE/TRUSTED/AUTONOMOUS + Settings & Connections); desktop `0.1.17-rc.10` installed on
  the dev box (built from a clean export — see the rc.10 section below), feed still 0.1.16. Proven end to end on this
  machine (`Loopcom-Coworker-Proof-2026-09-09T1751`): the agent runs an ordinary "Create a folder on my Desktop…" and
  the folder appears; base acceptance 45/45 dev + 44/45 packaged; browser/download/xlsx/PowerShell/diagnostics/MCP,
  injection defense, secret redaction, both providers, cancel, loop protection all PASS.
