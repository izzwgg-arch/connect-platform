# ⛔⛔ AGENT HANDOFF — Gesheft ticket Y7FK8P "the phone isn't ringing and voicemails don't come up" (2026-09-02): the app is rung and never answers, voicemail is healthy, and MAILBOX 101 IS ONE DAY FROM THE 9,999 WALL — READ FIRST for ANY Gesheft "no voicemail" report, before believing a healthy voicemail pipeline means voicemail works, or before touching mailbox 101

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(**Read-only investigation — no code, no deploy, no PBX write, no data change.** The one write:
the technical report was handed back through `POST /admin/support/escalations/Y7FK8P/agent-report`
→ OpenAI rewrite → safety gate **`ready`** (SupportUpdate row 17:18:19Z), so a plain-English
update is queued on her widget. Report on disk:
`tools/loopcom-support-mcp/reports/Y7FK8P-1788370500000.md`. ⛔ The watcher's own run for this
ticket died at 56 s — `exit 1`, the Claude session limit — and posted nothing; the 65-byte
`Y7FK8P-1788368664432.md` is that failure, not a report.) Memory:
[[gesheft-101-mailbox-nearly-full]] (re-measured). Same person as Q2FJRK (08-24) and QP7APH
(08-27): ext 101 "Phone Orders", `yisraelweinstock@gmail.com`.

- ✅✅ **THE CLIFF IS RESOLVED — TRIMMED 2026-09-03 UNDER IZZY'S EXPLICIT MANDATE ("leave four
  weeks and delete everything else"), six slots from the wall (9,993/9,999 at execution).**
  A fleet-wide sweep confirmed 101 was the ONLY overloaded mailbox on the whole PBX (next
  largest: Gesheft 102 at 2,789, then 652). **9,068 messages older than 28 days were MOVED —
  not unlinked — to `/root/gesheft101-vm-trim-20260903T123910Z/` on the PBX** (6.5 GB, 18,136
  files); 926 recent messages kept, renumbered contiguously from msg0000, `voicemail reload`
  run, Asterisk reads **959** (926 INBOX + ~33 Urgent). `vm-mailboxfull` = 0 all time, so
  nothing was ever lost. ⛔ **Consequences to expect:** old Connect `Voicemail` rows whose
  spool file moved will read `voicemail_audio_gone` on play (Connect holds local audio for
  most recent ones); restore = move files back from the backup dir and renumber. ⛔ The Urgent
  folder (~33) and Gesheft 102 (2,789, 28% of cap) were deliberately NOT touched — not
  overloaded. At ~30–60 msgs/day the mailbox refills the 9,999 cap in ~5 months; re-trim then
  or decide a standing rotation (Izzy's call).
- ✅ **"The phone isn't ringing" — it IS rung, for 10–15 s per call, and the Windows app answers
  none of it.** Today to 17:10Z: 49 calls into `T8_Q750`, ext 101 dialled on each, desk phone
  `T8_101` answered 13, colleagues the rest. App endpoint `T8_101_1` (4 windows on the 443 route,
  all Avail, RTT ~230 ms): **286 "is ringing" legs today, 359 yesterday, 0 answered both days**
  (desk answered 37 yesterday). Traces: app + desk ring at 12:51:34, desk answers 12:51:45.
  Whether the window shows/sounds the ring is invisible from the server (documented gap). She
  still runs TWO shells at once (`@connect/desktop/0.1.3` 8,087 requests + `Loopcom/0.1.16`
  13,867) and the softphone rebuilt its stack 8× today. The portal `answer_unacked` rescue is
  still unbuilt (`grep -rn answer_unacked apps/portal` = 0).
- ✅ **"Voicemails don't come up" — recording, ingest and email are all healthy.** 39 voicemails
  on 101 in 24 h; the newest landed **17:06:52Z, two minutes AFTER the ticket**, in Connect 84 s
  later; her window fetches the list (200, 100 rows) every few seconds; since the 15:53Z cutover
  **5 of 5 emailable voicemails SENT to orders@gesheftkosher.com** (one 0-s hang-up correctly
  `too_short`). ONE helper spool-scan timeout at 15:54:01Z (`upserted_count 0`), self-healed on
  the next sync — do not read it as the cause. Unknown and unaskable from the server: whether she
  means the list, the desktop toast, or the email.
- ⛔ **Ruled out, so nobody re-derives it:** the VoIP.ms outage (trunk `344022_gesheft` never
  lost registration; inbound ran 21–42/10 min straight through 15:40–16:10Z); a ban (office IP
  38.105.207.69 absent from the denylist, 0 × 401/429 — its 4,866 × 403 are the
  `/crm/notifications` + `/desk-phones/pending` background polls); DND (`CustomDevstate/DND_101
  = UNAVAILABLE` = off); the dial string (intact, wake-dial shape).
- ⛔⛔ **SHE HAS FILED THIS THREE TIMES AND NEVER BEEN ANSWERED: `SupportUpdate` held ZERO rows
  for any Gesheft ticket until this one.** Q2FJRK and QP7APH were investigated (handoffs exist)
  and nothing ever reached her widget. This report is the first.
- ⛔ **Posting a report by hand:** `postAgentReport` in `tools/loopcom-support-mcp/loopcom.mjs`
  takes `{token, base}`; the token lives in `~/.claude.json` under the project's
  `mcpServers["loopcom-support"].env`. Run the script FROM that folder with a relative import —
  a `C:/…` absolute path in an ESM import throws `ERR_UNSUPPORTED_ESM_URL_SCHEME` on Windows.
- ⏳ **NOT PROVEN:** she has not read the update (`deliveredAt` null); the OpenAI rewrite dropped
  the "one window, current version" advice and the voicemail reassurance from the technical
  report — a human should say those on the open text thread with 845-248-6206; and the
  mailbox-101 decision is untaken.
