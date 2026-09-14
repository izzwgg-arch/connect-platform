# B Visible engagement (2026-07-17 → 07-22) — where the handoff lives

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


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
