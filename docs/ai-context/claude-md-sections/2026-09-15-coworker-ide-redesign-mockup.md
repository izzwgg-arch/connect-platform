# Coworker IDE-style redesign — LIVE MOCKUP ONLY, nothing built (2026-09-15)

Izzy, 2026-09-15: the bubble should open a chat that looks like a real, active IDE (like ChatGPT/Claude), not
like the technical-support assistant. It shows what the Coworker is doing live ("using a tool", running steps),
but in plain English with no code. It needs a full page with all the settings, and live mockups before anything is built.

- **Artifact (v1):** https://claude.ai/artifact/9rkPBPFRp6hqQJcYCaSDXG. Source is in that session's scratchpad
  (`coworker-live-mockup.html`). Every file, email, call and amount in it is example data.
- **What it shows:** (1) **Bubble chat.** A Windows desktop with the round bubble. Clicking it opens a 400px chat with
  suggestion chips and a composer ("Asks before changes" chip, Send turns into Stop while it works). Every AI reply
  carries a live **steps block**: a spinner, a tool pill (Files / Browser / Spreadsheet / Phone system / Thinking),
  a plain-English label, a Working… or % or "2s" state, and an expandable detail. Approvals appear as an amber
  "Coworker needs your OK" card inside the chat. The bubble dot is amber while working and red when something
  finished or needs you while the chat is hidden. (2) **Full page** (opened from the expand button in the widget; it
  shares the same live conversation). Left rail: New task, search, task history, Tasks / Everything it did /
  Settings. Center: the conversation. Right: What it's doing (plan checklist), a Right now live-window preview,
  task stats, Made or changed, and Stop everything. **Settings:** three autonomy levels (ask before every change /
  only big things / just do it) plus an always-asks list (delete, pay, send, passwords, on a call); what it
  can use (Files, separate Loopcom browser, Spreadsheets, phone system, Email = drafts only); things it should
  always know; how it talks; bubble and 30-day history.
- Three scripted runs: organize Downloads (with approval + progress count), August invoices → spreadsheet
  (browser → sheet → save approval), missed calls this morning (looking only, no approval). Any other prompt runs
  a short generic sample. It works in light and dark (theme toggle in the header).
- **Supersedes** the 2026-09-15 Codex three-column preview recorded in `2026-09-14-browser-companion.md` as
  the design under review. That one showed a single fixed layout with no bubble widget and no settings page.
- ⛔ **Mapping to what exists, to check before any build:** the autonomy levels correspond to SAFE / TRUSTED /
  AUTONOMOUS (`DesktopSettings.coworkerPermissions`); the always-asks list must stay the NEVER_AUTO floor in the
  shared policy core, never a setting. The popover must keep `holdChatOpen` (it must not hide on blur while
  approval is pending), and approvals are currently a SEPARATE window beside the chat
  (`approvalWindow.ts`). The mockup draws them INSIDE the chat, which is a real design change and
  needs a security read, because the chat renderer is the hosted portal (a compromised server could draw a fake
  approval card). The steps block needs the agent to stream per-call progress to the page. Today progress
  goes desktop → agent only. Full page = a new portal route, so it needs its toggles (the fourth rule).
- ⏳ **NOT BUILT, NOT DEPLOYED.** Awaiting Izzy's feedback on the mockup.
